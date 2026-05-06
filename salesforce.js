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
  const token = await getSalesforceToken();
  const url = `${sfUrl}/services/data/${SF_API_VERSION}/sobjects/${objectName}/describe`;

  const response = await fetch(url, { headers: buildHeaders(token) });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Describe failed for ${objectName}: ${errorText}`);
  }

  const data = await response.json();

  // Return only the fields relevant for query construction — avoids overwhelming the AI context
  return {
    name: data.name,
    label: data.label,
    fields: data.fields.map(f => ({
      name: f.name,
      label: f.label,
      type: f.type,
      // Include reference info so AI knows which objects a lookup field points to
      referenceTo: f.referenceTo || [],
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

  // Build the RETURNING clause — each object returns Id and Name by default
  const returningClause = objectNames
    .map(obj => `${obj}(Id, Name)`)
    .join(', ');

  // SOSL syntax: FIND {term} IN ALL FIELDS RETURNING Object1(...), Object2(...)
  const sosl = `FIND {${searchTerm}} IN ALL FIELDS RETURNING ${returningClause} LIMIT ${limit}`;
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

module.exports = {
  getSalesforceToken,
  describeObject,
  runSOQL,
  runSOSL,
  getRecord,
  getActivityHistory,
  getCaseDetails,
  queryCases,
};
