/**
 * sfTools.js
 *
 * Defines the OpenAI tool (function calling) schemas and their execution logic
 * for Salesforce read operations. These tools are passed to the OpenAI API so the
 * AI can decide which Salesforce operation to invoke based on user intent.
 *
 * Flow:
 *   1. OpenAI receives user message + tool definitions
 *   2. OpenAI returns tool_calls if it needs data from Salesforce
 *   3. executeTool() dispatches to the correct salesforce.js function
 *   4. Results are fed back to OpenAI for the final natural-language response
 *
 * Read tools execute immediately. The update_record tool never writes directly — it queues the change
 * in ctx.pendingEdits so app.js can show a confirmation card with Save/Cancel buttons.
 */

const {
  describeObject,
  getDescribe,
  runSOQL,
  runSOSL,
  getRecord,
  getActivityHistory,
  getCaseDetails,
  queryCases,
} = require('./salesforce');

// Objects searched when the user gives a keyword without naming an object
const DEFAULT_SEARCH_OBJECTS = ['Account', 'Contact', 'Lead', 'Opportunity', 'Case'];

/**
 * OpenAI tool schema definitions.
 * Each entry maps to one Salesforce operation. The AI uses the name and description
 * to decide when to call a tool, and the parameters schema to construct the arguments.
 *
 * @type {Array<Object>} Array of OpenAI-compatible tool definitions
 */
const SF_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'describe_salesforce_object',
      description:
        'Fetches the field schema (field names, types, labels, picklist values, updateable) for a Salesforce object. ' +
        'Call this for custom objects/fields you are unsure about, when a query fails on an invalid field, ' +
        'or before updating a record. Not needed for well-known standard fields. ' +
        'Supported objects include: Contact, Lead, Opportunity, Task, Event, Project__c, Account, Case, and others.',
      parameters: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'The Salesforce API name of the object to describe (e.g. "Contact", "Project__c").',
          },
        },
        required: ['object_name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'query_records',
      description:
        'Executes a SOQL query against Salesforce and returns matching records. ' +
        'Use this for structured filters (status, stage, dates, owner, amount, etc.). ' +
        'Always SELECT Id plus the Name field (or CaseNumber/Subject) and the fields relevant to the question. ' +
        'Results are shown to the user as record cards automatically.',
      parameters: {
        type: 'object',
        properties: {
          soql: {
            type: 'string',
            description:
              'A valid SOQL query string. Example: "SELECT Id, Name, Email FROM Contact WHERE Name LIKE \'%John%\' LIMIT 10"',
          },
        },
        required: ['soql'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'search_records',
      description:
        'Performs a keyword search across one or more Salesforce objects using SOSL. ' +
        'Best for finding records when you only have a name or partial keyword and do not know the exact field. ' +
        'Never ask the user which object to search — infer it, or omit object_names to search the common objects.',
      parameters: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'The keyword or phrase to search for (e.g. "John Doe", "Project Alpha").',
          },
          object_names: {
            type: 'array',
            items: { type: 'string' },
            description: `List of Salesforce object API names to search within, e.g. ["Contact", "Lead"]. Defaults to ${JSON.stringify(DEFAULT_SEARCH_OBJECTS)} when omitted.`,
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of records to return per object. Defaults to 10.',
          },
        },
        required: ['search_term'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_record_details',
      description:
        'Fetches the full details of a single Salesforce record by its Id. ' +
        'Use this after search_records or query_records returns an Id, to get more complete information.',
      parameters: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'The Salesforce API name of the object (e.g. "Contact", "Opportunity").',
          },
          record_id: {
            type: 'string',
            description: 'The 15 or 18-character Salesforce record Id.',
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of field API names to retrieve. If omitted, Salesforce returns all readable fields.',
          },
        },
        required: ['object_name', 'record_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_case_details',
      description:
        'Fetches the details of a Salesforce Case record by its Id, including status, priority, subject, description, ' +
        'account, contact, and owner. Use this when a user asks about a specific support case or ticket.',
      parameters: {
        type: 'object',
        properties: {
          case_id: {
            type: 'string',
            description: 'The 15 or 18-character Salesforce Case record Id.',
          },
        },
        required: ['case_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'query_cases',
      description:
        'Queries Salesforce Case records with optional filters. ' +
        'Use this when a user asks to list, search, or filter support cases — e.g. by status, priority, account, or contact. ' +
        'If no filters are specified, returns the most recently created open cases.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by case status (e.g. "New", "Working", "Escalated", "Closed"). Omit to include all statuses.',
          },
          priority: {
            type: 'string',
            description: 'Filter by priority (e.g. "High", "Medium", "Low"). Omit to include all priorities.',
          },
          account_name: {
            type: 'string',
            description: 'Filter by account name (partial match supported).',
          },
          contact_name: {
            type: 'string',
            description: 'Filter by contact name (partial match supported).',
          },
          subject_keyword: {
            type: 'string',
            description: 'Filter by keyword in the case subject.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of cases to return. Defaults to 10.',
          },
        },
        required: [],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_activity_history',
      description:
        'Retrieves the activity history (Tasks and Events) linked to a Salesforce record. ' +
        'Use this when a user asks about past interactions, calls, meetings, or emails related to a record.',
      parameters: {
        type: 'object',
        properties: {
          record_id: {
            type: 'string',
            description: 'The Salesforce record Id to fetch activities for.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of activities to return. Defaults to 20.',
          },
        },
        required: ['record_id'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'update_record',
      description:
        'Proposes an edit to fields of an existing Salesforce record. The change is NOT saved immediately: ' +
        'the user gets a confirmation card with Save/Cancel buttons. Find the record Id first (query/search) ' +
        'and use exact field API names and valid picklist values (describe_salesforce_object if unsure). ' +
        'Do not ask the user for confirmation in text — the card is the confirmation.',
      parameters: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'The Salesforce API name of the object (e.g. "Opportunity").',
          },
          record_id: {
            type: 'string',
            description: 'The 15 or 18-character Salesforce record Id.',
          },
          fields: {
            type: 'object',
            description:
              'Map of field API name to new value, e.g. {"StageName": "Closed Won", "Amount": 150000000}. ' +
              'Dates use YYYY-MM-DD. Use null to clear a field.',
          },
        },
        required: ['object_name', 'record_id', 'fields'],
      },
    },
  },
];

/**
 * Dispatches an OpenAI tool call to the corresponding Salesforce function.
 * Called inside the tool-calling loop in app.js after OpenAI returns tool_calls.
 *
 * @param {string} toolName - The name of the tool as defined in SF_TOOLS (e.g. "query_records")
 * @param {Object} args - The parsed arguments object from OpenAI's tool_call
 * @param {Object} ctx - Per-request context; update_record pushes proposals into ctx.pendingEdits
 * @returns {Promise<string>} JSON string of the tool result, to be sent back to OpenAI
 * @throws {Error} If the tool name is unknown or the underlying SF call fails
 */
async function executeTool(toolName, args, ctx) {
  switch (toolName) {
    case 'describe_salesforce_object': {
      const result = await describeObject(args.object_name);
      return JSON.stringify(result);
    }

    case 'query_records': {
      const result = await runSOQL(args.soql);
      return JSON.stringify(result);
    }

    case 'search_records': {
      const result = await runSOSL(
        args.search_term,
        args.object_names?.length ? args.object_names : DEFAULT_SEARCH_OBJECTS,
        args.limit || 10
      );
      return JSON.stringify(result);
    }

    case 'get_record_details': {
      const result = await getRecord(
        args.object_name,
        args.record_id,
        args.fields || []
      );
      return JSON.stringify(result);
    }

    case 'get_case_details': {
      const result = await getCaseDetails(args.case_id);
      return JSON.stringify(result);
    }

    case 'query_cases': {
      const result = await queryCases({
        status: args.status,
        priority: args.priority,
        accountName: args.account_name,
        contactName: args.contact_name,
        subjectKeyword: args.subject_keyword,
        limit: args.limit || 10,
      });
      return JSON.stringify(result);
    }

    case 'get_activity_history': {
      const result = await getActivityHistory(
        args.record_id,
        args.limit || 20
      );
      return JSON.stringify(result);
    }

    case 'update_record':
      return JSON.stringify(await proposeUpdate(args, ctx));

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

/**
 * Validates a proposed record edit against the object describe and queues it for user confirmation.
 * Returns errors to the AI (instead of throwing) so it can correct field names or values and retry.
 *
 * @param {Object} args - { object_name, record_id, fields }
 * @param {Object} ctx - Per-request context holding the pendingEdits array
 * @returns {Promise<Object>} Status payload for the AI
 */
async function proposeUpdate({ object_name, record_id, fields }, ctx) {
  const entries = Object.entries(fields || {});
  if (entries.length === 0) return { error: 'No fields to update were provided.' };

  const describe = await getDescribe(object_name);
  const fieldMap = new Map(describe.fields.map(f => [f.name.toLowerCase(), f]));

  const changes = {};
  const problems = [];
  for (const [name, value] of entries) {
    const meta = fieldMap.get(name.toLowerCase());
    if (!meta) problems.push(`${name}: field does not exist on ${object_name}`);
    else if (!meta.updateable) problems.push(`${meta.name}: field is read-only`);
    else if (meta.type === 'picklist' && value !== null && !meta.picklistValues.some(v => v.active && v.value === value))
      problems.push(
        `${meta.name}: "${value}" is not a valid value. Valid: ${meta.picklistValues
          .filter(v => v.active)
          .map(v => v.value)
          .join(', ')}`
      );
    else changes[meta.name] = value;
  }
  if (problems.length > 0) return { error: 'Invalid update', problems };

  // Fetch current values so the confirmation card can show before → after
  const current = await getRecord(object_name, record_id, [
    ...new Set([...Object.keys(changes), describe.fields.find(f => f.nameField)?.name || 'Id']),
  ]);

  ctx.pendingEdits.push({ objectName: describe.name, recordId: current.Id || record_id, changes, current });
  return {
    status: 'awaiting_user_confirmation',
    message: 'A confirmation card with Save/Cancel buttons is shown to the user. Tell them to review and click Save.',
  };
}

module.exports = { SF_TOOLS, executeTool };
