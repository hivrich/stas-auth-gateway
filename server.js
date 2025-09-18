// STAS Auth Gateway - minimal scaffold
// Endpoints:
//  - GET   /gw/healthz
//  - GET   /gw/oauth/authorize  (redirect with ?code=...&state=...)
//  - POST  /gw/oauth/token      (exchange code -> access_token)
// Note: Proxy routes to STAS/ICU can be added later.

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3337);
const NODE_ENV = process.env.NODE_ENV || 'production';

const STAS_API_BASE = process.env.STAS_API_BASE || 'https://stas.stravatg.ru';
const STAS_API_KEY = process.env.STAS_API_KEY || '';
const ICU_API_BASE = process.env.ICU_API_BASE || 'https://intervals.icu/api/v1';

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || 'chatgpt-actions';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const OAUTH_REDIRECTS = (process.env.OAUTH_REDIRECTS || '').split(',').map(s => s.trim()).filter(Boolean);

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev_session_secret_change_me';
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');

const ACCESS_TTL_SEC = parseInt(process.env.ACCESS_TTL_SEC || '3600', 10);
const REFRESH_TTL_SEC = parseInt(process.env.REFRESH_TTL_SEC || '2592000', 10); // 30 days

const pool = new Pool({
  host: process.env.PGHOST || '94.241.141.239',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'hivrich_db',
  user: process.env.PGUSER || 'limpid_beaker67',
  password: process.env.PGPASSWORD || 'jup64918',
  ssl: (/^true$/i).test(process.env.PGSSL || 'false') ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.use(express.json());
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));

function log(...args) { if (DEBUG) console.log('[GW]', ...args); }

function wildcardMatch(pattern, str) {
  // Simple wildcard match supporting a single * segment
  if (!pattern) return false;
  if (pattern === '*') return true;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc(pattern).replace(/\\\*/g, '.*') + '$');
  return re.test(str);
}

function isRedirectAllowed(uri) {
  if (OAUTH_REDIRECTS.length === 0) return false;
  return OAUTH_REDIRECTS.some(p => wildcardMatch(p, uri));
}

async function getClientById(client_id) {
  const sql = 'select client_id, client_secret, redirect_uri from gw_oauth_clients where client_id=$1 limit 1';
  const r = await pool.query(sql, [client_id]);
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

// Health check
app.get('/gw/healthz', (req, res) => {
  res.json({ ok: true, stas: !!STAS_API_BASE, icu: !!ICU_API_BASE, client: OAUTH_CLIENT_ID });
});

// OAuth 2.0 Authorization Endpoint (Authorization Code Grant)
app.get('/gw/oauth/authorize', (req, res) => {
  const { response_type, client_id, redirect_uri, scope = '', state = '', user_id = '' } = req.query;

  if (response_type !== 'code') return res.status(400).json({ error: 'unsupported_response_type' });
  if (client_id !== OAUTH_CLIENT_ID) return res.status(401).json({ error: 'invalid_client' });
  if (!redirect_uri || !isRedirectAllowed(String(redirect_uri))) return res.status(400).json({ error: 'invalid_redirect_uri' });

  // Create short-lived authorization code as a signed JWT
  const now = Math.floor(Date.now() / 1000);
  const code = jwt.sign({
    sub: String(user_id || ''),
    aud: OAUTH_CLIENT_ID,
    scope: String(scope),
    iat: now,
    exp: now + 300, // 5 min
    typ: 'auth_code'
  }, JWT_SECRET);

  const url = new URL(String(redirect_uri));
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', String(state));

  log('authorize ok -> redirect', url.toString());
  res.redirect(url.toString());
});

// OAuth 2.0 Token Endpoint
app.post('/gw/oauth/token', async (req, res) => {
  const { grant_type, code, redirect_uri, client_id, client_secret } = req.body || {};

  if (grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
  if (client_id !== OAUTH_CLIENT_ID) return res.status(401).json({ error: 'invalid_client' });

  try {
    const clientRow = await getClientById(String(client_id));
    if (!clientRow) return res.status(401).json({ error: 'invalid_client' });

    // Strict checks: client_secret and redirect_uri must match DB, byte-for-byte
    if (!client_secret || client_secret !== clientRow.client_secret) {
      return res.status(401).json({ error: 'invalid_client' });
    }
    if (!redirect_uri || String(redirect_uri) !== String(clientRow.redirect_uri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }

    const payload = jwt.verify(String(code || ''), JWT_SECRET);
    if (payload.typ !== 'auth_code') throw new Error('bad_code_type');

    const now = Math.floor(Date.now() / 1000);
    const access_token = jwt.sign({
      sub: payload.sub,
      scope: payload.scope,
      iat: now,
      exp: now + ACCESS_TTL_SEC,
      typ: 'access'
    }, SESSION_SECRET);

    const refresh_token = jwt.sign({
      sub: payload.sub,
      scope: payload.scope,
      iat: now,
      exp: now + REFRESH_TTL_SEC,
      typ: 'refresh'
    }, SESSION_SECRET);

    res.json({
      access_token,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
      refresh_token,
      scope: payload.scope || '',
      created_at: now
    });
  } catch (e) {
    log('token exchange error', e.message);
    return res.status(400).json({ error: 'invalid_grant' });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`STAS Auth Gateway listening on 127.0.0.1:${PORT} (${NODE_ENV})`);
});
