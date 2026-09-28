/**
 * reviewBlocks.js
 *
 * Structured "Opportunity Review" reply. After analyze_opportunity, the AI is forced to call
 * present_opportunity_review with its judgment (health, summary, risks, discovery gaps, next actions);
 * the layout and all KPI numbers come from code, so every review looks the same and numbers are exact.
 */

const { formatValue, recordUrl } = require('./recordBlocks');

const REVIEW_TOOL = {
  type: 'function',
  function: {
    name: 'present_opportunity_review',
    description:
      'Presents the opportunity assessment to the user as a formatted review card. ' +
      'Base every statement on the analyze_opportunity data; do not invent facts. Keep items short and specific.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['id', 'en'],
          description: 'Language of the user message: "id" for Indonesian, "en" for English. Write all text in it.',
        },
        health: {
          type: 'string',
          enum: ['on_track', 'needs_attention', 'at_risk'],
          description:
            'at_risk: close date passed/pushed repeatedly, or no activity 30+ days near close. ' +
            'needs_attention: some gaps (stale activity 14+ days, nothing scheduled, discovery not validated). ' +
            'on_track: recent activity, next step scheduled, discovery complete.',
        },
        summary: {
          type: 'string',
          description: 'One or two sentences: overall conclusion and the main reason. No numbers already shown as KPIs.',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: '1-4 short risk statements (max ~15 words each), most severe first.',
        },
        discovery_summary: {
          type: 'string',
          description: 'One sentence on what discovery tells us (objective, current tools, impact, timeline).',
        },
        discovery_gaps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Missing or weak discovery items to complete. Empty if none.',
        },
        next_actions: {
          type: 'array',
          minItems: 3,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Concrete action starting with a verb (max ~15 words).' },
              owner: { type: 'string', description: 'Who should do it, e.g. the opportunity owner name.' },
              due: { type: 'string', description: 'When, e.g. "Minggu ini", "Sebelum 15 Okt", "This week".' },
              due_date: { type: 'string', description: 'The same deadline as a date, YYYY-MM-DD (today or later).' },
            },
            required: ['action', 'owner', 'due', 'due_date'],
          },
          description: '3-5 next actions, most important first, each addressing a risk or gap.',
        },
      },
      required: ['language', 'health', 'summary', 'risks', 'discovery_summary', 'discovery_gaps', 'next_actions'],
    },
  },
};

const LABELS = {
  id: {
    title: 'Opportunity Review',
    health: { on_track: 'On Track', needs_attention: 'Perlu Perhatian', at_risk: 'Berisiko' },
    amount: 'Amount',
    closeDate: 'Close Date',
    stage: 'Stage',
    probability: 'Probability',
    lastActivity: 'Aktivitas Terakhir',
    discovery: 'Discovery',
    risks: 'Risiko Utama',
    discoveryGaps: 'Perlu dilengkapi',
    nextActions: 'Rekomendasi Next Action',
    open: 'Buka di Salesforce',
    edit: 'Edit Opportunity',
    createTask: '➕ Buat Task',
    owner: 'Owner',
    inDays: n => `${n} hari lagi`,
    today: 'hari ini',
    overdue: n => `lewat ${n} hari`,
    pushed: n => `mundur ${n}×`,
    inStage: n => `${n} hari di stage ini`,
    daysAgo: n => (n === 0 ? 'hari ini' : `${n} hari lalu`),
    none: 'Belum ada',
    filled: (a, b) => `${a}/${b} terisi`,
    validated: 'tervalidasi',
    notValidated: 'belum divalidasi',
    scheduled: n => `${n} terjadwal`,
    overdueTasks: n => `${n} task overdue`,
    generated: d => `Dibuat oleh Lori AI · data per ${d}`,
  },
  en: {
    title: 'Opportunity Review',
    health: { on_track: 'On Track', needs_attention: 'Needs Attention', at_risk: 'At Risk' },
    amount: 'Amount',
    closeDate: 'Close Date',
    stage: 'Stage',
    probability: 'Probability',
    lastActivity: 'Last Activity',
    discovery: 'Discovery',
    risks: 'Key Risks',
    discoveryGaps: 'To complete',
    nextActions: 'Recommended Next Actions',
    open: 'Open in Salesforce',
    edit: 'Edit Opportunity',
    createTask: '➕ Create Task',
    owner: 'Owner',
    inDays: n => `in ${n} days`,
    today: 'today',
    overdue: n => `${n} days overdue`,
    pushed: n => `pushed ${n}×`,
    inStage: n => `${n} days in stage`,
    daysAgo: n => (n === 0 ? 'today' : `${n} days ago`),
    none: 'None recorded',
    filled: (a, b) => `${a}/${b} filled`,
    validated: 'validated',
    notValidated: 'not validated',
    scheduled: n => `${n} scheduled`,
    overdueTasks: n => `${n} overdue task(s)`,
    generated: d => `Generated by Lori AI · data as of ${d}`,
  },
};

const HEALTH_ICON = { on_track: '🟢', needs_attention: '🟡', at_risk: '🔴' };

// Fields offered in the Edit modal from the review card
const REVIEW_EDIT_FIELDS = ['StageName', 'Amount', 'Probability', 'CloseDate', 'NextStep', 'Discovery_Check__c'];

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const kpi = (label, value, note) => ({
  type: 'mrkdwn',
  text: `*${label}*\n${value}${note ? `\n_${note}_` : ''}`,
});

/**
 * Splits discovery fields into text fields (filled or not) and checkbox fields (validated or not).
 */
function discoveryStatus(fields = {}) {
  const entries = Object.entries(fields);
  const text = entries.filter(([, v]) => typeof v !== 'boolean');
  const checks = entries.filter(([, v]) => typeof v === 'boolean');
  return {
    filled: text.filter(([, v]) => v !== null && v !== '').length,
    total: text.length,
    validated: checks.length > 0 ? checks.every(([, v]) => v) : null,
  };
}

/**
 * Builds the Opportunity Review message.
 *
 * @param {Object} review - Arguments of present_opportunity_review (AI judgment)
 * @param {Object} insights - Result of getOpportunityInsights (facts + signals)
 * @returns {{text: string, blocks: Object[]}}
 */
function buildOpportunityReviewBlocks(review, insights) {
  const L = LABELS[review.language] || LABELS.en;
  const { opportunity: opp, signals: s, discovery } = insights;
  const url = recordUrl('Opportunity', opp.Id);
  const health = HEALTH_ICON[review.health] ? review.health : 'needs_attention';

  // Close date note: overdue / days left + how often it moved
  const closeNotes = [];
  if (s.daysToClose !== null && !opp.IsClosed) {
    if (s.daysToClose < 0) closeNotes.push(`⚠️ ${L.overdue(-s.daysToClose)}`);
    else closeNotes.push(s.daysToClose === 0 ? L.today : L.inDays(s.daysToClose));
  }
  if (s.closeDatePushes > 0) closeNotes.push(L.pushed(s.closeDatePushes));

  const activityNotes = [];
  if (s.daysSinceLastActivity !== null) activityNotes.push(L.daysAgo(s.daysSinceLastActivity));
  if (s.upcomingActivities > 0) activityNotes.push(L.scheduled(s.upcomingActivities));
  if (s.overdueTasks > 0) activityNotes.push(`⚠️ ${L.overdueTasks(s.overdueTasks)}`);

  const disc = discoveryStatus(discovery?.fields);
  const discoveryValue = disc.total > 0 ? L.filled(disc.filled, disc.total) : L.none;
  const discoveryNote =
    disc.validated === null ? null : disc.validated ? `✅ ${L.validated}` : `⚠️ ${L.notValidated}`;

  const subtitle = [opp.Account?.Name, opp.Owner?.Name && `${L.owner}: ${opp.Owner.Name}`].filter(Boolean).map(esc);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${L.title}`, emoji: true } },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*<${url}|${esc(opp.Name)}>*\n${subtitle.join('  ·  ')}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${HEALTH_ICON[health]} *${L.health[health]}*\n${esc(review.summary)}` },
    },
    {
      type: 'section',
      fields: [
        kpi(L.amount, formatValue(opp.Amount, 'currency', opp.CurrencyIsoCode)),
        kpi(L.closeDate, formatValue(opp.CloseDate, 'date'), closeNotes.join(' · ')),
        kpi(
          L.stage,
          esc(opp.StageName || '—'),
          s.daysInCurrentStage !== null ? L.inStage(s.daysInCurrentStage) : null
        ),
        kpi(L.probability, formatValue(opp.Probability, 'percent')),
        kpi(L.lastActivity, s.lastActivityDate ? formatValue(s.lastActivityDate, 'date') : L.none, activityNotes.join(' · ')),
        kpi(L.discovery, discoveryValue, discoveryNote),
      ],
    },
    { type: 'divider' },
  ];

  if (review.risks?.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*⚠️ ${L.risks}*\n${review.risks.map(r => `• ${esc(r)}`).join('\n')}` },
    });
  }

  const discoveryLines = [`*🔍 ${L.discovery}*`, esc(review.discovery_summary)];
  if (review.discovery_gaps?.length) {
    discoveryLines.push(`_${L.discoveryGaps}:_ ${review.discovery_gaps.map(esc).join(', ')}`);
  }
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: discoveryLines.join('\n') } }, { type: 'divider' });

  // Each next action is its own section so it can carry a one-click "Create Task" button
  const actions = (review.next_actions || []).slice(0, 5);
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*✅ ${L.nextActions}*` } });
  actions.forEach((a, i) => {
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(a.due_date || '') ? a.due_date : null;
    blocks.push({
      type: 'section',
      block_id: `next_action_${i}`,
      text: { type: 'mrkdwn', text: `*${i + 1}. ${esc(a.action)}*\n👤 ${esc(a.owner)}   📅 ${esc(a.due)}` },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: L.createTask, emoji: true },
        action_id: 'sf_create_task',
        value: JSON.stringify({
          o: opp.Id,
          ow: opp.OwnerId,
          s: String(a.action).slice(0, 255),
          d: dueDate,
          l: review.language,
        }).slice(0, 2000),
      },
    });
  });

  blocks.push(
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: L.open }, url, action_id: 'sf_open_record' },
        {
          type: 'button',
          text: { type: 'plain_text', text: `✏️ ${L.edit}`, emoji: true },
          action_id: 'sf_edit_record',
          value: JSON.stringify({ o: 'Opportunity', id: opp.Id, f: REVIEW_EDIT_FIELDS }),
        },
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: L.generated(formatValue(s.today, 'date')) }] }
  );

  const text = `${HEALTH_ICON[health]} ${L.health[health]} — ${opp.Name}: ${review.summary}`;
  return { text, blocks };
}

module.exports = { REVIEW_TOOL, buildOpportunityReviewBlocks };
