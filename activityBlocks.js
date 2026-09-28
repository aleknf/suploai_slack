/**
 * activityBlocks.js
 *
 * Cards for Tasks created from Slack:
 *   - "Activity logged" card after log_activity (Open in Salesforce + Undo)
 *   - status line appended to an Opportunity Review next action after "➕ Create Task"
 */

const { formatValue, recordUrl } = require('./recordBlocks');

const TYPE_ICON = { call: '📞', meeting: '🤝', email: '✉️', other: '📝' };

const LABELS = {
  id: {
    logged: 'Aktivitas dicatat',
    type: { call: 'Call', meeting: 'Meeting', email: 'Email', other: 'Catatan' },
    open: 'Buka di Salesforce',
    undo: '↩️ Batalkan',
    taskCreated: (user, url) => `✅ Task dibuat oleh <@${user}> · <${url}|lihat>`,
  },
  en: {
    logged: 'Activity logged',
    type: { call: 'Call', meeting: 'Meeting', email: 'Email', other: 'Note' },
    open: 'Open in Salesforce',
    undo: '↩️ Undo',
    taskCreated: (user, url) => `✅ Task created by <@${user}> · <${url}|view>`,
  },
};

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Card shown after an activity was logged from chat.
 *
 * @param {Object} activity - Entry pushed by log_activity into ctx.loggedActivities
 * @returns {Object[]} Blocks
 */
function buildLoggedActivityBlocks(activity) {
  const L = LABELS[activity.language] || LABELS.id;
  const { related } = activity;
  const meta = [
    `${TYPE_ICON[activity.activityType] || '📝'} ${L.type[activity.activityType] || L.type.other}`,
    `📅 ${formatValue(activity.activityDate, 'date')}`,
    activity.ownerName && `👤 ${esc(activity.ownerName)}`,
  ].filter(Boolean);

  const lines = [
    `✅ *${L.logged}* — *<${recordUrl(related.objectName, related.id)}|${esc(related.name)}>* _(${esc(related.objectLabel)})_`,
    `*${esc(activity.subject)}*`,
    meta.join('   '),
  ];
  if (activity.description) lines.push(`>${esc(truncate(activity.description, 600)).replace(/\n/g, '\n>')}`);

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: L.open },
          url: recordUrl('Task', activity.taskId),
          action_id: 'sf_open_record',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: L.undo, emoji: true },
          action_id: 'sf_undo_task',
          value: JSON.stringify({ id: activity.taskId, u: activity.requesterId, l: activity.language }),
        },
      ],
    },
  ];
}

module.exports = { buildLoggedActivityBlocks, ACTIVITY_LABELS: LABELS };
