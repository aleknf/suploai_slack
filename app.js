const { App, LogLevel, Assistant } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { config } = require('dotenv');
// Load .env before the Salesforce/Slack modules read process.env at require time
config();
const { OpenAI } = require('openai');
// Removed unused ESM import that caused Jest compatibility issues
// const axios = require('axios');
// const pdfParse = require('pdf-parse');
//const mammoth = require('mammoth');
const fetch = require('node-fetch'); //use npm install node-fetch@2

// Salesforce tools: schema definitions for OpenAI function calling + executor dispatcher
const { SF_TOOLS, executeTool } = require('./sfTools');
// Slack tools: channel history + joining channels
const { SLACK_TOOLS, SLACK_TOOL_NAMES, executeSlackTool } = require('./slackTools');
const { getDescribe, getRecord, updateRecord } = require('./salesforce');
const {
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
} = require('./recordBlocks');

//change url for sandbox or prod
const sfUrl = 'https://langitkreasisolusindo.my.salesforce.com';
// const sfUrl = 'https://langitkreasisolusindo--devlks.sandbox.my.salesforce.com';

/** Initialization Slack*/
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
});

// Initialize Openai
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize DeepSeek
// const deepseekAi = new OpenAI({
//   baseURL: 'https://api.deepseek.com/v1',
//   apiKey: process.env.DEEPSEEK_API_KEY,
// });

const userClient = new WebClient(process.env.SLACK_USER_TOKEN);

const formatTimestamp = (timestamp) => {
  //const date = new Date((timestamp + 7 * 60 * 60) * 1000); // Adjust for timezone
  const date = new Date(timestamp * 1000);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0"); // Months are zero-based
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const formatDate = (dateStr) => {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0"); // Months are zero-based
  const day = String(date.getDate()).padStart(2, "0");
  return `${day}/${month}/${year}`;
};

function getTimestampForTime(hours, minutes) {
  const now = new Date();
  now.setHours(hours, minutes, 0, 0);
  //return Math.floor(now.getTime() / 1000) - (7 * 3600); // kurangi 7 jam dalam detik;
  return Math.floor(now.getTime() / 1000); // kurangi 7 jam dalam detik;
}

/**
 * Converts markdown-formatted text from OpenAI into Slack mrkdwn format.
 * Slack does not support standard markdown — it uses its own syntax.
 *
 * Conversions:
 *   **bold**        → *bold*
 *   __bold__        → *bold*
 *   *bold*          → *bold*     (single asterisk is already Slack bold)
 *   _italic_        → _italic_   (already correct)
 *   `code`          → `code`     (already correct)
 *   ```block```     → ```block``` (already correct)
 *   ### Heading     → *Heading*  (Slack has no headings, use bold)
 *   ## Heading      → *Heading*
 *   # Heading       → *Heading*
 *   - item / * item → • item     (bullet list)
 *   [text](url)     → <url|text> (Slack link format)
 *
 * @param {string} text - Markdown text from OpenAI
 * @returns {string} Slack mrkdwn formatted text
 */
function mdToSlack(text) {
  if (!text) return text;

  return text
    // Preserve code blocks first (avoid mangling content inside them)
    // We'll do a two-pass: extract code blocks, convert rest, then restore
    .replace(/```([\s\S]*?)```/g, (_, code) => `\`\`\`${code}\`\`\``) // keep as-is

    // Headings → bold line
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

    // Bold: **text** or __text__ → *text*
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')

    // Markdown links: [text](url) → <url|text>
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<$2|$1>')

    // Unordered list items: "- item" or "* item" at line start → "• item"
    .replace(/^[ \t]*[-*]\s+/gm, '• ')

    // Ordered list: "1. item" → keep as-is (Slack doesn't have ordered lists)

    // Horizontal rules → blank line
    .replace(/^[-*_]{3,}$/gm, '')

    // Trim trailing whitespace per line
    .replace(/[ \t]+$/gm, '');
}

// Tools whose results are rendered as record cards under the AI's reply
const RECORD_TOOLS = new Set([
  'query_records',
  'search_records',
  'get_record_details',
  'get_case_details',
  'query_cases',
  'analyze_opportunity',
]);

/**
 * Pulls the records out of a Salesforce tool result so they can be rendered as cards.
 *
 * @param {string} result - JSON string returned by executeTool
 * @returns {{records: Object[], totalSize: number}|null}
 */
function extractRecords(result) {
  const data = JSON.parse(result);
  if (Array.isArray(data)) {
    // search_records: [{ objectName, records }]
    const records = data.flatMap(group => group.records || []);
    return { records, totalSize: records.length };
  }
  if (Array.isArray(data.records)) return { records: data.records, totalSize: data.totalSize };
  // analyze_opportunity: the analyzed deal, or the candidates when the name was ambiguous
  if (data.opportunity) return { records: [data.opportunity], totalSize: 1 };
  if (Array.isArray(data.candidates)) return { records: data.candidates, totalSize: data.candidates.length };
  if (data.attributes) return { records: [data], totalSize: 1 };
  return null;
}

/**
 * Runs an OpenAI chat completion with Salesforce + Slack tool support.
 *
 * This is the core AI loop used by both the Assistant DM thread and the @mention handler.
 * It handles multi-step tool calls: if OpenAI requests a tool, we execute it, append the result,
 * and call OpenAI again — repeating until the AI produces a final text response.
 *
 * @param {Array<Object>} messages - OpenAI-format message history (system + user + assistant turns)
 * @param {Object} ctx - Request context: { client, userId, channelId, contextChannelId }
 * @param {Object} [options] - Optional overrides
 * @param {number} [options.maxIterations=8] - Safety cap to prevent infinite tool loops
 * @returns {Promise<{text: string, records: Object|null, pendingEdits: Object[]}>}
 *   Final reply text, the records of the last data query (rendered as cards) and edits awaiting confirmation
 * @throws {Error} If OpenAI fails
 */
async function runWithTools(messages, ctx, { maxIterations = 8 } = {}) {
  ctx.pendingEdits = [];
  let records = null;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      n: 1,
      messages,
      tools: [...SF_TOOLS, ...SLACK_TOOLS],
      // "auto" lets the model decide whether to call a tool or respond directly
      tool_choice: 'auto',
      temperature: 0.3,
    });

    const choice = response.choices[0];

    // If the model chose to respond directly (no tool calls), return the text
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls) {
      return { text: mdToSlack(choice.message.content), records, pendingEdits: ctx.pendingEdits };
    }

    // Append the assistant's tool-calling message to the conversation history
    messages.push(choice.message);

    // Execute each tool call the AI requested (may be multiple in one turn)
    for (const toolCall of choice.message.tool_calls) {
      const toolName = toolCall.function.name;

      let toolResult;
      try {
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        toolResult = SLACK_TOOL_NAMES.has(toolName)
          ? await executeSlackTool(toolName, toolArgs, ctx)
          : await executeTool(toolName, toolArgs, ctx);

        // Remember the latest record set; it is shown as cards with the final answer
        if (RECORD_TOOLS.has(toolName)) records = extractRecords(toolResult) || records;
      } catch (err) {
        // Return error as a tool result so the AI can explain it or retry
        toolResult = JSON.stringify({ error: err.data?.error || err.message });
      }

      // Append the tool result as a "tool" role message — required by OpenAI API
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  // Fallback if we hit the iteration cap (shouldn't happen in normal usage)
  return {
    text: 'Sorry, I ran into an issue retrieving that information. Please try again.',
    records: null,
    pendingEdits: [],
  };
}

/**
 * Turns the AI result into a Slack message: reply text, then edit confirmation cards or record cards.
 *
 * @param {{text: string, records: Object|null, pendingEdits: Object[]}} result - Output of runWithTools
 * @param {string} requesterId - Slack user Id; only they can confirm proposed edits
 * @returns {Promise<{text: string, blocks: Object[]}>} chat.postMessage arguments
 */
async function buildReplyMessage({ text, records, pendingEdits }, requesterId) {
  const blocks = textToBlocks(text);

  for (const edit of pendingEdits) {
    blocks.push(...(await buildEditConfirmBlocks(edit, requesterId)));
  }

  // Skip record cards when an edit is pending — the lookup query would only add noise
  if (pendingEdits.length === 0 && records?.records.length && blocks.length < 45) {
    blocks.push(...(await buildRecordBlocks(records.records, { totalSize: records.totalSize, maxBlocks: 50 - blocks.length })));
  }

  return { text: text || 'Here is what I found.', blocks: blocks.slice(0, 50) };
}

/**
 * Collects the visible text of a message's blocks (including record links, which carry the record Ids)
 * so earlier record cards stay in the AI's conversation history.
 */
function blocksToText(blocks = []) {
  const parts = [];
  for (const block of blocks) {
    if (block.text?.text) parts.push(block.text.text);
    for (const field of block.fields || []) parts.push(field.text);
    for (const el of block.type === 'context' ? block.elements : []) if (el.text) parts.push(el.text);
  }
  return parts.join('\n');
}

/**
 * Maps a Slack message to an OpenAI history message.
 */
function toHistoryMessage(m) {
  const content = m.bot_id && m.blocks?.length ? blocksToText(m.blocks) : m.text;
  return {
    role: m.bot_id ? 'assistant' : 'user',
    content: (content || '').slice(0, 4000),
  };
}

/**
 * System prompt sent to OpenAI on every conversation turn.
 * Instructs the AI on its persona, capabilities, and tool usage rules.
 * Keep this concise — it is prepended to every message array and counts toward token usage.
 */
const DEFAULT_SYSTEM_CONTENT = `You are Lori, an assistant in a Slack workspace for Langit Kreasi Solusindo (LKS).
You help users with general questions, Salesforce data (Contacts, Leads, Opportunities, Accounts, Activities, Projects, Cases, and more) and Slack channels.

Salesforce — finding records:
- Act immediately. NEVER ask which object to search and never ask for confirmation before reading data. Infer the object from the user's words (e.g. "opportunity" → Opportunity, "kontak" → Contact, "proyek" → Project__c). Only ask a question when the request is truly impossible to interpret.
- Use query_records (SOQL) for filters and search_records (SOSL) for a name/keyword. For standard objects write SOQL directly with well-known fields; call describe_salesforce_object only for custom objects/fields or after a query error.
- Always SELECT Id, the record name and the fields relevant to the question (e.g. Opportunity: Id, Name, Account.Name, StageName, Amount, CloseDate, Owner.Name). Default to LIMIT 20 with a sensible ORDER BY.
- "Open" opportunities means IsClosed = false. A year like "2026" filters CloseDate (CALENDAR_YEAR(CloseDate) = 2026) unless another date field is named. Use SOQL date literals (THIS_MONTH, LAST_N_DAYS:30, NEXT_QUARTER, ...) for relative dates.
- If a query fails, fix it (describe the object if needed) and retry instead of giving up.
- The records returned by your last query are displayed automatically as cards under your message (with links and an Edit button). Keep your text short: one or two sentences of summary or insight (count, totals, notable items). Do NOT list the records or their fields again.
- For counts and totals use aggregate SOQL (COUNT(), SUM(Amount)) and state the result.

Salesforce — editing records:
- Use update_record to change fields. It shows the user a Save/Cancel confirmation card; nothing is saved until they click Save. Do not ask for confirmation in text.
- Find the record Id first when needed. If several records match, list the candidates and ask which one.
- Ids of records shown earlier are in their Salesforce links in the conversation history.

Opportunity summary & next actions:
- When asked for a summary, conclusion, health, risk or next action of an opportunity, call analyze_opportunity and base your answer on its data (amount, close date, discovery, activities, history, signals).
- Answer in this structure (the opportunity card is shown automatically below, so do not repeat its fields):
  *Kesimpulan* — health label 🟢 On track / 🟡 Needs attention / 🔴 At risk, then 2-3 sentences explaining why.
  *Amount & Close Date* — is the amount set and realistic for the stage/probability; days to close, overdue close date, how often it was pushed.
  *Discovery* — review the Discovery Information fields (Salesforce Implementation Objective, Current Tools, Integration, Expected Impact, Implementation Timeline, Standard Business Process, Quip Link): what is known and which are empty. Discovery Check unchecked means discovery has not been validated yet — call it out.
  *Activity* — last interaction and how long ago, activity in the last 30 days, upcoming or overdue tasks.
  *Next Actions* — 3-5 numbered, concrete actions (who/what/by when), most important first, each tied to a gap or risk above.
- Use the signals, do not invent facts. Flag red flags: close date passed or pushed repeatedly, no activity for 14+ days, nothing scheduled, missing amount, empty discovery, long time in the same stage.
- If the user wants to act on a recommendation (e.g. move the close date), use update_record.

Slack channels:
- read_channel_history reads the latest messages (max 50) of a channel — use it to summarize a channel or answer questions about its discussion. Without a channel it reads the current channel.
- join_channel joins a public channel. For private channels, tell the user to run /invite @Lori AI in that channel.

Formatting rules (IMPORTANT — you are responding in Slack):
- Use *bold* for emphasis (NOT **double asterisk**).
- Use _italic_ for secondary info.
- Use bullet points with • or - for lists.
- Do NOT use markdown headings (# ## ###) — use *bold text* instead.
- Do NOT use [text](url) links — use plain URLs or <url|text> format.
- Keep Slack syntax like <@USER_ID> or <#CHANNEL_ID> as-is.
- Reply in the user's language.
- Avoid greetings unless explicitly requested.
- Respond professionally unless asked otherwise.`;

/**
 * Adds per-request facts (date, user, channel) to the system prompt.
 */
function buildSystemPrompt(ctx) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  const lines = [`Today is ${today} (Asia/Jakarta).`, `The user talking to you is <@${ctx.userId}>.`];
  if (ctx.contextChannelId) lines.push(`The current channel is <#${ctx.contextChannelId}>.`);
  return `${DEFAULT_SYSTEM_CONTENT}\n\n${lines.join('\n')}`;
}

// Assistant configuration and event handlers
const assistant = new Assistant({
  threadStarted: async ({ event, logger, say, setSuggestedPrompts, saveThreadContext }) => {
    const { context } = event.assistant_thread;

    try {
      await say('Hi, how can Lori help?');
      await saveThreadContext();

      const prompts = [
        {
          title: 'Open opportunities this year',
          message: 'Show open opportunities closing this year',
        },
      ];

      if (context.channel_id) {
        prompts.push({
          title: 'Summarize channel',
          message: 'Assistant, please summarize the activity in this channel!',
        });
      }

      await setSuggestedPrompts({ prompts, title: 'HI How are you today?' });
    } catch (e) {
      logger.error(e);
    }
  },

  threadContextChanged: async ({ logger, saveThreadContext }) => {
    try {
      await saveThreadContext();
    } catch (e) {
      logger.error(e);
    }
  },

  userMessage: async ({ client, logger, message, getThreadContext, say, setTitle, setStatus }) => {
    const { channel, thread_ts } = message;

    try {
      await setTitle(message.text);
      await setStatus('is typing....biatch');

      //add identity check
      const identityQuestions = ['who are you', 'siapa kamu','what is your name', 'what is your identity', 'what are you?'];
      if (identityQuestions.some(q => message.text.toLowerCase().includes(q))) {
        await say("I'm Lori, LKS Assistant ready to serve all LKS Members. Lori is The Man, The Myth, The LEGEND!!");
        return;

      }
      const thread = await client.conversations.replies({
        channel,
        ts: thread_ts,
        oldest: thread_ts,
      });

      // Keep the last 10 earlier messages for context (the current message is appended below)
      const threadHistory = thread.messages
        .filter(m => m.ts !== message.ts && m.text !== 'Hi, sorry Lori lagi ngehang....')
        .slice(-10)
        .map(toHistoryMessage);

      // The channel the user is viewing when they opened the assistant ("current channel")
      const threadContext = await getThreadContext();
      const ctx = { client, userId: message.user, channelId: channel, contextChannelId: threadContext?.channel_id };

      // Build the message array: system prompt + thread history + current user message
      const messages = [
        { role: 'system', content: buildSystemPrompt(ctx) },
        ...threadHistory,
        { role: 'user', content: message.text },
      ];

      // Use the tool-calling loop so the AI can query Salesforce / Slack if needed
      const result = await runWithTools(messages, ctx);
      await say(await buildReplyMessage(result, message.user));
    } catch (e) {
      logger.error('Error processing user message:', e);
      await say({ text: 'Something unexpected happened while processing your request' });
    }
  },});

app.assistant(assistant);

/** Start the Bolt App */
(async () => {
  try {
    await app.start();
    app.logger.info('⚡️ Lori app is running!');
  } catch (error) {
    app.logger.error('Failed to start Lori', error);
  }
})();

/**
 * Handles @mention events in any channel. Lori replies in a thread (continuing the thread's context
 * when mentioned inside one) and can query Salesforce, read channel history or summarize the channel.
 */
app.event('app_mention', async ({ event, client, say, logger }) => {
  const threadTs = event.thread_ts || event.ts;

  try {
    // Mentioned inside a thread: include the earlier thread messages as context
    let history = [];
    if (event.thread_ts) {
      const thread = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 50 });
      history = thread.messages
        .filter(m => m.ts !== event.ts)
        .slice(-10)
        .map(toHistoryMessage);
    }

    const ctx = { client, userId: event.user, channelId: event.channel, contextChannelId: event.channel };
    const messages = [
      { role: 'system', content: buildSystemPrompt(ctx) },
      ...history,
      { role: 'user', content: event.text },
    ];

    const result = await runWithTools(messages, ctx);
    await say({ ...(await buildReplyMessage(result, event.user)), thread_ts: threadTs });
  } catch (error) {
    logger.error('Error handling app_mention:', error);
    await say({ text: 'Sorry, something went wrong processing your request.', thread_ts: threadTs });
  }
});

/**
 * Greets a channel when Lori is added to it (via /invite or the join_channel tool).
 */
app.event('member_joined_channel', async ({ event, client, context, logger }) => {
  if (event.user !== context.botUserId) return;
  try {
    await client.chat.postMessage({
      channel: event.channel,
      text:
        "👋 Hi, I'm *Lori*! Mention me with *@Lori AI* to search or edit Salesforce records, " +
        'or ask me to summarize this channel.',
    });
  } catch (error) {
    logger.error('Error greeting channel:', error);
  }
});

/**
 * Posts a short result note to the thread where an edit happened.
 */
async function postEditNote(client, { channel, threadTs, userId, text, ephemeral = false }) {
  if (!channel) return client.chat.postMessage({ channel: userId, text });
  if (ephemeral) return client.chat.postEphemeral({ channel, user: userId, thread_ts: threadTs, text });
  return client.chat.postMessage({ channel, thread_ts: threadTs, text });
}

// Name field of an object (Name, CaseNumber, Subject, ...) — fetched so notes can show the record title
function nameFieldOf(describe) {
  return describe.fields.find(f => f.nameField)?.name || 'Id';
}

/**
 * "✏️ Edit" button on a record card: opens a modal with the card's editable fields.
 * A loading modal is opened first because trigger_id expires 3 seconds after the click.
 */
app.action('sf_edit_record', async ({ ack, body, client, action, logger }) => {
  await ack();
  const { o, id, f } = JSON.parse(action.value);

  const { view } = await client.views.open({ trigger_id: body.trigger_id, view: buildLoadingModal() });

  try {
    const describe = await getDescribe(o);
    const fields = pickEditableFields(describe, f);
    if (fields.length === 0) {
      await client.views.update({ view_id: view.id, view: buildLoadingModal('This record has no fields you can edit here.') });
      return;
    }

    const record = await getRecord(o, id, [...new Set(['Id', nameFieldOf(describe), ...fields.map(m => m.name)])]);
    await client.views.update({
      view_id: view.id,
      view: buildEditModal({
        describe,
        record,
        fields,
        privateMetadata: { o, id, ch: body.channel?.id, ts: body.message?.thread_ts || body.message?.ts },
      }),
    });
  } catch (error) {
    logger.error('Error opening edit modal:', error);
    await client.views.update({ view_id: view.id, view: buildLoadingModal(`❌ Could not load the record: ${error.message}`) });
  }
});

/**
 * Edit modal submitted: re-reads the record, saves only the changed fields and reports in the thread.
 */
app.view('sf_edit_modal', async ({ ack, body, view, client, logger }) => {
  await ack();
  const { o, id, ch, ts } = JSON.parse(view.private_metadata);
  const userId = body.user.id;

  try {
    const describe = await getDescribe(o);
    const fieldNames = Object.keys(view.state.values)
      .filter(k => k.startsWith('f:'))
      .map(k => k.slice(2));
    const current = await getRecord(o, id, [...new Set(['Id', nameFieldOf(describe), ...fieldNames])]);
    const changes = parseEditSubmission(view.state.values, describe, current);

    if (Object.keys(changes).length === 0) {
      await postEditNote(client, { channel: ch, threadTs: ts, userId, ephemeral: true, text: 'No changes to save.' });
      return;
    }

    await updateRecord(o, id, changes);
    const lines = describeChanges(changes, current, describe).map(l => `• ${l.replace('\n', ': ')}`);
    await postEditNote(client, {
      channel: ch,
      threadTs: ts,
      userId,
      text: `✅ <@${userId}> updated ${describe.label} *<${recordUrl(o, id)}|${recordTitle(current)}>*\n${lines.join('\n')}`,
    });
  } catch (error) {
    logger.error('Error saving record edit:', error);
    await postEditNote(client, { channel: ch, threadTs: ts, userId, ephemeral: true, text: `❌ ${error.message}` });
  }
});

/**
 * Replaces the Save/Cancel buttons of an edit confirmation card with a status line.
 */
async function resolveEditCard(client, body, statusText) {
  const blocks = body.message.blocks.map(block =>
    block.block_id === body.actions[0].block_id
      ? { type: 'context', elements: [{ type: 'mrkdwn', text: statusText }] }
      : block
  );
  await client.chat.update({ channel: body.channel.id, ts: body.message.ts, text: body.message.text, blocks });
}

/**
 * Save / Cancel on an AI-proposed edit. Only the user who asked for the edit may resolve it.
 */
async function handleEditDecision({ ack, body, client, action, logger }, save) {
  await ack();
  const { o, id, c, u } = JSON.parse(action.value);
  const userId = body.user.id;
  const threadTs = body.message.thread_ts || body.message.ts;

  if (userId !== u) {
    await client.chat.postEphemeral({
      channel: body.channel.id,
      user: userId,
      thread_ts: threadTs,
      text: `Only <@${u}> can confirm this edit.`,
    });
    return;
  }

  if (!save) {
    await resolveEditCard(client, body, `🚫 Cancelled by <@${userId}>`);
    return;
  }

  try {
    await updateRecord(o, id, c);
    await resolveEditCard(client, body, `✅ Saved to Salesforce by <@${userId}>`);
  } catch (error) {
    logger.error('Error saving confirmed edit:', error);
    await client.chat.postEphemeral({ channel: body.channel.id, user: userId, thread_ts: threadTs, text: `❌ ${error.message}` });
  }
}

app.action('sf_confirm_edit', args => handleEditDecision(args, true));
app.action('sf_cancel_edit', args => handleEditDecision(args, false));

app.command('/timesheet-lks', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal',
            callback_id: 'timesheet_modal',
            title: {
                type: 'plain_text',
                text: 'Submit TimeSheet'
            },
            submit: {
                type: 'plain_text',
                text: 'Submit'
            },
            close: {
                type: 'plain_text',
                text: 'Cancel'
            },
            blocks: [
                {
                    type: 'input',
                    block_id: 'start_datetime_block',
                    element: {
                        type: 'datetimepicker',
                        action_id: 'start_datetime',
                        initial_date_time: getTimestampForTime(9, 0) 
                    },
                    label: {
                        type: 'plain_text',
                        text: 'Start datetime'
                    }
                },
                {
                    type: 'input',
                    block_id: 'end_datetime_block',
                    element: {
                        type: 'datetimepicker',
                        action_id: 'end_datetime',
                        initial_date_time: getTimestampForTime(18, 0) 
                    },
                    label: {
                        type: 'plain_text',
                        text: 'End datetime'
                    }
                },
                {
                    type: 'input',
                    block_id: 'work_mode_block',
                    element: {
                        type: 'static_select',
                        action_id: 'work_mode',
                        placeholder: {
                            type: 'plain_text',
                            text: 'Select work mode'
                        },
                        options: [
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'WFO'
                                },
                                value: 'WFO'
                            },
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'WFA'
                                },
                                value: 'WFA'
                            },
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'Hybrid'
                                },
                                value: 'Hybrid'
                            },
                            {
                                text: {
                                    type: 'plain_text',
                                    text: 'Sick'
                                },
                                value: 'Sick'
                            }
                        ]
                    },
                    label: {
                        type: 'plain_text',
                        text: 'Work Mode'
                    }
                }
            ]
        }
    });
  } catch (error) {
    console.error('Error opening timesheet modal:', error);
    console.error(JSON.stringify(error, null, 2));
  }
});

app.view('timesheet_modal', async ({ ack, body, view, client }) => {
  await ack();
  try {
    const startDatetime = view.state.values.start_datetime_block.start_datetime.selected_date_time;
    const endDatetime = view.state.values.end_datetime_block.end_datetime.selected_date_time;
    const workMode = view.state.values.work_mode_block.work_mode.selected_option.value;

    // Proses data yang diterima

    // Lanjutkan dengan fungsi yang Anda inginkan setelah submit
    const userId = body.user.id;
    // Dapatkan informasi pengguna
    const userInfo = await client.users.info({
        user: body.user.id,
    });

    // Ambil email dari profil pengguna
    const email = userInfo.user.profile?.email || "unknown@example.com";

    const timeSheetChannelId = process.env.SLACK_TIMESHEET_CHANNEL;

    const updatedMsg = `<@${userId}> submitted the following TimeSheet: \n<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>\nWork Mode: ${workMode}`;

    await client.chat.postMessage({
        channel: timeSheetChannelId,
        text: updatedMsg,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: updatedMsg,
                },
            },
            {
                type: "actions",
                block_id: `timesheet_actions`,
                elements: [
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "Approve",
                        },
                        action_id: "approve_request",
                        style: "primary",
                        value: JSON.stringify({
                            email,
                            startDatetime,
                            endDatetime,
                            workMode,
                            userId,
                        }),
                    },
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "Reject",
                        },
                        action_id: "reject_request",
                        style: "danger",
                        value: JSON.stringify({
                            email,
                            startDatetime,
                            endDatetime,
                            workMode,
                            userId,
                        }),
                    },
                ],
            },
        ],
    });

    // Kirim konfirmasi ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your timesheet has been submitted: \n<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>\nWork Mode: ${workMode}`,
    });
  } catch (error) {
    console.error('Error submitting timesheet:', error);
    console.error(JSON.stringify(error, null, 2));
    await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Sorry, there was an error submitting your timesheet.'
    });
  }
});

app.action('approve_request', async ({ ack, body, client, action }) => {
  await ack(); // Acknowledge the action first
  try {
    const metadata = JSON.parse(action.value);
    const { email, startDatetime, endDatetime, workMode, userId } = metadata;
    
    const startDate = formatTimestamp(startDatetime);
    const endDate = formatTimestamp(endDatetime);

    // Proses pengiriman data ke Salesforce
    // Panggil fungsi yang diinginkan
    await handleTimesheetApproval({
        client,
        userId,
        email,
        startDate,
        endDate,
        workMode
    });

    // Kirim konfirmasi ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your timesheet has been :white_check_mark: approved: \n<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>\nWork Mode: ${workMode}`,
    });
    
    const approverId = body.user.id;

    // Update pesan asli untuk menghapus tombol
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Timesheet submitted by <@${userId}> : \n(<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>)\nWork Mode: ${workMode}`,
                },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `:white_check_mark: Approved by <@${approverId}>`,
                },
              ],
            },
        ],
    });

    let statusText = "Office";
    let statusEmoji = ":office:";

    if (workMode == "Hybrid") {
      statusText = "Commuting";
      statusEmoji = ":bus:";
    } else if (workMode == "WFA") {
      statusText = "Working remotely";
      statusEmoji = ":house_with_garden:";
    } else if (workMode == "Sick") {
      statusText = "Sick";
      statusEmoji = ":face_with_thermometer:";
    }

    // Update status pengguna
    await userClient.users.profile.set({
        user: userId,
        profile: {
            status_text: statusText,
            status_emoji: statusEmoji,
            status_expiration: endDatetime, // Opsional: hapus status otomatis
        }
    });

  } catch (error) {
    console.error('Error approving timesheet:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error approving your timesheet: ${error.message}`,
    });
  }
});

app.action('reject_request', async ({ ack, body, client, action }) => {
  await ack(); // Acknowledge the action first
  try {
    const metadata = JSON.parse(action.value);
    const { email, startDatetime, endDatetime, workMode, userId } = metadata;

    // Kirim notifikasi penolakan ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your timesheet has been :x: rejected: \n<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>\nWork Mode: ${workMode}`,
    });

    const approverId = body.user.id;

    // Update pesan asli untuk menghapus tombol
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Timesheet submitted by <@${userId}> : \n(<!date^${startDatetime}^{date} at {time}|${startDatetime}> - <!date^${endDatetime}^{date} at {time}|${endDatetime}>)\nWork Mode: ${workMode}`,
                },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `:x: Rejected by <@${approverId}>`,
                },
              ],
            },
        ],
    });

  } catch (error) {
    console.error('Error rejecting timesheet:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error rejecting your timesheet: ${error.message}`,
    });
  }
});

app.command('/leaverequest-lks', async ({ ack, body, client }) => {
  await ack();
  try {
    await client.views.open({
        trigger_id: body.trigger_id,
        view: {
            type: 'modal',
            callback_id: 'leaverequest_modal',
            title: {
                type: 'plain_text',
                text: 'Submit Leave Request'
            },
            submit: {
                type: 'plain_text',
                text: 'Submit'
            },
            close: {
                type: 'plain_text',
                text: 'Cancel'
            },
            blocks: [
                {
                    type: 'input',
                    block_id: 'type_block',
                    element: {
                        type: 'static_select',
                        action_id: 'type',
                        placeholder: {
                            type: 'plain_text',
                            text: 'Select type'
                        },
                        options: [
                          {
                              text: {
                                  type: 'plain_text',
                                  text: 'Leave'
                              },
                              value: 'Leave'
                          },
                          {
                              text: {
                                  type: 'plain_text',
                                  text: 'Sick'
                              },
                              value: 'Sick'
                          }
                        ]
                    },
                    label: {
                        type: 'plain_text',
                        text: 'Type'
                    }
                },
                {
                    type: 'input',
                    block_id: 'title_block',
                    label: {
                        type: 'plain_text',
                        text: 'Title'
                    },
                    element: {
                        type: 'plain_text_input',
                        action_id: 'title',
                        placeholder: {
                        type: 'plain_text',
                        text: 'Enter post title'
                        }
                    }
                },
                {
                    type: 'input',
                    block_id: 'start_date_block',
                    label: {
                        type: 'plain_text',
                        text: 'Start Date'
                    },
                    element: {
                        type: 'datepicker',
                        action_id: 'start_date',
                        initial_date: new Date().toISOString().split('T')[0]
                    }
                },
                {
                    type: 'input',
                    block_id: 'end_date_block',
                    label: {
                        type: 'plain_text',
                        text: 'End Date'
                    },
                    element: {
                        type: 'datepicker',
                        action_id: 'end_date',
                        initial_date: new Date().toISOString().split('T')[0]
                    }
                },
                {
                    type: 'input',
                    block_id: 'note_block',
                    label: {
                        type: 'plain_text',
                        text: 'Note'
                    },
                    element: {
                        type: 'plain_text_input',
                        action_id: 'note',
                        multiline: true,
                        placeholder: {
                        type: 'plain_text',
                        text: 'Enter additional notes'
                        }
                    }
                },
                {
                    type: 'input',
                    block_id: 'file_block',
                    label: {
                        type: 'plain_text',
                        text: 'Attachment'
                    },
                    element: {
                        type: 'file_input',
                        action_id: 'file',
                        filetypes: ['pdf', 'doc', 'docx', 'jpg', 'png'], // Optional: specify allowed file types
                    },
                    optional: true // Optional: make the file input optional
                }
            ]
        }
    });
  } catch (error) {
    console.error('Error opening Leave Request modal:', error);
    console.error(JSON.stringify(error, null, 2));
  }
});

app.view('leaverequest_modal', async ({ ack, body, view, client }) => {
  await ack();
  try {
    const type = view.state.values.type_block.type.selected_option.value;
    const title = view.state.values.title_block.title.value;
    const startDate = view.state.values.start_date_block.start_date.selected_date;
    const endDate = view.state.values.end_date_block.end_date.selected_date;
    const note = view.state.values.note_block.note.value;

    // Lanjutkan dengan fungsi yang Anda inginkan setelah submit
    const userId = body.user.id;
    // Dapatkan informasi pengguna
    const userInfo = await client.users.info({
        user: body.user.id,
    });

    // Ambil email dari profil pengguna
    const email = userInfo.user.profile?.email || "unknown@example.com";

    const timeSheetChannelId = process.env.SLACK_TIMESHEET_CHANNEL;

    let fileUrl = null;
    try {
      const fileBlock = view.state.values.file_block?.file;
      
      if (fileBlock && fileBlock.files && fileBlock.files.length > 0) {
        const uploadedFile = fileBlock.files[0];

        // Ambil permalink
        fileUrl = uploadedFile.permalink;
      }else{
        console.error('File upload not found');
      }
    } catch (fileUploadError) {
      console.error('File upload error:', fileUploadError);
      // Tetap lanjutkan dengan proses utama meskipun upload file gagal
    }

    const updatedMsg = `<@${userId}> submitted the following Leave Request: ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}${fileUrl ? `\nAttachment: ${fileUrl}` : ''}`;

    const messageOptions = {
      channel: timeSheetChannelId,
      text: updatedMsg,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: updatedMsg,
          },
        },
        {
          type: "actions",
          block_id: `leaverequest_actions`,
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Approve",
              },
              action_id: "approve_request_lr",
              style: "primary",
              value: JSON.stringify({
                type,
                email,
                startDate,
                endDate,
                title,
                note,
                userId,
                fileUrl
              }),
            },
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "Reject",
              },
              action_id: "reject_request_lr",
              style: "danger",
              value: JSON.stringify({
                type,
                email,
                startDate,
                endDate,
                title,
                note,
                userId,
                fileUrl
              }),
            },
          ],
        },
      ],
    };

    await client.chat.postMessage(messageOptions);

    // Kirim konfirmasi ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your Leave Request has been submitted: ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}`,
    });

  } catch (error) {
    console.error('Error submitting Leave Request:', error);
    console.error(JSON.stringify(error, null, 2));
    await client.chat.postMessage({
        channel: body.user.id,
        text: '❌ Sorry, there was an error submitting your Leave Request.'
    });
  }
});

app.action('approve_request_lr', async ({ ack, body, client, action }) => {
  await ack(); // Acknowledge the action first
  try {
    const metadata = JSON.parse(action.value);
    const { type, email, startDate, endDate, title, note, userId, fileUrl } = metadata;
    
    const startDateFormatted = formatDate(startDate);
    const endDateFormatted = formatDate(endDate);

    // Proses pengiriman data ke Salesforce
    // Panggil fungsi yang diinginkan
    await handleLeaveRequestApproval({
        type,
        client,
        userId,
        email,
        startDateFormatted,
        endDateFormatted,
        title,
        note,
        fileUrl
    });

    // Kirim konfirmasi ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your Leave Request has been :white_check_mark: approved: ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}`,
    });

    const approverId = body.user.id;

    // Update pesan asli untuk menghapus tombol
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Leave Request submitted by <@${userId}> : ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}${fileUrl ? `\nAttachment: ${fileUrl}` : ''}`,
                },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `:white_check_mark: Approved by <@${approverId}>`,
                },
              ],
            },
        ],
    });

  } catch (error) {
    console.error('Error approving Leave Request:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error approving your Leave Request: ${error.message}`,
    });
  }
});

app.action('reject_request_lr', async ({ ack, body, client, action }) => {
  await ack(); // Acknowledge the action first
  try {
    const metadata = JSON.parse(action.value);
    const { type, email, startDate, endDate, title, note, userId, fileUrl } = metadata;

    // Kirim notifikasi penolakan ke pengguna
    await client.chat.postMessage({
        channel: userId,
        text: `Your Leave Request has been :x: rejected: ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}`,
    });

    const approverId = body.user.id;

    // Update pesan asli untuk menghapus tombol
    await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `Leave Request submitted by <@${userId}> : ${type}\nTitle : ${title}\n${startDate} - ${endDate}\nNote: ${note}${fileUrl ? `\nAttachment: ${fileUrl}` : ''}`,
                },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `:x: Rejected by <@${approverId}>`,
                },
              ],
            },
        ],
    });

  } catch (error) {
    console.error('Error rejecting Leave Request:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error rejecting your Leave Request: ${error.message}`,
    });
  }
});

async function getSalesforceToken() {
  const sf_token_url = sfUrl+"/services/oauth2/token?grant_type=password&client_id="+process.env.SALESFORCE_CLIENT_ID+"&client_secret="+process.env.SALESFORCE_CLIENT_SECRET+"&username="+process.env.SALESFORCE_USER_NAME+"&password="+process.env.SALESFORCE_USER_PASS
  const salesforceResponse = await fetch(sf_token_url, {
    method: "POST",
  });

  if (!salesforceResponse.ok) {
    throw new Error(`Salesforce token error: ${salesforceResponse.statusText}`);
  }

  const salesforceTokenData = await salesforceResponse.json();
  return salesforceTokenData.access_token;
}

async function handleTimesheetApproval({ client, userId, email, startDate, endDate, workMode }) {
  try {
    const salesforceApiUrl = sfUrl+"/services/apexrest/time-sheet/v1.0/Submit"; // Ganti dengan URL API Salesforce yang sesuai
    
    const accessToken = await getSalesforceToken();

    const postData = {
        Email: email,
        WorkStart: startDate,
        WorkEnd: endDate,
        WorkMode: workMode,
    };

    const apiResponse = await fetch(salesforceApiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(postData),
    });

    if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        throw new Error(`Salesforce email: ${email}, API Error: ${errorText}`);
    }

  } catch (error) {
    console.error('Error handling timesheet approval:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error processing your timesheet: ${error.message}`
    });
  }
}

async function handleLeaveRequestApproval({ type, client, userId, email, startDateFormatted, endDateFormatted, title, note, fileUrl }) {
  try {
    const salesforceApiUrl = sfUrl+"/services/apexrest/leave-request/v1.0/Submit"; // Ganti dengan URL API Salesforce yang sesuai
    
    const accessToken = await getSalesforceToken();

    const postData = {
        Type: type,
        Email: email,
        Title: title,
        Note: note,
        StartDate: startDateFormatted,
        EndDate: endDateFormatted,
        FileUrl: fileUrl,
    };

    const apiResponse = await fetch(salesforceApiUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(postData),
    });

    if (!apiResponse.ok) {
        const errorText = await apiResponse.text();
        throw new Error(`Salesforce email: ${email}, API Error: ${errorText}`);
    }

  } catch (error) {
    console.error('Error handling Leave Request approval:', error);
    await client.chat.postMessage({
        channel: userId,
        text: `❌ Error processing your Leave Request: ${error.message}`
    });
  }
}