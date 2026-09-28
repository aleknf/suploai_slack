/**
 * progress.js
 *
 * "Reading / thinking" indicators shown while Lori works on an answer.
 *
 *   - Assistant threads (DM pane): native Slack status ("Lori AI sedang mencari data…"), updated per step.
 *   - Channel mentions: 👀 reaction on the question + an animated placeholder reply in the thread with a
 *     checklist of finished steps. The placeholder is replaced by the final answer, 👀 becomes ✅.
 *
 * Both expose the same interface used by runWithTools(): step(label), plus finish()/fail() for channels.
 */

const FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const DOTS = ['', '.', '..', '...'];
const FRAME_INTERVAL_MS = 1500;

const THINKING = 'Berpikir';

const objectFromSoql = soql => soql?.match(/\bFROM\s+(\w+)/i)?.[1];

/**
 * Human-readable (Indonesian) label for a tool call, shown while it runs.
 *
 * @param {string} toolName - Tool name as defined in SF_TOOLS / SLACK_TOOLS
 * @param {Object} args - Parsed tool arguments
 * @returns {string}
 */
function toolLabel(toolName, args = {}) {
  switch (toolName) {
    case 'describe_salesforce_object':
      return `Mempelajari struktur ${args.object_name || 'object'}`;
    case 'query_records':
      return `Mencari data ${objectFromSoql(args.soql) || 'Salesforce'}`;
    case 'search_records':
      return `Mencari "${args.search_term}" di Salesforce`;
    case 'get_record_details':
      return `Membuka detail ${args.object_name || 'record'}`;
    case 'get_case_details':
      return 'Membuka detail Case';
    case 'query_cases':
      return 'Mencari data Case';
    case 'get_activity_history':
      return 'Membaca riwayat aktivitas';
    case 'analyze_opportunity':
      return 'Menganalisis amount, close date, discovery & aktivitas';
    case 'update_record':
      return 'Menyiapkan perubahan data';
    case 'read_channel_history':
      return 'Membaca pesan channel';
    case 'join_channel':
      return 'Bergabung ke channel';
    default:
      return 'Memproses';
  }
}

/**
 * Status indicator for Assistant threads, using assistant.threads.setStatus.
 *
 * @param {Object} params
 * @param {import('@slack/web-api').WebClient} params.client
 * @param {string} params.channel - Assistant DM channel Id
 * @param {string} params.threadTs - Assistant thread ts
 */
function createAssistantProgress({ client, channel, threadTs }) {
  let loadingMessagesSupported = true;

  const setStatus = async label => {
    const status = `sedang ${label.charAt(0).toLowerCase()}${label.slice(1)}…`;
    if (loadingMessagesSupported) {
      try {
        // loading_messages makes Slack show the text as an animated loading line
        await client.apiCall('assistant.threads.setStatus', {
          channel_id: channel,
          thread_ts: threadTs,
          status,
          loading_messages: [`${label}…`],
        });
        return;
      } catch (_) {
        loadingMessagesSupported = false;
      }
    }
    await client.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
  };

  return {
    start: () => setStatus('Membaca pertanyaan'),
    step: label => setStatus(label).catch(() => {}),
    thinking: () => setStatus(THINKING).catch(() => {}),
  };
}

/**
 * Animated placeholder for channel mentions.
 *
 * @param {Object} params
 * @param {import('@slack/web-api').WebClient} params.client
 * @param {string} params.channel - Channel Id
 * @param {string} params.threadTs - Thread to reply in
 * @param {string} params.messageTs - The user's message (gets the 👀 / ✅ reaction)
 * @param {Object} [params.logger]
 */
function createChannelProgress({ client, channel, threadTs, messageTs, logger = console }) {
  let placeholderTs = null;
  let current = 'Membaca pertanyaan';
  const done = [];
  let frame = 0;
  let timer = null;
  let inFlight = null;
  let stopped = false;

  const react = (name, add = true) =>
    client.reactions[add ? 'add' : 'remove']({ channel, timestamp: messageTs, name }).catch(() => {});

  const render = () => {
    const spinner = FRAMES[frame % FRAMES.length];
    const lines = [`${spinner} *Lori sedang ${current.charAt(0).toLowerCase()}${current.slice(1)}${DOTS[frame % DOTS.length]}*`];
    for (const label of done) lines.push(`✓ _${label}_`);
    return lines.join('\n');
  };

  // Only one chat.update at a time; skip animation frames while one is still in flight
  const refresh = () => {
    if (!placeholderTs || stopped || inFlight) return inFlight;
    const text = render();
    inFlight = client.chat
      .update({ channel, ts: placeholderTs, text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] })
      .catch(err => logger.warn?.('Progress update failed:', err.data?.error || err.message))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const setCurrent = label => {
    if (current !== THINKING && current !== label && !done.includes(current)) done.push(current);
    current = label;
    refresh();
  };

  return {
    async start() {
      react('eyes');
      const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text: render() });
      placeholderTs = res.ts;
      timer = setInterval(() => {
        frame++;
        refresh();
      }, FRAME_INTERVAL_MS);
    },

    step: setCurrent,
    thinking: () => setCurrent(THINKING),

    /**
     * Replaces the placeholder with the final message.
     *
     * @param {{text: string, blocks?: Object[]}} message - chat.postMessage-style arguments
     */
    async finish(message) {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      if (placeholderTs) {
        await client.chat.update({ channel, ts: placeholderTs, ...message });
      } else {
        await client.chat.postMessage({ channel, thread_ts: threadTs, ...message });
      }
      react('eyes', false);
      react('white_check_mark');
    },

    async fail(text) {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      const message = { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
      if (placeholderTs) await client.chat.update({ channel, ts: placeholderTs, ...message }).catch(() => {});
      else await client.chat.postMessage({ channel, thread_ts: threadTs, text }).catch(() => {});
      react('eyes', false);
      react('x');
    },
  };
}

module.exports = { createAssistantProgress, createChannelProgress, toolLabel };
