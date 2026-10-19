/**
 * googleAuth.js
 *
 * Per-user Google OAuth for reading Drive files. Each Slack user connects their own Google account once;
 * Lori then reads files with that user's permissions (never more than the user can open themselves).
 *
 * - Authorization-code flow with offline access; only the refresh token is stored, encrypted (AES-256-GCM)
 *   in a local JSON file keyed by Slack user Id. Access tokens live in memory.
 * - The auth link carries an HMAC-signed, expiring `state` bound to the Slack user.
 * - A tiny HTTP server handles Google's redirect (the Slack app itself runs in socket mode, so it has no
 *   HTTP endpoint). Put HTTPS in front of it (Caddy/nginx) and register the URL as GOOGLE_REDIRECT_URI.
 *
 * Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, GOOGLE_TOKEN_KEY (64 hex chars),
 *      optional GOOGLE_ALLOWED_DOMAIN, GOOGLE_TOKEN_STORE, OAUTH_PORT, OAUTH_HOST (default 127.0.0.1).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const fetch = require('node-fetch');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'];
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Access tokens by Slack user Id: { token, expiresAt }
const accessCache = new Map();

const env = () => ({
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
  tokenKey: process.env.GOOGLE_TOKEN_KEY,
  allowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN,
  storePath: process.env.GOOGLE_TOKEN_STORE || path.join(__dirname, 'data', 'google-tokens.json'),
});

/**
 * Whether Google Drive reading is configured (all required env present and the key is valid).
 *
 * @returns {boolean}
 */
function isConfigured() {
  const { clientId, clientSecret, redirectUri, tokenKey } = env();
  return Boolean(clientId && clientSecret && redirectUri && /^[0-9a-fA-F]{64}$/.test(tokenKey || ''));
}

const keyBuffer = () => Buffer.from(env().tokenKey, 'hex');

// ---------- encrypted token store ----------

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}

function decrypt(payload) {
  const [iv, tag, data] = payload.split('.').map(p => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(env().storePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  const { storePath } = env();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // Write to a temp file then rename, so a crash never leaves a half-written store
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, storePath);
}

function saveConnection(slackUserId, { refreshToken, email }) {
  const store = readStore();
  store[slackUserId] = { email, refresh: encrypt(refreshToken), connectedAt: new Date().toISOString() };
  writeStore(store);
}

function loadConnection(slackUserId) {
  const entry = readStore()[slackUserId];
  if (!entry) return null;
  try {
    return { email: entry.email, refreshToken: decrypt(entry.refresh) };
  } catch (_) {
    return null;
  }
}

function deleteConnection(slackUserId) {
  const store = readStore();
  delete store[slackUserId];
  writeStore(store);
  accessCache.delete(slackUserId);
}

// ---------- signed state ----------

const b64url = buf => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return crypto.createHmac('sha256', keyBuffer()).update(payload).digest('base64url');
}

function createState(slackUserId) {
  const payload = b64url(JSON.stringify({ u: slackUserId, exp: Date.now() + STATE_TTL_MS, n: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${sign(payload)}`;
}

/**
 * Verifies a state parameter.
 *
 * @param {string} state
 * @returns {string|null} Slack user Id, or null when the state is forged, malformed or expired
 */
function verifyState(state) {
  const [payload, signature] = String(state || '').split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Date.now() < exp ? u : null;
  } catch (_) {
    return null;
  }
}

// ---------- OAuth ----------

/**
 * Builds the Google consent URL for a Slack user.
 *
 * @param {string} slackUserId
 * @returns {string}
 */
function buildAuthUrl(slackUserId) {
  const { clientId, redirectUri, allowedDomain } = env();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    // Always ask for consent so Google returns a refresh token even on re-connect
    prompt: 'consent',
    state: createState(slackUserId),
    ...(allowedDomain ? { hd: allowedDomain } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body) {
  const { clientId, clientSecret } = env();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...body }),
  });
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error_description || data.error || 'Google token request failed');
    error.code = data.error;
    throw error;
  }
  return data;
}

// The id_token comes straight from Google over TLS in the token response, so decoding it is enough here
const decodeIdToken = idToken => JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));

/**
 * Completes the OAuth flow: exchanges the code, checks the account domain and stores the refresh token.
 *
 * @param {string} code - Authorization code from Google
 * @param {string} slackUserId - Slack user taken from the verified state
 * @returns {Promise<{email: string}>}
 */
async function completeAuth(code, slackUserId) {
  const { redirectUri, allowedDomain } = env();
  const data = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const claims = data.id_token ? decodeIdToken(data.id_token) : {};
  const email = claims.email || 'akun Google';

  if (allowedDomain && claims.hd !== allowedDomain && !String(email).endsWith(`@${allowedDomain}`)) {
    throw new Error(`Gunakan akun Google @${allowedDomain}.`);
  }
  if (!data.refresh_token) {
    throw new Error('Google tidak memberikan refresh token. Cabut akses Lori di myaccount.google.com/permissions lalu coba lagi.');
  }

  saveConnection(slackUserId, { refreshToken: data.refresh_token, email });
  accessCache.set(slackUserId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return { email };
}

/**
 * Returns a valid Google access token for a Slack user, refreshing it when needed.
 *
 * @param {string} slackUserId
 * @returns {Promise<string|null>} Access token, or null when the user has not connected (or access was revoked)
 */
async function getAccessToken(slackUserId) {
  const cached = accessCache.get(slackUserId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const connection = loadConnection(slackUserId);
  if (!connection) return null;

  try {
    const data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: connection.refreshToken });
    accessCache.set(slackUserId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
    return data.access_token;
  } catch (error) {
    // Revoked or expired grant: forget it so the user is asked to reconnect
    if (error.code === 'invalid_grant') {
      deleteConnection(slackUserId);
      return null;
    }
    throw error;
  }
}

/** Drops the cached access token (e.g. after a 401 from Drive). */
function invalidateAccessToken(slackUserId) {
  accessCache.delete(slackUserId);
}

/**
 * Disconnects a user: revokes the grant at Google (best effort) and deletes the stored token.
 *
 * @param {string} slackUserId
 * @returns {Promise<boolean>} Whether the user had a connection
 */
async function disconnect(slackUserId) {
  const connection = loadConnection(slackUserId);
  if (!connection) return false;
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(connection.refreshToken)}`, {
    method: 'POST',
  }).catch(() => {});
  deleteConnection(slackUserId);
  return true;
}

const connectedEmail = slackUserId => loadConnection(slackUserId)?.email || null;

// ---------- callback server ----------

const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const page = (title, message) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:420px;margin:15vh auto;padding:0 16px;text-align:center">
<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`;

/**
 * Starts the HTTP server that receives Google's redirect.
 *
 * @param {Object} params
 * @param {import('@slack/web-api').WebClient} params.client - Slack client, to confirm in DM
 * @param {Object} [params.logger]
 * @returns {http.Server|null} The server, or null when Google is not configured
 */
function startOAuthServer({ client, logger = console }) {
  if (!isConfigured()) {
    logger.info?.('Google Drive is not configured (GOOGLE_* env missing) — read_file for Drive is disabled.');
    return null;
  }

  const callbackPath = new URL(env().redirectUri).pathname;
  const port = Number(process.env.OAUTH_PORT) || 3000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const reply = (status, title, message) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page(title, message));
    };

    if (url.pathname === '/healthz') return reply(200, 'ok', '');
    if (url.pathname !== callbackPath) return reply(404, 'Not found', '');

    if (url.searchParams.get('error')) {
      return reply(400, 'Dibatalkan', 'Anda tidak memberi izin. Tutup halaman ini dan coba lagi dari Slack.');
    }

    const slackUserId = verifyState(url.searchParams.get('state'));
    const code = url.searchParams.get('code');
    if (!slackUserId || !code) {
      return reply(400, 'Link tidak valid', 'Link sudah kedaluwarsa. Minta Lori membuat link baru di Slack.');
    }

    try {
      const { email } = await completeAuth(code, slackUserId);
      reply(200, 'Google Drive terhubung ✅', `${email} sudah terhubung. Anda bisa kembali ke Slack.`);
      client.chat
        .postMessage({
          channel: slackUserId,
          text: `✅ Google Drive terhubung sebagai *${email}*. Silakan ulangi permintaan Anda, atau ketik "putuskan Google Drive" untuk mencabut akses kapan saja.`,
        })
        .catch(() => {});
    } catch (error) {
      logger.error?.('Google OAuth callback failed:', error.message);
      reply(400, 'Gagal menghubungkan', error.message);
    }
  });

  // Localhost by default: the reverse proxy (Caddy/nginx) on the same machine is the only public entry point
  const host = process.env.OAUTH_HOST || '127.0.0.1';
  server.listen(port, host, () => logger.info?.(`Google OAuth callback listening on ${host}:${port}${callbackPath}`));
  return server;
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  verifyState,
  completeAuth,
  getAccessToken,
  invalidateAccessToken,
  disconnect,
  connectedEmail,
  startOAuthServer,
  // exported for tests/inspection
  _internals: { encrypt, decrypt, createState },
};
