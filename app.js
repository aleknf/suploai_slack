const { App, LogLevel, Assistant } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const { config } = require('dotenv');
const { OpenAI } = require('openai');
// Removed unused ESM import that caused Jest compatibility issues
// const axios = require('axios');
// const pdfParse = require('pdf-parse');
//const mammoth = require('mammoth');
const fetch = require('node-fetch'); //use npm install node-fetch@2

// Salesforce read tools: schema definitions for OpenAI function calling + executor dispatcher
const { SF_TOOLS, executeTool } = require('./sfTools');

//change url for sandbox or prod
const sfUrl = 'https://langitkreasisolusindo.my.salesforce.com';
// const sfUrl = 'https://langitkreasisolusindo--devlks.sandbox.my.salesforce.com';

config();

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
  const date = new Date((timestamp + 7 * 60 * 60) * 1000); // Adjust for timezone
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
  return Math.floor(now.getTime() / 1000) - (7 * 3600); // kurangi 7 jam dalam detik;
}

/**
 * Converts markdown-formatted text from OpenAI into Slack mrkdwn format.
 * Slack does not support standard markdown — it uses its own syntax.
 *
 * Conversions:
 *   **bold**        → *bold*
 *   __bold__        → *bold*
 *   *italic*        → _italic_   (single asterisk)
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

    // Italic: *text* (single) → _text_  (only if not already converted from bold)
    // Use a negative lookbehind/ahead to avoid touching already-converted *bold*
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '_$1_')

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

/**
 * Runs an OpenAI chat completion with Salesforce tool support.
 *
 * This is the core AI loop used by both the Assistant DM thread and the @mention handler.
 * It handles multi-step tool calls: if OpenAI requests a tool, we execute it against
 * Salesforce, append the result, and call OpenAI again — repeating until the AI produces
 * a final text response with no further tool calls.
 *
 * @param {Array<Object>} messages - OpenAI-format message history (system + user + assistant turns)
 * @param {Object} [options] - Optional overrides
 * @param {number} [options.maxIterations=5] - Safety cap to prevent infinite tool loops
 * @returns {Promise<string>} The final assistant text response to send to the user
 * @throws {Error} If OpenAI or any tool call fails
 */
async function runWithTools(messages, { maxIterations = 5 } = {}) {
  let iteration = 0;

  while (iteration < maxIterations) {
    iteration++;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      n: 1,
      messages,
      tools: SF_TOOLS,
      // "auto" lets the model decide whether to call a tool or respond directly
      tool_choice: 'auto',
      temperature: 0.7,
    });

    const choice = response.choices[0];

    // If the model chose to respond directly (no tool calls), return the text
    if (choice.finish_reason === 'stop' || !choice.message.tool_calls) {
      return mdToSlack(choice.message.content);
    }

    // Append the assistant's tool-calling message to the conversation history
    messages.push(choice.message);

    // Execute each tool call the AI requested (may be multiple in one turn)
    for (const toolCall of choice.message.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);

      let toolResult;
      try {
        toolResult = await executeTool(toolName, toolArgs);
      } catch (err) {
        // Return error as a tool result so the AI can explain it to the user
        toolResult = JSON.stringify({ error: err.message });
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
  return 'Sorry, I ran into an issue retrieving that information. Please try again.';
}

/**
 * System prompt sent to OpenAI on every conversation turn.
 * Instructs the AI on its persona, capabilities, and tool usage rules.
 * Keep this concise — it is prepended to every message array and counts toward token usage.
 */
const DEFAULT_SYSTEM_CONTENT = `You are Suplo, an assistant in a Slack workspace for Langit Kreasi Solusindo (LKS).
You help users with general questions AND with querying Salesforce data (Contacts, Leads, Opportunities, Activities, Projects, Cases, and more).

When a user asks about Salesforce records:
- If they do not specify which object (e.g. Contact vs Lead), ask them first before searching.
- Use describe_salesforce_object to discover available fields before writing SOQL queries.
- Use search_records for keyword searches; use query_records for structured filters.
- Present results clearly and concisely — avoid dumping raw JSON.

Formatting rules (IMPORTANT — you are responding in Slack):
- Use *bold* for emphasis (NOT **double asterisk**).
- Use _italic_ for secondary info.
- Use bullet points with • or - for lists.
- Do NOT use markdown headings (# ## ###) — use *bold text* instead.
- Do NOT use [text](url) links — use plain URLs or <url|text> format.
- Keep Slack syntax like <@USER_ID> or <#CHANNEL_ID> as-is.
- Avoid greetings unless explicitly requested.
- Respond professionally unless asked otherwise.`;

// Assistant configuration and event handlers
const assistant = new Assistant({
  threadStarted: async ({ event, logger, say, setSuggestedPrompts, saveThreadContext }) => {
    const { context } = event.assistant_thread;

    try {
      await say('Hi, how can Suplo help?');
      await saveThreadContext();

      const prompts = [
        {
          title: 'This is a suggested prompt',
          message:
            'When a user clicks a prompt, the resulting prompt message text can be passed ' +
            'directly to your LLM for processing.\n\nAssistant, please create some helpful prompts ' +
            'I can provide to my users.',
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
        await say("I'm Suplo, LKS Assistant (Idiot) ready to serve all LKS Members. Suplo is The Man, The Myth, The LEGEND!!");
        return;

      }
      const thread = await client.conversations.replies({
        channel,
        ts: thread_ts,
        oldest: thread_ts,
      });

      // Filter out the initial greeting and keep only the last 10 messages for context
      const threadHistory = thread.messages
        .filter(m => m.text !== 'Hi, sorry Suplo lagi ngehang....')
        .slice(-10)
        .map(m => ({
          role: m.bot_id ? 'assistant' : 'user',
          content: m.text,
        }));

      // Build the message array: system prompt + thread history + current user message
      const messages = [
        { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
        ...threadHistory,
        { role: 'user', content: message.text },
      ];

      // Use the tool-calling loop so the AI can query Salesforce if needed
      const responseContent = await runWithTools(messages);
      await say({ text: responseContent });
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
    app.logger.info('⚡️ Suplo app is running!');
  } catch (error) {
    app.logger.error('Failed to start Suplo', error);
  }
})();

/**
 * Handles @mention events in any channel.
 * Two modes:
 *   1. Summarize — if the user says "summarize" or "summary", fetch recent channel messages
 *      and ask the AI to produce a summary (no Salesforce tools needed here).
 *   2. General — pass the message through the full tool-calling loop so the AI can
 *      answer general questions or query Salesforce as needed.
 */
app.event('app_mention', async ({ event, client, say }) => {
  const messageText = event.text.toLowerCase();
  const isSummarizeRequest = messageText.includes('summarize') || messageText.includes('summary');

  if (isSummarizeRequest) {
    try {
      // Fetch the last 50 messages in the channel to build the summary prompt
      const channelHistory = await client.conversations.history({
        channel: event.channel,
        limit: 50,
      });

      let llmPrompt = `Please generate a brief summary of the following messages from Slack channel <#${event.channel}>:`;
      for (const m of channelHistory.messages.reverse()) {
        if (m.user) llmPrompt += `\n<@${m.user}> says: ${m.text}`;
      }

      // Summarization is a single-shot request — no Salesforce tools needed
      const llmResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        n: 1,
        messages: [
          { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
          { role: 'user', content: llmPrompt },
        ],
      });

      await say({ text: llmResponse.choices[0].message.content });
    } catch (error) {
      console.error('Error summarizing channel:', error);
      await say({ text: 'Sorry, I had trouble summarizing this channel.' });
    }
  } else {
    try {
      // For all other @mentions, run the full tool-calling loop so the AI
      // can query Salesforce if the question requires it
      const messages = [
        { role: 'system', content: DEFAULT_SYSTEM_CONTENT },
        { role: 'user', content: event.text },
      ];

      const responseContent = await runWithTools(messages);
      await say({ text: responseContent });
    } catch (error) {
      console.error('Error handling app_mention:', error);
      await say({ text: 'Sorry, something went wrong processing your request.' });
    }
  }
});


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