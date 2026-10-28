/**
 * pending.js
 *
 * In-memory store for writes that wait for a Save/Cancel click (canvas and list edits). Slack button values are
 * limited to 2000 characters, so the button carries only an id; the payload stays here for 30 minutes.
 *
 * The bot runs as a single process, so memory is enough. A restart drops pending items; the user is told to ask again.
 */

const crypto = require('node:crypto');

const TTL_MS = 30 * 60 * 1000;
const store = new Map();

function prune() {
  const now = Date.now();
  for (const [id, entry] of store) if (entry.expiresAt <= now) store.delete(id);
}

/**
 * Stores a pending write.
 *
 * @param {Object} entry - { kind, requesterId, channel, ... } plus whatever the apply step needs
 * @returns {string} Id to put in the button value
 */
function put(entry) {
  prune();
  const id = crypto.randomBytes(6).toString('hex');
  store.set(id, { ...entry, expiresAt: Date.now() + TTL_MS });
  return id;
}

/**
 * Looks up a pending write without removing it.
 *
 * @param {string} id
 * @returns {Object|null}
 */
function peek(id) {
  prune();
  return store.get(id) || null;
}

/**
 * Removes and returns a pending write (null when unknown or expired).
 *
 * @param {string} id
 * @returns {Object|null}
 */
function take(id) {
  const entry = peek(id);
  store.delete(id);
  return entry;
}

module.exports = { put, peek, take, TTL_MS };
