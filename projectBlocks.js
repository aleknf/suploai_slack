/**
 * projectBlocks.js
 *
 * Structured "Project Status" reply for Slack project channels (canvas + task List, not linked to Salesforce).
 * After get_project_status, the AI is forced to call present_project_status with its judgment (health, summary,
 * risks, next actions); the layout, the progress bar and every number come from code.
 */

const { formatValue } = require('./recordBlocks');

const PROJECT_REVIEW_TOOL = {
  type: 'function',
  function: {
    name: 'present_project_status',
    description:
      'Presents the status of a Slack project to the user as a formatted card. Base every statement on the ' +
      'get_project_status data (canvas + task List); do not invent facts. Keep items short and specific.',
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
            'at_risk: many overdue tasks, the deadline in the canvas is at risk, or key work is blocked. ' +
            'needs_attention: some overdue/unassigned tasks or unclear ownership. on_track: progress matches the plan.',
        },
        summary: {
          type: 'string',
          description: 'One or two sentences: overall conclusion and the main reason. Do not repeat the KPI numbers.',
        },
        about: {
          type: 'string',
          description: 'One sentence on what the project is (goal/scope/timeline), taken from the canvas. Empty if the canvas has none.',
        },
        risks: {
          type: 'array',
          items: { type: 'string' },
          description: '0-4 short risks (max ~15 words each), from the canvas (risk section, deadlines) and the task signals.',
        },
        next_actions: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', description: 'Concrete action starting with a verb (max ~15 words).' },
              owner: { type: 'string', description: 'Who should do it (a task owner from the data, or "Project lead").' },
              due: { type: 'string', description: 'When, e.g. "Hari ini", "Sebelum 25 Okt", "This week".' },
            },
            required: ['action', 'owner', 'due'],
          },
          description: '2-5 next actions, most important first, each addressing a risk or an overdue/unassigned task.',
        },
      },
      required: ['language', 'health', 'summary', 'about', 'risks', 'next_actions'],
    },
  },
};

const LABELS = {
  id: {
    title: 'Status Project',
    kind: 'Project Slack',
    health: { on_track: 'On Track', needs_attention: 'Perlu Perhatian', at_risk: 'Berisiko' },
    progress: (done, total) => `${done} dari ${total} tugas selesai`,
    done: 'Selesai',
    doing: 'Sedang berjalan',
    todo: 'Belum mulai',
    overdue: 'Terlambat',
    soon: 'Jatuh tempo ≤7 hari',
    unassigned: 'Tanpa PIC',
    blocked: 'Terhambat',
    blockedLabel: 'terhambat',
    about: 'Tentang project',
    risks: 'Risiko Utama',
    attention: 'Perlu perhatian',
    late: n => `terlambat ${n} hari`,
    dueSoonLabel: 'segera jatuh tempo',
    noOwner: 'tanpa PIC',
    nextActions: 'Rekomendasi Next Action',
    openCanvas: 'Buka canvas',
    openList: 'Buka List',
    noList: 'Channel ini tidak punya List tugas, jadi progres tidak bisa dihitung.',
    source: (n, capped) => `Sumber: canvas dan List channel · ${n} tugas dibaca${capped ? ' (dibatasi 500 baris)' : ''}`,
    more: n => `+${n} lainnya`,
  },
  en: {
    title: 'Project Status',
    kind: 'Slack project',
    health: { on_track: 'On Track', needs_attention: 'Needs Attention', at_risk: 'At Risk' },
    progress: (done, total) => `${done} of ${total} tasks done`,
    done: 'Done',
    doing: 'In progress',
    todo: 'Not started',
    overdue: 'Overdue',
    soon: 'Due in ≤7 days',
    unassigned: 'Unassigned',
    blocked: 'Blocked',
    blockedLabel: 'blocked',
    about: 'About the project',
    risks: 'Key Risks',
    attention: 'Needs attention',
    late: n => `${n} days overdue`,
    dueSoonLabel: 'due soon',
    noOwner: 'no owner',
    nextActions: 'Recommended Next Actions',
    openCanvas: 'Open canvas',
    openList: 'Open List',
    noList: 'This channel has no task List, so progress cannot be calculated.',
    source: (n, capped) => `Source: channel canvas and List · ${n} tasks read${capped ? ' (capped at 500 rows)' : ''}`,
    more: n => `+${n} more`,
  },
};

const HEALTH_ICON = { on_track: '🟢', needs_attention: '🟡', at_risk: '🔴' };

const esc = text => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kpi = (label, value) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` });

function progressBar(pct) {
  const filled = Math.round(pct / 10);
  return `${'▰'.repeat(filled)}${'▱'.repeat(10 - filled)}`;
}

function attentionLine(task, L, kind) {
  const when =
    kind === 'overdue'
      ? `⚠️ ${L.late(task.daysLate)}`
      : kind === 'blocked'
        ? `🚧 ${L.blockedLabel}`
        : `${formatValue(task.due, 'date')} (${L.dueSoonLabel})`;
  return `• *${esc(task.task)}* — ${when} · ${task.owner ? esc(task.owner) : `_${L.noOwner}_`}`;
}

/**
 * Builds the Project Status message.
 *
 * @param {Object} review - Arguments of present_project_status (AI judgment)
 * @param {Object} data - Result of get_project_status (facts + signals)
 * @returns {{text: string, blocks: Object[]}}
 */
function buildProjectStatusBlocks(review, data) {
  const L = LABELS[review.language] || LABELS.en;
  const { project, signals: s, attention } = data;
  const health = HEALTH_ICON[review.health] ? review.health : 'needs_attention';
  const title = project.canvas?.name || project.channelName;
  const titleText = project.canvas?.link ? `*<${project.canvas.link}|${esc(title)}>*` : `*${esc(title)}*`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📋 ${L.title}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `${titleText}\n${L.kind} · ${project.channel}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `${HEALTH_ICON[health]} *${L.health[health]}*\n${esc(review.summary)}` } },
  ];

  if (s) {
    blocks.push(
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `\`${progressBar(s.progressPct)}\`  *${s.progressPct}%*  ·  ${L.progress(s.done, s.totalTasks)}` },
      },
      {
        type: 'section',
        fields: [
          kpi(L.done, String(s.done)),
          kpi(L.doing, String(s.inProgress)),
          kpi(L.todo, String(s.notStarted)),
          kpi(L.overdue, s.overdue > 0 ? `⚠️ ${s.overdue}` : '0'),
          kpi(L.soon, String(s.dueIn7Days)),
          kpi(L.unassigned, String(s.unassigned)),
          ...(s.blocked > 0 ? [kpi(L.blocked, `🚧 ${s.blocked}`)] : []),
        ],
      }
    );
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: L.noList }] });
  }
  blocks.push({ type: 'divider' });

  if (review.about) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*📌 ${L.about}*\n${esc(review.about)}` } });
  }

  if (review.risks?.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*⚠️ ${L.risks}*\n${review.risks.map(r => `• ${esc(r)}`).join('\n')}` },
    });
  }

  // Tasks needing attention come straight from the List, so names, dates and owners are exact
  const listed = new Set();
  const lines = [];
  for (const [kind, tasks] of [['overdue', attention?.overdue], ['soon', attention?.dueSoon], ['blocked', attention?.blocked]]) {
    for (const t of tasks || []) {
      if (listed.has(t.task)) continue; // a blocked task that is also overdue is shown once
      listed.add(t.task);
      lines.push(attentionLine(t, L, kind));
    }
  }
  if (lines.length) {
    const shown = lines.slice(0, 8);
    const extra = s.overdue + s.dueIn7Days + (s.blocked || 0) - shown.length;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⏰ ${L.attention}*\n${shown.join('\n')}${extra > 0 ? `\n_${L.more(extra)}_` : ''}`,
      },
    });
  }
  blocks.push({ type: 'divider' });

  const actions = (review.next_actions || []).slice(0, 5);
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [`*✅ ${L.nextActions}*`, ...actions.map((a, i) => `*${i + 1}. ${esc(a.action)}*\n👤 ${esc(a.owner)}   📅 ${esc(a.due)}`)].join('\n'),
    },
  });

  const links = [
    project.canvas?.link && { type: 'button', text: { type: 'plain_text', text: L.openCanvas }, url: project.canvas.link, action_id: 'project_open_canvas' },
    project.list?.link && { type: 'button', text: { type: 'plain_text', text: L.openList }, url: project.list.link, action_id: 'project_open_list' },
  ].filter(Boolean);
  if (links.length) blocks.push({ type: 'actions', elements: links });

  if (s) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: L.source(s.totalTasks, s.listCapped) }] });

  const text = `${HEALTH_ICON[health]} ${L.health[health]} — ${title}: ${review.summary}`;
  return { text, blocks };
}

module.exports = { PROJECT_REVIEW_TOOL, buildProjectStatusBlocks };
