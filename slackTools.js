/**
 * slackTools.js
 *
 * OpenAI tool schemas + executors for Slack workspace operations:
 *   - read_channel_history: read up to 50 recent messages from a channel
 *   - join_channel: make the bot join a public channel
 *
 * Executors receive a per-request ctx: { client, userId, channelId, contextChannelId }.
 */

const MAX_HISTORY = 50;

const SLACK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_channel_history',
      description:
        'Reads the most recent messages (max 50) of a Slack channel. Use it to summarize a channel, ' +
        'answer questions about recent discussion, or find what someone said. ' +
        'Omit channel to read the current channel.',
      parameters: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel Id (C123...), a <#C123|name> mention, or a channel name like "general". Optional.',
          },
          limit: {
            type: 'integer',
            description: `Number of messages to read, 1-${MAX_HISTORY}. Defaults to ${MAX_HISTORY}.`,
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'join_channel',
      description:
        'Makes Lori join a public Slack channel so it can read and reply there. ' +
        'Private channels cannot be joined this way — the user must run /invite @Lori AI in that channel.',
      parameters: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            description: 'Channel Id (C123...), a <#C123|name> mention, or a channel name like "general".',
          },
        },
        required: ['channel'],
      },
    },
  },
];

const SLACK_TOOL_NAMES = new Set(SLACK_TOOLS.map(t => t.function.name));

// user Id → display name, kept for the process lifetime (names rarely change)
const userNameCache = new Map();

async function getUserName(client, userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  let name = userId;
  try {
    const { user } = await client.users.info({ user: userId });
    name = user.profile?.display_name || user.real_name || user.name || userId;
  } catch (_) {}
  userNameCache.set(userId, name);
  return name;
}

/**
 * Resolves a channel reference (Id, <#Id|name> mention, #name or name) to a channel Id.
 */
async function resolveChannelId(client, ref) {
  const value = String(ref).trim();
  const mention = value.match(/^<#([CGD][A-Z0-9]+)(\|[^>]*)?>$/);
  if (mention) return mention[1];
  if (/^[CGD][A-Z0-9]{6,}$/.test(value)) return value;

  const name = value.replace(/^#/, '').toLowerCase();
  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
      cursor,
    });
    const found = res.channels.find(c => c.name === name);
    if (found) return found.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  throw new Error(`Channel "${value}" not found (or Lori cannot see it).`);
}

async function isChannelMember(client, channel, userId) {
  let cursor;
  do {
    const res = await client.conversations.members({ channel, limit: 1000, cursor });
    if (res.members.includes(userId)) return true;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return false;
}

async function readChannelHistory(args, ctx) {
  const { client, userId } = ctx;
  const ref = args.channel || ctx.contextChannelId || ctx.channelId;
  if (!ref) return { error: 'No channel specified.' };

  const channel = await resolveChannelId(client, ref);
  const limit = Math.min(Math.max(Number(args.limit) || MAX_HISTORY, 1), MAX_HISTORY);

  const { channel: info } = await client.conversations.info({ channel });

  // Don't leak private conversations: the requester must be a member themselves
  if ((info.is_private || info.is_mpim) && !(await isChannelMember(client, channel, userId))) {
    return { error: 'You are not a member of that private channel, so Lori cannot share its history with you.' };
  }

  let history;
  try {
    history = await client.conversations.history({ channel, limit });
  } catch (err) {
    if (err.data?.error !== 'not_in_channel') throw err;
    if (info.is_private) {
      return { error: 'Lori is not in that private channel. Ask someone to run /invite @Lori AI there.' };
    }
    // Public channel: join automatically, then retry
    await client.conversations.join({ channel });
    history = await client.conversations.history({ channel, limit });
  }

  const messages = [];
  // API returns newest first — present oldest first so the AI reads the conversation in order
  for (const m of history.messages.reverse()) {
    if (m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'thread_broadcast') continue;
    messages.push({
      time: new Date(Number(m.ts) * 1000).toISOString(),
      author: m.user ? await getUserName(client, m.user) : m.username || 'bot',
      text: m.text,
      ...(m.reply_count ? { replies: m.reply_count } : {}),
    });
  }

  return { channel: `<#${channel}>`, channelName: info.name, count: messages.length, messages };
}

async function joinChannel(args, ctx) {
  const { client } = ctx;
  const channel = await resolveChannelId(client, args.channel);
  try {
    const res = await client.conversations.join({ channel });
    return { joined: true, channel: `<#${channel}>`, alreadyMember: Boolean(res.already_in_channel) };
  } catch (err) {
    if (err.data?.error === 'method_not_supported_for_channel_type') {
      return { error: 'That is a private channel. Someone in it must run /invite @Lori AI.' };
    }
    throw err;
  }
}

/**
 * Dispatches a Slack tool call. Returns a JSON string for the OpenAI tool message.
 */
async function executeSlackTool(toolName, args, ctx) {
  switch (toolName) {
    case 'read_channel_history':
      return JSON.stringify(await readChannelHistory(args, ctx));
    case 'join_channel':
      return JSON.stringify(await joinChannel(args, ctx));
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

module.exports = { SLACK_TOOLS, SLACK_TOOL_NAMES, executeSlackTool };
