/**
 * salesforce.js
 *
 * Central module for all Salesforce REST API interactions.
 * Uses username-password OAuth flow with a single shared service account.
 * All functions require a valid access token obtained via getSalesforceToken().
 *
 * Salesforce API version: v59.0
 */

const fetch = require('node-fetch');

// Base Salesforce instance URL — shared with app.js via env or direct import
const sfUrl = process.env.SF_URL || 'https://langitkreasisolusindo.my.salesforce.com';
const SF_API_VERSION = 'v59.0';

/**
 * Obtains a Salesforce access token using the username-password OAuth flow.
 * Token is short-lived and should be fetched fresh per operation (not cached).
 *
 * @returns {Promise<string>} Salesforce access token
 * @throws {Error} If the OAuth request fails
 */
async function getSalesforceToken() {
  const tokenUrl =
    `${sfUrl}/services/oauth2/token` +
    `?grant_type=password` +
    `&client_id=${process.env.SALESFORCE_CLIENT_ID}` +
    `&client_secret=${process.env.SALESFORCE_CLIENT_SECRET}` +
    `&username=${process.env.SALESFORCE_USER_NAME}` +
    `&password=${process.env.SALESFORCE_USER_PASS}`;

  const response = await fetch(tokenUrl, { method: 'POST' });

  if (!response.ok) {
    throw new Error(`Salesforce token error: ${response.statusText}`);
  }

  const data = await response.json();
  return data.access_token;
}

/**
 * Builds the standard Authorization header for Salesforce REST API calls.
 *
 * @param {string} token - Salesforce access token
 * @returns {Object} Headers object with Authorization and Content-Type
 */
function buildHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

// Describe results rarely change — cache them in memory to avoid an extra round-trip per request
const DESCRIBE_TTL_MS = 10 * 60 * 1000;
const describeCache = new Map();

/**
 * Fetches the raw Describe API result for an object, served from an in-memory cache when fresh.
 * Used by both the AI-facing describeObject() and the Slack record renderer (labels, types, editability).
 *
 * @param {string} objectName - API name of the Salesforce object
 * @returns {Promise<Object>} Raw describe payload from Salesforce
 * @throws {Error} If the describe call fails or object does not exist
 */
async function getDescribe(objectName) {
  const cached = describeCache.get(objectName);
  if (cached && Date.now() - cached.at < DESCRIBE_TTL_MS) return cached.data;

  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}/describe`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Describe failed for ${objectName}: ${errorText}`);
  }

  const data = await response.json();
  describeCache.set(objectName, { at: Date.now(), data });
  return data;
}

/**
 * Fetches the field metadata for a given Salesforce object using the Describe API.
 * The AI uses this to discover available fields before constructing SOQL queries,
 * avoiding hardcoded schema assumptions.
 *
 * @param {string} objectName - API name of the Salesforce object (e.g. "Contact", "Project__c")
 * @returns {Promise<Object>} Object containing name, label, and array of fields with their names/types/labels
 * @throws {Error} If the describe call fails or object does not exist
 */
async function describeObject(objectName) {
  const data = await getDescribe(objectName);

  // Return only the fields relevant for query construction — avoids overwhelming the AI context
  return {
    name: data.name,
    label: data.label,
    fields: data.fields.map(f => ({
      name: f.name,
      label: f.label,
      type: f.type,
      updateable: f.updateable,
      // Include reference info so AI knows which objects a lookup field points to
      referenceTo: f.referenceTo || [],
      // Active picklist values let the AI filter/update with valid values (e.g. StageName)
      ...(f.type === 'picklist' || f.type === 'multipicklist'
        ? { picklistValues: f.picklistValues.filter(v => v.active).slice(0, 40).map(v => v.value) }
        : {}),
    })),
  };
}

/**
 * Executes a SOQL query against Salesforce and returns all matching records.
 * The caller (AI) is responsible for constructing a valid SOQL string.
 *
 * @param {string} soql - Full SOQL query string (e.g. "SELECT Id, Name FROM Contact WHERE ...")
 * @returns {Promise<Object>} Object with totalSize and records array
 * @throws {Error} If the query is invalid or the API call fails
 */
async function runSOQL(soql) {
  const token = await getSalesforceToken();

  // Encode the SOQL string for use as a URL query parameter
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SOQL query failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    totalSize: data.totalSize,
    records: data.records,
  };
}

// Useful display fields per object for SOSL results (defaults to "Id, Name")
const SOSL_RETURN_FIELDS = {
  Account: 'Id, Name, Type, Industry, Owner.Name',
  Contact: 'Id, Name, Title, Email, Phone, Account.Name',
  Lead: 'Id, Name, Company, Status, Email',
  Opportunity: 'Id, Name, StageName, Amount, CloseDate, Account.Name',
  Case: 'Id, CaseNumber, Subject, Status, Priority',
  Task: 'Id, Subject, Status, ActivityDate',
  Event: 'Id, Subject, StartDateTime',
};

/**
 * Executes a SOSL (Salesforce Object Search Language) search across one or more objects.
 * SOSL is better than SOQL for keyword searches because it searches across all text fields
 * simultaneously without needing to know the exact field name.
 *
 * @param {string} searchTerm - The keyword to search for (e.g. "John Doe")
 * @param {string[]} objectNames - Array of object API names to search within (e.g. ["Contact", "Lead"])
 * @param {number} [limit=10] - Max records to return per object
 * @returns {Promise<Object[]>} Array of { objectName, records } for each searched object
 * @throws {Error} If the search fails
 */
async function runSOSL(searchTerm, objectNames, limit = 10) {
  const token = await getSalesforceToken();

  // Build the RETURNING clause — objects without a Name field return their own identifying fields
  const returningClause = objectNames
    .map(obj => `${obj}(${SOSL_RETURN_FIELDS[obj] || 'Id, Name'})`)
    .join(', ');

  // SOSL reserved characters must be escaped inside FIND {...}
  const escapedTerm = searchTerm.replace(/([?&|!{}[\]()^~*:\\"'+-])/g, '\\$1');

  // SOSL syntax: FIND {term} IN ALL FIELDS RETURNING Object1(...), Object2(...)
  const sosl = `FIND {${escapedTerm}} IN ALL FIELDS RETURNING ${returningClause} LIMIT ${limit}`;
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/search?q=${encodeURIComponent(sosl)}`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SOSL search failed: ${errorText}`);
  }

  const data = await response.json();

  // Normalize the response into a consistent shape regardless of how many objects were searched
  return data.searchRecords
    ? [{ objectName: 'mixed', records: data.searchRecords }]
    : objectNames.map((name, i) => ({
        objectName: name,
        records: data[i] || [],
      }));
}

/**
 * Fetches the full field values of a single Salesforce record by its Id.
 * The caller should first call describeObject() to know which fields to request,
 * or pass '*' to let Salesforce return all readable fields.
 *
 * @param {string} objectName - API name of the Salesforce object
 * @param {string} recordId - 15 or 18-character Salesforce record Id
 * @param {string[]} [fields] - Optional list of field names to retrieve; defaults to common fields
 * @returns {Promise<Object>} The record data as returned by Salesforce
 * @throws {Error} If the record is not found or access is denied
 */
async function getRecord(objectName, recordId, fields = []) {
  const token = await getSalesforceToken();

  // If specific fields are requested, append as query param; otherwise fetch all via SOQL
  const fieldParam = fields.length > 0 ? `?fields=${fields.join(',')}` : '';
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}/${recordId}${fieldParam}`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Get record failed for ${objectName}/${recordId}: ${errorText}`);
  }

  return await response.json();
}

/**
 * Updates fields on a single Salesforce record (PATCH). Salesforce returns 204 No Content on success.
 *
 * @param {string} objectName - API name of the Salesforce object
 * @param {string} recordId - 15 or 18-character Salesforce record Id
 * @param {Object} fields - Map of field API name → new value (null clears the field)
 * @returns {Promise<void>}
 * @throws {Error} If validation fails or access is denied
 */
async function updateRecord(objectName, recordId, fields) {
  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}/${recordId}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Salesforce errors come as [{ message, errorCode, fields }] — surface the message only
    let message = errorText;
    try {
      message = JSON.parse(errorText).map(e => e.message).join('; ');
    } catch (_) {}
    throw new Error(`Update failed for ${objectName}/${recordId}: ${message}`);
  }
}

/**
 * Creates a record (POST). Returns the new record Id.
 *
 * @param {string} objectName - API name of the Salesforce object (e.g. "Task")
 * @param {Object} fields - Field API name → value
 * @returns {Promise<string>} New record Id
 * @throws {Error} If validation fails or access is denied
 */
async function createRecord(objectName, fields) {
  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}`;

  const response = await fetch(url, { method: 'POST', headers: buildHeaders(token), body: JSON.stringify(fields) });

  if (!response.ok) {
    const errorText = await response.text();
    let message = errorText;
    try {
      message = JSON.parse(errorText).map(e => `${e.errorCode}: ${e.message}`).join('; ');
    } catch (_) {}
    throw new Error(`Create ${objectName} failed: ${message}`);
  }

  return (await response.json()).id;
}

/**
 * Deletes a record (used to undo an activity logged from Slack).
 *
 * @param {string} objectName - API name of the Salesforce object
 * @param {string} recordId - Record Id
 * @throws {Error} If the delete fails
 */
async function deleteRecord(objectName, recordId) {
  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}/${recordId}`;

  const response = await fetch(url, { method: 'DELETE', headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Delete ${objectName}/${recordId} failed: ${errorText}`);
  }
}

/**
 * Finds the active Salesforce User Id for an email (to attribute Slack actions to the right person).
 *
 * @param {string} email - Email from the Slack profile
 * @returns {Promise<string|null>} User Id, or null when no active user matches
 */
async function findUserIdByEmail(email) {
  if (!email) return null;
  const { records } = await runSOQL(
    `SELECT Id FROM User WHERE IsActive = true AND (Email = '${escapeSoql(email)}' OR Username = '${escapeSoql(email)}') LIMIT 1`
  );
  return records[0]?.Id || null;
}

let closedTaskStatus = null;

/**
 * The org's "completed" Task status (e.g. "Completed"), looked up once from TaskStatus.
 *
 * @returns {Promise<string>}
 */
async function getClosedTaskStatus() {
  if (closedTaskStatus) return closedTaskStatus;
  const { records } = await runSOQL(
    'SELECT ApiName FROM TaskStatus WHERE IsClosed = true ORDER BY SortOrder LIMIT 1'
  );
  closedTaskStatus = records[0]?.ApiName || 'Completed';
  return closedTaskStatus;
}

/**
 * Retrieves the activity history (Tasks and Events) associated with a Salesforce record.
 * Activities are linked via WhatId (for non-person objects) or WhoId (for Contacts/Leads).
 * This function queries both Task and Event objects to give a full timeline.
 *
 * @param {string} recordId - Salesforce record Id to fetch activities for
 * @param {number} [limit=20] - Max number of activities to return
 * @returns {Promise<Object>} Object with tasks and events arrays, each sorted by date descending
 * @throws {Error} If the query fails
 */
async function getActivityHistory(recordId, limit = 20) {
  const token = await getSalesforceToken();

  // Query Tasks linked to this record — covers calls, emails, to-dos
  const taskSOQL = `
    SELECT Id, Subject, Status, Priority, ActivityDate, Description, Owner.Name
    FROM Task
    WHERE WhatId = '${recordId}' OR WhoId = '${recordId}'
    ORDER BY ActivityDate DESC
    LIMIT ${limit}
  `;

  // Query Events linked to this record — covers meetings, calls logged as events
  const eventSOQL = `
    SELECT Id, Subject, StartDateTime, EndDateTime, Description, Owner.Name
    FROM Event
    WHERE WhatId = '${recordId}' OR WhoId = '${recordId}'
    ORDER BY StartDateTime DESC
    LIMIT ${limit}
  `;

  const taskUrl = `${sfUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(taskSOQL)}`;
  const eventUrl = `${sfUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(eventSOQL)}`;

  // Fetch both in parallel to reduce latency
  const [taskResponse, eventResponse] = await Promise.all([
    fetch(taskUrl, { headers: buildHeaders(token) }),
    fetch(eventUrl, { headers: buildHeaders(token) }),
  ]);

  const taskData = taskResponse.ok ? await taskResponse.json() : { records: [] };
  const eventData = eventResponse.ok ? await eventResponse.json() : { records: [] };

  return {
    tasks: taskData.records,
    events: eventData.records,
  };
}

/**
 * Fetches the full details of a Salesforce Case record by its Id.
 * Returns key fields: CaseNumber, Subject, Status, Priority, Description,
 * Account, Contact, Owner, and timestamps.
 *
 * @param {string} caseId - 15 or 18-character Salesforce Case record Id
 * @returns {Promise<Object>} The Case record data
 * @throws {Error} If the record is not found or access is denied
 */
async function getCaseDetails(caseId) {
  const fields = [
    'Id', 'CaseNumber', 'Subject', 'Status', 'Priority', 'Origin',
    'Description', 'Resolution__c',
    'AccountId', 'Account.Name',
    'ContactId', 'Contact.Name', 'Contact.Email',
    'OwnerId', 'Owner.Name',
    'CreatedDate', 'LastModifiedDate', 'ClosedDate',
    'IsEscalated', 'Type', 'Reason',
  ];

  const soql = `SELECT ${fields.join(', ')} FROM Case WHERE Id = '${caseId}' LIMIT 1`;
  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Get case failed for ${caseId}: ${errorText}`);
  }

  const data = await response.json();

  if (!data.records || data.records.length === 0) {
    throw new Error(`Case not found: ${caseId}`);
  }

  return data.records[0];
}

/**
 * Queries Salesforce Case records with optional filters.
 * Builds a dynamic SOQL query based on the provided filter options.
 *
 * @param {Object} options - Filter options
 * @param {string} [options.status] - Filter by case status (e.g. "New", "Closed")
 * @param {string} [options.priority] - Filter by priority (e.g. "High", "Low")
 * @param {string} [options.accountName] - Filter by account name (partial match)
 * @param {string} [options.contactName] - Filter by contact name (partial match)
 * @param {string} [options.subjectKeyword] - Filter by keyword in subject
 * @param {number} [options.limit=10] - Max records to return
 * @returns {Promise<Object>} Object with totalSize and records array
 * @throws {Error} If the query fails
 */
async function queryCases({ status, priority, accountName, contactName, subjectKeyword, limit = 10 } = {}) {
  const conditions = [];

  if (status) conditions.push(`Status = '${status}'`);
  if (priority) conditions.push(`Priority = '${priority}'`);
  if (accountName) conditions.push(`Account.Name LIKE '%${accountName}%'`);
  if (contactName) conditions.push(`Contact.Name LIKE '%${contactName}%'`);
  if (subjectKeyword) conditions.push(`Subject LIKE '%${subjectKeyword}%'`);

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const soql = `
    SELECT Id, CaseNumber, Subject, Status, Priority, Origin, Type,
           Account.Name, Contact.Name, Owner.Name, CreatedDate, IsEscalated
    FROM Case
    ${whereClause}
    ORDER BY CreatedDate DESC
    LIMIT ${limit}
  `;

  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Case query failed: ${errorText}`);
  }

  const data = await response.json();
  return {
    totalSize: data.totalSize,
    records: data.records,
  };
}

// Opportunity fields used for deal analysis (kept only when present/visible in the org)
const INSIGHT_OPP_FIELDS = [
  'Id', 'Name', 'Account.Name', 'OwnerId', 'Owner.Name', 'StageName', 'Amount', 'Probability', 'ExpectedRevenue',
  'CloseDate', 'ForecastCategoryName', 'NextStep', 'Description', 'Type', 'LeadSource', 'CreatedDate',
  'LastActivityDate', 'IsClosed', 'IsWon',
];

// Field types worth sending to the AI for discovery records
const DISCOVERY_FIELD_TYPES = new Set([
  'string', 'textarea', 'picklist', 'multipicklist', 'boolean', 'date', 'datetime', 'double', 'currency', 'percent', 'int',
]);

// "Discovery Information" section of the Opportunity layout
const DISCOVERY_FIELDS = [
  'Salesforce_Implementation_Objective__c',
  'Current_Tools__c',
  'Integration__c',
  'Expected_Impact__c',
  'Implementation_Timeline__c',
  'Standard_Business_Process__c',
  'Quip_Link__c',
  'Discovery_Check__c',
];

const DISCOVERY_PATTERN = /discover/i;

// Known fields keep their layout order; auto-detected ones come after
const discoveryRank = name => (DISCOVERY_FIELDS.includes(name) ? DISCOVERY_FIELDS.indexOf(name) : DISCOVERY_FIELDS.length);
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeSoql = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Today as YYYY-MM-DD in Jakarta time, so "days to close" matches what users see
const todayJakarta = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

// Rich text fields come back as HTML — reduce to plain text lines for the AI
const htmlToText = value =>
  typeof value === 'string' && /<[a-z][\s\S]*>/i.test(value)
    ? value
        .replace(/<br\s*\/?>|<\/(p|li|div)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{2,}/g, '\n')
        .trim()
    : value;

const trimText = (value, max = 500) => {
  const text = htmlToText(value);
  return typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Finds Opportunity candidates by partial name (used when the user gives a name instead of an Id).
 *
 * @param {string} name - Partial opportunity name
 * @returns {Promise<Object[]>} Up to 5 matching opportunities
 */
async function findOpportunitiesByName(name) {
  const { records } = await runSOQL(
    `SELECT Id, Name, Account.Name, StageName, Amount, CloseDate FROM Opportunity
     WHERE Name LIKE '%${escapeSoql(name)}%' ORDER BY IsClosed ASC, CloseDate DESC LIMIT 5`
  );
  return records;
}

/**
 * Loads discovery data of an opportunity: Opportunity fields whose name/label mentions "discovery",
 * plus records of child objects whose name mentions "discovery" (e.g. Discovery__c with a lookup to Opportunity).
 */
async function getDiscoveryData(oppDescribe, oppId) {
  // Known discovery fields first, then any other field whose name/label mentions "discovery"
  const fieldNames = oppDescribe.fields
    .filter(f => DISCOVERY_FIELDS.includes(f.name) || DISCOVERY_PATTERN.test(f.name) || DISCOVERY_PATTERN.test(f.label))
    .sort((a, b) => discoveryRank(a.name) - discoveryRank(b.name))
    .map(f => f.name);

  const relationships = (oppDescribe.childRelationships || []).filter(
    r => r.relationshipName && (DISCOVERY_PATTERN.test(r.childSObject) || DISCOVERY_PATTERN.test(r.relationshipName))
  );

  const related = [];
  for (const rel of relationships.slice(0, 3)) {
    try {
      const childDescribe = await getDescribe(rel.childSObject);
      const fields = childDescribe.fields
        .filter(f => DISCOVERY_FIELD_TYPES.has(f.type) && !f.name.startsWith('System') && f.name !== 'IsDeleted')
        .slice(0, 25)
        .map(f => f.name);
      const { records } = await runSOQL(
        `SELECT Id, ${[...new Set(['Name', ...fields])].filter(f => childDescribe.fields.some(d => d.name === f)).join(', ')} ` +
          `FROM ${rel.childSObject} WHERE ${rel.field} = '${oppId}' ORDER BY CreatedDate DESC LIMIT 10`
      );
      related.push({
        object: childDescribe.label,
        records: records.map(({ attributes, ...rest }) =>
          Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, trimText(v)]))
        ),
      });
    } catch (_) {
      // Child object not queryable for this user — skip it
    }
  }

  return { fieldNames, related };
}

/**
 * Gathers everything needed to judge an opportunity's health and recommend next actions:
 * key fields (amount, close date, stage), discovery data, Tasks/Events and stage/close-date history,
 * plus pre-computed signals so the AI does not have to do date math.
 *
 * @param {string} oppId - 15 or 18-character Opportunity Id
 * @returns {Promise<Object>} { opportunity, discovery, activities, history, signals }
 * @throws {Error} If the opportunity is not found
 */
async function getOpportunityInsights(oppId) {
  const describe = await getDescribe('Opportunity');
  const available = new Set(describe.fields.map(f => f.name));
  const relationshipNames = new Set(describe.fields.map(f => f.relationshipName).filter(Boolean));

  const discoveryMeta = await getDiscoveryData(describe, oppId);
  const fields = [...INSIGHT_OPP_FIELDS, ...discoveryMeta.fieldNames].filter(f =>
    f.includes('.') ? relationshipNames.has(f.split('.')[0]) : available.has(f)
  );

  const oppResult = await runSOQL(`SELECT ${[...new Set(fields)].join(', ')} FROM Opportunity WHERE Id = '${escapeSoql(oppId)}'`);
  const opportunity = oppResult.records[0];
  if (!opportunity) throw new Error(`Opportunity not found: ${oppId}`);

  const [tasks, events, history] = await Promise.all([
    runSOQL(
      `SELECT Id, Subject, Status, IsClosed, Priority, ActivityDate, Type, TaskSubtype, Description,
              Who.Name, Owner.Name, CreatedDate
       FROM Task WHERE WhatId = '${opportunity.Id}' ORDER BY CreatedDate DESC LIMIT 30`
    ).then(r => r.records, () => []),
    runSOQL(
      `SELECT Id, Subject, StartDateTime, EndDateTime, Type, Description, Who.Name, Owner.Name
       FROM Event WHERE WhatId = '${opportunity.Id}' ORDER BY StartDateTime DESC LIMIT 30`
    ).then(r => r.records, () => []),
    runSOQL(
      `SELECT CreatedDate, StageName, Amount, CloseDate, Probability FROM OpportunityHistory
       WHERE OpportunityId = '${opportunity.Id}' ORDER BY CreatedDate DESC LIMIT 50`
    ).then(r => r.records.reverse(), () => []),
  ]);

  const today = todayJakarta();
  const now = Date.now();

  // Completed interactions: closed tasks (dated by due date or creation) and events that already started
  const pastDates = [
    ...tasks.filter(t => t.IsClosed).map(t => t.ActivityDate || t.CreatedDate.slice(0, 10)),
    ...events.filter(e => Date.parse(e.StartDateTime) <= now).map(e => e.StartDateTime.slice(0, 10)),
  ].sort();
  const lastActivityDate = pastDates[pastDates.length - 1] || opportunity.LastActivityDate || null;

  const upcomingTasks = tasks.filter(t => !t.IsClosed && (!t.ActivityDate || t.ActivityDate >= today));
  const overdueTasks = tasks.filter(t => !t.IsClosed && t.ActivityDate && t.ActivityDate < today);
  const upcomingEvents = events.filter(e => Date.parse(e.StartDateTime) > now);

  // Count how often the close date was moved later, and how long the deal sits in its current stage
  let closeDatePushes = 0;
  let stageSince = opportunity.CreatedDate?.slice(0, 10);
  for (let i = 1; i < history.length; i++) {
    if (history[i].CloseDate && history[i - 1].CloseDate && history[i].CloseDate > history[i - 1].CloseDate)
      closeDatePushes++;
    if (history[i].StageName !== history[i - 1].StageName) stageSince = history[i].CreatedDate.slice(0, 10);
  }

  // Keyed by field label so the AI reads "Current Tools" rather than API names
  const labelOf = name => describe.fields.find(f => f.name === name)?.label || name;
  const discoveryFields = Object.fromEntries(
    discoveryMeta.fieldNames.map(f => [labelOf(f), trimText(opportunity[f], 1500)])
  );
  const filledDiscoveryFields = Object.values(discoveryFields).filter(v => v !== null && v !== '' && v !== false);

  const signals = {
    today,
    daysToClose: opportunity.CloseDate ? daysBetween(today, opportunity.CloseDate) : null,
    closeDatePassedWhileOpen: Boolean(!opportunity.IsClosed && opportunity.CloseDate && opportunity.CloseDate < today),
    closeDatePushes,
    daysInCurrentStage: stageSince ? daysBetween(stageSince, today) : null,
    ageDays: opportunity.CreatedDate ? daysBetween(opportunity.CreatedDate.slice(0, 10), today) : null,
    amountMissing: opportunity.Amount === null || opportunity.Amount === undefined,
    lastActivityDate,
    daysSinceLastActivity: lastActivityDate ? daysBetween(lastActivityDate, today) : null,
    activitiesLast30Days: pastDates.filter(d => daysBetween(d, today) <= 30).length,
    upcomingActivities: upcomingTasks.length + upcomingEvents.length,
    overdueTasks: overdueTasks.length,
    discoveryFieldsFound: discoveryMeta.fieldNames.length,
    discoveryFieldsFilled: filledDiscoveryFields.length,
    discoveryRecords: discoveryMeta.related.reduce((sum, r) => sum + r.records.length, 0),
  };

  const compactActivity = ({ attributes, Who, Owner, Description, ...rest }) => ({
    ...rest,
    who: Who?.Name,
    owner: Owner?.Name,
    description: trimText(Description, 300),
  });

  return {
    opportunity,
    discovery: { fields: discoveryFields, related: discoveryMeta.related },
    activities: {
      tasks: tasks.slice(0, 15).map(compactActivity),
      events: events.slice(0, 15).map(compactActivity),
    },
    history: history.map(({ attributes, ...rest }) => rest),
    signals,
  };
}

module.exports = {
  sfUrl,
  htmlToText,
  getSalesforceToken,
  getDescribe,
  describeObject,
  updateRecord,
  runSOQL,
  runSOSL,
  getRecord,
  getActivityHistory,
  createRecord,
  deleteRecord,
  findUserIdByEmail,
  getClosedTaskStatus,
  todayJakarta,
  findOpportunitiesByName,
  getOpportunityInsights,
  getCaseDetails,
  queryCases,
};
