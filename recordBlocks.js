/**
 * recordBlocks.js
 *
 * Renders Salesforce data as Slack Block Kit:
 *   - record cards (field labels from describe, formatted values, link to Salesforce, Edit button)
 *   - edit confirmation cards (before → after, Save/Cancel buttons)
 *   - the Edit modal and parsing of its submission
 */

const { sfUrl, getDescribe, htmlToText } = require('./salesforce');

const MAX_CARDS = 15;
const MAX_CARD_FIELDS = 10;
const MAX_MODAL_FIELDS = 20;
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Jakarta';
const DEFAULT_CURRENCY = process.env.SF_CURRENCY || 'IDR';

// Noise fields hidden on cards when a record has more fields than fit
const SYSTEM_FIELDS = new Set([
  'IsDeleted',
  'CreatedById',
  'LastModifiedById',
  'SystemModstamp',
  'LastViewedDate',
  'LastReferencedDate',
  'LastActivityDate',
  'MasterRecordId',
  'PhotoUrl',
  'Jigsaw',
  'JigsawCompanyId',
  'CleanStatus',
]);

// Title fields in order of preference
const TITLE_FIELDS = ['Name', 'CaseNumber', 'Subject', 'Title'];

const EDITABLE_TYPES = new Set([
  'string',
  'textarea',
  'phone',
  'email',
  'url',
  'double',
  'currency',
  'percent',
  'int',
  'picklist',
  'multipicklist',
  'boolean',
  'date',
  'datetime',
]);

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Slack mrkdwn needs &, <, > escaped in user-supplied text
const escapeMrkdwn = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const recordUrl = (objectName, id) => `${sfUrl}/lightning/r/${objectName}/${id}/view`;

async function safeDescribe(objectName) {
  if (!objectName || objectName === 'AggregateResult') return null;
  try {
    return await getDescribe(objectName);
  } catch (_) {
    return null;
  }
}

function fieldMetaMap(describe) {
  return new Map((describe?.fields || []).map(f => [f.name, f]));
}

/**
 * Flattens a record into ordered [path, value] pairs: relationship objects become "Account.Name",
 * child subqueries are summarized as a record count.
 */
function flattenRecord(record, prefix = '') {
  const pairs = [];
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && Array.isArray(value.records)) {
      pairs.push([path, `${value.totalSize ?? value.records.length} record(s)`]);
    } else if (value && typeof value === 'object') {
      pairs.push(...flattenRecord(value, path));
    } else {
      pairs.push([path, value]);
    }
  }
  return pairs;
}

function fieldLabel(path, metaMap) {
  const parts = path.split('.');
  if (parts.length === 1) return metaMap.get(path)?.label || path;

  // "Account.Name" → label of the lookup field whose relationshipName is "Account", minus " ID"
  const relField = [...metaMap.values()].find(f => f.relationshipName === parts[0]);
  const relLabel = relField ? relField.label.replace(/\s+ID$/i, '') : parts[0];
  const leaf = parts[parts.length - 1];
  return leaf === 'Name' ? relLabel : `${relLabel} ${leaf}`;
}

/**
 * Formats a raw Salesforce value for display based on its describe type.
 *
 * @param {*} value - Raw value from the REST API
 * @param {string} [type] - Describe field type (currency, date, boolean, ...)
 * @param {string} [currency] - ISO currency code for currency fields
 * @returns {string} Slack mrkdwn
 */
function formatValue(value, type, currency = DEFAULT_CURRENCY) {
  if (value === null || value === undefined || value === '') return '—';

  switch (type) {
    case 'boolean':
      return value ? '✅ Yes' : '❌ No';
    case 'currency':
      return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
    case 'double':
    case 'int':
      return new Intl.NumberFormat('id-ID').format(value);
    case 'percent':
      return `${value}%`;
    case 'date':
      return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
    case 'datetime':
      return new Date(normalizeSfDateTime(value)).toLocaleString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: DISPLAY_TZ,
      });
    case 'email':
      return `<mailto:${value}|${escapeMrkdwn(value)}>`;
    case 'url':
      return /^https?:\/\//.test(value) ? `<${value}|${escapeMrkdwn(truncate(value, 60))}>` : escapeMrkdwn(value);
    case 'multipicklist':
      return escapeMrkdwn(String(value).split(';').join(', '));
    default:
      return escapeMrkdwn(truncate(String(htmlToText(value)), 250));
  }
}

// Salesforce datetimes look like "2026-03-12T10:00:00.000+0000" — add the colon JS expects in the offset
function normalizeSfDateTime(value) {
  return String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function recordTitle(record) {
  if (record.CaseNumber && record.Subject) return `${record.CaseNumber} · ${record.Subject}`;
  for (const f of TITLE_FIELDS) if (record[f]) return String(record[f]);
  return record.Id || 'Record';
}

/**
 * Builds one record card: a section with a linked title, up to 10 field columns and an Edit button.
 */
function buildRecordCard(record, describe) {
  const objectName = record.attributes?.type;
  const metaMap = fieldMetaMap(describe);
  const currency = record.CurrencyIsoCode || DEFAULT_CURRENCY;
  const title = escapeMrkdwn(truncate(recordTitle(record), 150));
  const titleText = record.Id && objectName ? `*<${recordUrl(objectName, record.Id)}|${title}>*` : `*${title}*`;

  const titleKeys = new Set(['Id', ...TITLE_FIELDS.filter(f => record[f] !== undefined).slice(0, 2)]);
  let pairs = flattenRecord(record).filter(([path]) => !titleKeys.has(path) && !path.endsWith('.Id'));

  // Too many fields (e.g. full record fetch): drop empty and system fields first
  if (pairs.length > MAX_CARD_FIELDS) {
    pairs = pairs.filter(([path, value]) => value !== null && value !== '' && !SYSTEM_FIELDS.has(path));
  }
  pairs = pairs.slice(0, MAX_CARD_FIELDS);

  const section = {
    type: 'section',
    text: { type: 'mrkdwn', text: `${titleText}\n_${escapeMrkdwn(describe?.label || objectName || 'Result')}_` },
  };

  if (pairs.length > 0) {
    section.fields = pairs.map(([path, value]) => {
      const meta = metaMap.get(path);
      return {
        type: 'mrkdwn',
        text: truncate(`*${escapeMrkdwn(fieldLabel(path, metaMap))}*\n${formatValue(value, meta?.type, currency)}`, 1990),
      };
    });
  }

  if (describe?.updateable && record.Id) {
    const editFields = pairs.map(([path]) => path).filter(path => !path.includes('.'));
    section.accessory = {
      type: 'button',
      text: { type: 'plain_text', text: '✏️ Edit', emoji: true },
      action_id: 'sf_edit_record',
      value: truncate(JSON.stringify({ o: objectName, id: record.Id, f: editFields }), 2000),
    };
  }

  return section;
}

/**
 * Renders a list of Salesforce records as Block Kit cards.
 *
 * @param {Object[]} records - Records as returned by the REST API (each has attributes.type)
 * @param {Object} [options]
 * @param {number} [options.totalSize] - Total matches, to show "Showing X of Y"
 * @param {number} [options.maxBlocks=50] - Block budget available for the cards
 * @returns {Promise<Object[]>} Blocks
 */
async function buildRecordBlocks(records, { totalSize, maxBlocks = 50 } = {}) {
  if (!records?.length) return [];

  const types = [...new Set(records.map(r => r.attributes?.type))];
  const describes = new Map(await Promise.all(types.map(async t => [t, await safeDescribe(t)])));

  // Each card uses 2 blocks (section + divider); reserve 2 for the header/footer context
  const shown = records.slice(0, Math.min(MAX_CARDS, Math.floor((maxBlocks - 2) / 2)));
  const total = Math.max(totalSize || 0, records.length);

  const objectLabel =
    types.length === 1 && describes.get(types[0])
      ? describes.get(types[0])[total === 1 ? 'label' : 'labelPlural']
      : 'records';

  const blocks = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: `📋 *${total}* ${escapeMrkdwn(objectLabel)} found` }] },
  ];
  for (const record of shown) {
    blocks.push(buildRecordCard(record, describes.get(record.attributes?.type)), { type: 'divider' });
  }
  if (total > shown.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Showing ${shown.length} of ${total}. Ask Lori to narrow the filter to see others.` }],
    });
  }
  return blocks;
}

/**
 * Human-readable "Label: old → new" lines for an edit.
 */
function describeChanges(changes, current, describe) {
  const metaMap = fieldMetaMap(describe);
  return Object.entries(changes).map(([field, value]) => {
    const meta = metaMap.get(field);
    const label = escapeMrkdwn(meta?.label || field);
    const before = formatValue(current?.[field], meta?.type);
    const after = formatValue(value, meta?.type);
    return `*${label}*\n${before} → *${after}*`;
  });
}

/**
 * Builds the confirmation card for an AI-proposed edit.
 *
 * @param {Object} edit - { objectName, recordId, changes, current }
 * @param {string} requesterId - Slack user who asked for the edit; only they may confirm
 * @returns {Promise<Object[]>} Blocks
 */
async function buildEditConfirmBlocks({ objectName, recordId, changes, current }, requesterId) {
  const describe = await safeDescribe(objectName);
  const title = escapeMrkdwn(truncate(recordTitle(current || {}), 150));
  const value = JSON.stringify({ o: objectName, id: recordId, c: changes, u: requesterId });

  if (value.length > 2000) {
    return [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ This edit is too large to confirm from Slack.' } }];
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✏️ *Confirm update* — *<${recordUrl(objectName, recordId)}|${title}>* _(${escapeMrkdwn(describe?.label || objectName)})_`,
      },
      fields: describeChanges(changes, current, describe).slice(0, 10).map(text => ({ type: 'mrkdwn', text })),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Save' },
          style: 'primary',
          action_id: 'sf_confirm_edit',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          action_id: 'sf_cancel_edit',
          value,
        },
      ],
    },
  ];
}

function buildInputElement(meta, value) {
  const has = value !== null && value !== undefined && value !== '';

  switch (meta.type) {
    case 'picklist':
    case 'multipicklist': {
      const options = meta.picklistValues
        .filter(v => v.active)
        .slice(0, 100)
        .map(v => ({ text: { type: 'plain_text', text: truncate(v.label || v.value, 75) }, value: v.value }));
      if (options.length === 0) return null;
      if (meta.type === 'picklist') {
        const initial = options.find(o => o.value === value);
        return { type: 'static_select', options, ...(initial ? { initial_option: initial } : {}) };
      }
      const selected = has ? String(value).split(';') : [];
      const initial = options.filter(o => selected.includes(o.value));
      return { type: 'multi_static_select', options, ...(initial.length ? { initial_options: initial } : {}) };
    }
    case 'boolean': {
      const option = { text: { type: 'plain_text', text: 'Yes' }, value: 'true' };
      return { type: 'checkboxes', options: [option], ...(value ? { initial_options: [option] } : {}) };
    }
    case 'date':
      return { type: 'datepicker', ...(has ? { initial_date: String(value).slice(0, 10) } : {}) };
    case 'datetime':
      return {
        type: 'datetimepicker',
        ...(has ? { initial_date_time: Math.floor(new Date(normalizeSfDateTime(value)).getTime() / 1000) } : {}),
      };
    case 'double':
    case 'currency':
    case 'percent':
    case 'int':
      return {
        type: 'number_input',
        is_decimal_allowed: meta.type !== 'int',
        ...(has ? { initial_value: String(value) } : {}),
      };
    default:
      return {
        type: 'plain_text_input',
        multiline: meta.type === 'textarea',
        ...(has ? { initial_value: truncate(String(value), 3000) } : {}),
      };
  }
}

/**
 * Picks which fields the Edit modal shows: the fields visible on the card when they are editable,
 * otherwise the first editable fields of the object.
 */
function pickEditableFields(describe, requested = []) {
  const editable = describe.fields.filter(
    f => f.updateable && EDITABLE_TYPES.has(f.type) && !f.calculated && !f.autoNumber
  );
  const byName = new Map(editable.map(f => [f.name, f]));
  const fromCard = requested.map(name => byName.get(name)).filter(Boolean);
  return (fromCard.length > 0 ? fromCard : editable).slice(0, MAX_MODAL_FIELDS);
}

/**
 * Builds the Edit modal for a record.
 *
 * @param {Object} params
 * @param {Object} params.describe - Raw describe of the object
 * @param {Object} params.record - Current record values
 * @param {Object[]} params.fields - Describe metas of the fields to show (from pickEditableFields)
 * @param {Object} params.privateMetadata - Carried to the submission handler
 * @returns {Object} Modal view
 */
function buildEditModal({ describe, record, fields, privateMetadata }) {
  const blocks = [
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${recordUrl(describe.name, record.Id)}|${escapeMrkdwn(truncate(recordTitle(record), 150))}> · Only changed fields are saved.`,
        },
      ],
    },
  ];

  for (const meta of fields) {
    const element = buildInputElement(meta, record[meta.name]);
    if (!element) continue;
    blocks.push({
      type: 'input',
      block_id: `f:${meta.name}`,
      optional: true,
      label: { type: 'plain_text', text: truncate(meta.label, 2000) },
      element: { ...element, action_id: 'v' },
    });
  }

  return {
    type: 'modal',
    callback_id: 'sf_edit_modal',
    title: { type: 'plain_text', text: truncate(`Edit ${describe.label}`, 24) },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    private_metadata: JSON.stringify(privateMetadata),
    blocks,
  };
}

/**
 * A simple modal used while record data loads (views.open must happen within 3s of the click).
 */
function buildLoadingModal(text = 'Loading record…') {
  return {
    type: 'modal',
    callback_id: 'sf_edit_loading',
    title: { type: 'plain_text', text: 'Edit record' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
  };
}

function readInputValue(meta, input) {
  switch (input.type) {
    case 'static_select':
      return input.selected_option?.value ?? null;
    case 'multi_static_select':
      return (input.selected_options || []).map(o => o.value).join(';') || null;
    case 'checkboxes':
      return (input.selected_options || []).length > 0;
    case 'datepicker':
      return input.selected_date || null;
    case 'datetimepicker':
      return input.selected_date_time ? new Date(input.selected_date_time * 1000).toISOString() : null;
    case 'number_input':
      return input.value === null || input.value === undefined || input.value === '' ? null : Number(input.value);
    default:
      return input.value === null || input.value === undefined || input.value === '' ? null : input.value;
  }
}

function comparable(value, type) {
  if (value === null || value === undefined || value === '') return null;
  if (type === 'datetime') return new Date(normalizeSfDateTime(value)).getTime();
  if (['double', 'currency', 'percent', 'int'].includes(type)) return Number(value);
  if (type === 'boolean') return Boolean(value);
  return String(value);
}

/**
 * Extracts only the changed fields from an Edit modal submission.
 *
 * @param {Object} stateValues - view.state.values from the submission
 * @param {Object} describe - Raw describe of the object
 * @param {Object} current - Current record values (re-fetched at submit time)
 * @returns {Object} Map of field API name → new value
 */
function parseEditSubmission(stateValues, describe, current) {
  const metaMap = fieldMetaMap(describe);
  const changes = {};
  for (const [blockId, actions] of Object.entries(stateValues)) {
    if (!blockId.startsWith('f:')) continue;
    const field = blockId.slice(2);
    const meta = metaMap.get(field);
    if (!meta) continue;
    const next = readInputValue(meta, actions.v);
    // Unchecked boolean vs null boolean are the same "false" state
    const before = meta.type === 'boolean' ? Boolean(current[field]) : current[field];
    if (comparable(next, meta.type) !== comparable(before, meta.type)) changes[field] = next;
  }
  return changes;
}

/**
 * Splits long mrkdwn text into section blocks (Slack caps section text at 3000 chars).
 */
function textToBlocks(text) {
  if (!text) return [];
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > 2900) {
      if (current) chunks.push(current);
      current = truncate(line, 2900);
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.map(chunk => ({ type: 'section', text: { type: 'mrkdwn', text: chunk } }));
}

module.exports = {
  buildRecordBlocks,
  buildEditConfirmBlocks,
  buildEditModal,
  buildLoadingModal,
  pickEditableFields,
  parseEditSubmission,
  describeChanges,
  recordTitle,
  recordUrl,
  textToBlocks,
  safeDescribe,
};
