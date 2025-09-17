/**
 * STAS Auth Gateway - minimal working scaffold
 * Env: Node 22+, Express
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const morgan = require('morgan');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const createError = require('http-errors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || "3337", 10);
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL_SECONDS = parseInt(process.env.TOKEN_TTL_SECONDS || "3600", 10);
const REFRESH_TTL_SECONDS = parseInt(process.env.REFRESH_TTL_SECONDS || "2592000", 10);
const REFRESH_PEPPER = process.env.REFRESH_PEPPER || "pepper";
const SKIP_STAS_VALIDATE = /^true$/i.test(String(process.env.SKIP_STAS_VALIDATE || ""));
const HEALTH_USER_ID = process.env.HEALTH_USER_ID ? Number(process.env.HEALTH_USER_ID) : null;
const { isAllowedRedirect } = require('./lib/redirect');

const STAS_API_BASE = process.env.STAS_API_BASE;
const STAS_API_KEY = process.env.STAS_API_KEY;

const MCP_API_BASE = process.env.MCP_API_BASE;
const MCP_API_KEY = process.env.MCP_API_KEY;

const DB = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: (/^true$/i).test(String(process.env.DB_SSL || "")) ? { rejectUnauthorized: false } : false
});

const app = express();
// Serve static OpenAPI under /gw
app.use('/gw', express.static(path.join(__dirname, 'gw')));
// --- BEGIN: Lightweight authorize form when user_id is missing ---
const escapeHtml = (s='') =>
  String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

app.use(express.urlencoded({ extended: false }));

app.get('/oauth/authorize', (req, res, next) => {
  const { client_id, redirect_uri, response_type, scope, state, user_id } = req.query;

  // Если user_id уже есть — передаём управление основному обработчику
  if (user_id) return next();

  // Базовая проверка параметров OAuth
  if (!client_id || !redirect_uri || response_type !== 'code' || !scope) {
    return res.status(400).json({ error: 'missing_parameters' });
  }

  // Простая HTML-форма для ввода реального STAS user_id
  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>STAS · Авторизация</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,sans-serif;margin:0;padding:24px;background:#0b0c10;color:#e8e8e8}
    .card{max-width:520px;margin:0 auto;background:#14161a;border-radius:16px;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,.35)}
    h1{font-size:18px;margin:0 0 12px}
    label{display:block;margin:12px 0 6px}
    input[type=number]{width:100%;padding:10px 12px;border-radius:12px;border:1px solid #2a2f36;background:#0f1114;color:#e8e8e8}
    button{margin-top:16px;padding:10px 14px;border:0;border-radius:12px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer}
    small{color:#9aa4b2}
  </style>
</head>
<body>
  <div class="card">
    <h1>Подтвердите ваш STAS ID</h1>
    <form method="GET" action="">
      <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
      <input type="hidden" name="response_type" value="code">
      <input type="hidden" name="scope" value="${escapeHtml(scope)}">
      ${state ? `<input type="hidden" name="state" value="${escapeHtml(state)}">` : ''}

      <label for="uid">Ваш STAS user_id</label>
      <input id="uid" name="user_id" type="number" inputmode="numeric" required autofocus placeholder="например, 95192039">

      <button type="submit">Продолжить</button>
      <div><small>user_id используется только для выдачи кода авторизации.</small></div>
    </form>
  </div>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
});
// --- END: Lightweight authorize form when user_id is missing ---
app.disable('x-powered-by');
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Helpers
const now = () => new Date();
const minutesFromNow = (m) => new Date(Date.now() + m*60*1000);
const secondsFromNow = (s) => new Date(Date.now() + s*1000);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Structured logger
function log(event = {}) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), ...event })); } catch { /* noop */ }
}

function maskUserId(id) {
  if (id === undefined || id === null) return null;
  const s = String(id);
  if (s.length <= 2) return '*'.repeat(s.length);
  return '*'.repeat(Math.max(0, s.length - 2)) + s.slice(-2);
}

// Simple in-memory rate limiter per IP
function makeRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    let arr = buckets.get(ip) || [];
    arr = arr.filter(ts => now - ts < windowMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil((windowMs - (now - arr[0])) / 1000)));
      return next(createError(429, 'rate_limited'));
    }
    arr.push(now);
    buckets.set(ip, arr);
    next();
  };
}

const rateLimitAuthorize = makeRateLimiter({ windowMs: 60_000, max: 10 });
const rateLimitToken = makeRateLimiter({ windowMs: 60_000, max: 10 });
// Apply limiter for both authorize handlers (form + main)
app.use('/oauth/authorize', rateLimitAuthorize);


async function queryOne(sql, params) {
  const res = await DB.query(sql, params);
  return res.rows[0];
}

// Health
app.get('/healthz', async (req, res) => {
  const health = { ok: true, time: new Date().toISOString() };
  // simple ping to STAS if configured
  if (STAS_API_BASE && STAS_API_KEY) {
    try {
      const r = await axios.get(`${STAS_API_BASE}/gw/healthz`.replace('/gw/','/gw/'), { timeout: 2000 });
      health.stas = r.status;
    } catch (e) {
      health.stas = 'fail';
    }
  }
  // Always include a consistent env block (non-secret diagnostics)
  health.env = {
    skip_stas_validate: SKIP_STAS_VALIDATE,
    health_user_id: HEALTH_USER_ID ?? null,
  };
  res.json(health);
});

// OAuth authorize
// Expects: client_id, redirect_uri, scope, user_id
app.get('/oauth/authorize', async (req, res, next) => {
  try {
    const start = Date.now();
    const { client_id, redirect_uri, scope = "", user_id, state } = req.query;
    if (!client_id || !redirect_uri || !user_id) throw createError(400, 'missing_parameters');
    // 1) check client
    const client = await queryOne(
      `SELECT client_id, allowed_redirects, scopes FROM public.gw_oauth_clients WHERE client_id=$1 AND disabled_at IS NULL`,
      [client_id]
    );
    if (!client) throw createError(400, 'invalid_client');
    // Enforce strict redirect whitelist for ChatGPT Actions flows
    if (!isAllowedRedirect(redirect_uri)) throw createError(400, 'invalid_redirect');
    const requestedScopes = String(scope).split(/[ ,]+/).filter(Boolean);
    const allowedScopes = new Set(client.scopes || []);
    for (const s of requestedScopes) { if (!allowedScopes.has(s)) throw createError(400, 'invalid_scope'); }
    // 2) validate user via STAS DB bridge (can be skipped in dev)
    let usum = { ok: true };
    if (!SKIP_STAS_VALIDATE) {
      if (!STAS_API_BASE || !STAS_API_KEY) throw createError(500, 'stas_not_configured');
      usum = await axios.get(`${STAS_API_BASE}/api/db/user_summary`, {
        params: { user_id },
        headers: { 'X-API-Key': STAS_API_KEY },
        timeout: 3000
      }).then(r => r.data).catch(() => null);
      if (!usum || !usum.ok) throw createError(400, 'unknown_user');
    }

    // 3) create code (ttl 5 min)
    const code = crypto.randomBytes(24).toString('base64url');
    const expires_at = minutesFromNow(5);
    await DB.query(
      `INSERT INTO public.gw_oauth_codes(code, client_id, user_id, redirect_uri, scopes, expires_at) 
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [code, client_id, user_id, redirect_uri, requestedScopes, expires_at.toISOString()]
    );
    const loc = new URL(redirect_uri);
    loc.searchParams.set('code', code);
    if (state) loc.searchParams.set('state', String(state));
    res.status(302).set('Location', loc.toString()).end();
    log({
      level: 'info', route: '/oauth/authorize', method: 'GET', outcome: 'success',
      client_id, user_id_masked: maskUserId(user_id), redirect_host: new URL(redirect_uri).hostname,
      latency_ms: Date.now() - start
    });
  } catch (e) {
    try {
      const { client_id, redirect_uri, user_id } = req.query || {};
      log({ level: 'error', route: '/oauth/authorize', method: 'GET', outcome: 'error',
        client_id, user_id_masked: maskUserId(user_id), redirect_host: redirect_uri ? new URL(redirect_uri).hostname : null,
        error: e && e.message, status: e && e.status });
    } catch { /* noop */ }
    next(e);
  }
});

// Basic client auth helper
function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx === -1) return null;
  return { id: decoded.slice(0, idx), secret: decoded.slice(idx+1) };
}

// /oauth/token
app.post('/oauth/token', rateLimitToken, async (req, res, next) => {
  try {
    const start = Date.now();
    const basic = parseBasicAuth(req.headers.authorization);
    if (!basic) throw createError(401, 'invalid_client');
    const { id: client_id, secret: client_secret } = basic;

    const client = await queryOne(`SELECT client_id, client_secret_hash FROM public.gw_oauth_clients WHERE client_id=$1 AND disabled_at IS NULL`, [client_id]);
    if (!client) throw createError(401, 'invalid_client');

    const bcrypt = require('bcrypt');
    const ok = await bcrypt.compare(client_secret, client.client_secret_hash);
    if (!ok) throw createError(401, 'invalid_client');

    const { grant_type } = req.body;

    if (grant_type === 'authorization_code') {
      const { code, redirect_uri } = req.body;
      if (!code || !redirect_uri) throw createError(400, 'invalid_request');

      const row = await queryOne(
        `DELETE FROM public.gw_oauth_codes 
         WHERE code=$1 AND client_id=$2 AND redirect_uri=$3 
           AND expires_at > now()
         RETURNING user_id, scopes`,
        [code, client_id, redirect_uri]
      );
      if (!row) throw createError(400, 'invalid_grant');

      const user_id = row.user_id;
      const scopes = row.scopes || [];
      const jti = uuidv4();
      const access_expires_at = secondsFromNow(TOKEN_TTL_SECONDS);
      const refresh_expires_at = secondsFromNow(REFRESH_TTL_SECONDS);
      const payload = { sub: String(user_id), client_id, scope: scopes.join(' '), jti };
      const access_token = jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS });
      const refresh_token = 'rt_' + crypto.randomBytes(32).toString('base64url');
      const refresh_token_hash = sha256Hex(REFRESH_PEPPER + refresh_token);

      await DB.query(
        `INSERT INTO public.gw_oauth_tokens(access_token, refresh_token_hash, user_id, scopes, access_expires_at, refresh_expires_at, access_jti, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [access_token, refresh_token_hash, user_id, scopes, access_expires_at.toISOString(), refresh_expires_at.toISOString(), jti, client_id]
      );

      const tokenResponse = {
        token_type: "Bearer",
        access_token,
        expires_in: TOKEN_TTL_SECONDS,
        refresh_token,
        scope: scopes.join(' ')
      };
      res.json(tokenResponse);
      log({ level: 'info', route: '/oauth/token', method: 'POST', outcome: 'success', grant_type: 'authorization_code', client_id, latency_ms: Date.now() - start });
      return;
    }

    if (grant_type === 'refresh_token') {
      const { refresh_token } = req.body;
      if (!refresh_token) throw createError(400, 'invalid_request');
      const hash = sha256Hex(REFRESH_PEPPER + refresh_token);
      const row = await queryOne(
        `SELECT user_id, scopes, client_id FROM public.gw_oauth_tokens 
         WHERE refresh_token_hash=$1 AND refresh_expires_at > now() AND revoked_at IS NULL`,
        [hash]
      );
      if (!row) throw createError(400, 'invalid_grant');
      const user_id = row.user_id;
      const scopes = row.scopes || [];
      const jti = uuidv4();
      const access_expires_at = secondsFromNow(TOKEN_TTL_SECONDS);
      const access_token = jwt.sign({ sub: String(user_id), client_id: row.client_id, scope: scopes.join(' '), jti }, JWT_SECRET, { algorithm: 'HS256', expiresIn: TOKEN_TTL_SECONDS });
      await DB.query(
        `UPDATE public.gw_oauth_tokens SET access_token=$1, access_expires_at=$2, access_jti=$3 WHERE refresh_token_hash=$4`,
        [access_token, access_expires_at.toISOString(), jti, hash]
      );
      res.json({ token_type: "Bearer", access_token, expires_in: TOKEN_TTL_SECONDS, refresh_token, scope: scopes.join(' ') });
      log({ level: 'info', route: '/oauth/token', method: 'POST', outcome: 'success', grant_type: 'refresh_token', client_id: row.client_id, latency_ms: Date.now() - start });
      return;
    }

    throw createError(400, 'unsupported_grant_type');
  } catch (e) {
    try {
      const basic = parseBasicAuth(req.headers.authorization);
      const client_id = basic && basic.id;
      const grant_type = (req.body && req.body.grant_type) || null;
      log({ level: 'error', route: '/oauth/token', method: 'POST', outcome: 'error', client_id, grant_type, error: e && e.message, status: e && e.status });
    } catch { /* noop */ }
    next(e);
  }
});

// Auth middleware
async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || "";
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) throw createError(401, 'unauthorized');
    const token = m[1];
    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      throw createError(401, 'unauthorized');
    }
    req.auth = { user_id: payload.sub, scope: new Set(String(payload.scope || '').split(/\s+/).filter(Boolean)) };
    next();
  } catch (e) {
    next(e);
  }
}

function needScope(s) {
  return (req, res, next) => {
    if (!req.auth || !req.auth.scope.has(s)) return next(createError(403, 'insufficient_scope'));
    next();
  };
}

// /api/me
app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    // For now respond minimal; athlete_id could be mapped later
    res.json({ user_id: Number(req.auth.user_id) || null, athlete_id: null });
  } catch (e) { next(e); }
});

// (dev mint removed)

// ICU proxy - robust matcher using middleware with path check
async function icuProxyHandler(req, res, next) {
  try {
    console.log('ICU route hit:', req.method, req.originalUrl);
    const method = req.method.toUpperCase();
    if (method === 'GET') {
      if (!req.auth.scope.has('icu')) throw createError(403, 'insufficient_scope');
    } else if (method === 'POST' || method === 'DELETE') {
      if (!req.auth.scope.has('workouts:write')) throw createError(403, 'insufficient_scope');
    }
    const tail = '/icu' + req.originalUrl.replace(/^\/api\/icu/, '');
    const url = `${MCP_API_BASE}${tail}`;
    const headers = { 'X-API-Key': MCP_API_KEY };
    const ax = await axios({
      url,
      method,
      headers: { ...headers, 'Content-Type': req.headers['content-type'] || 'application/json' },
      data: method === 'GET' ? undefined : req.body,
      validateStatus: () => true
    });
    res.status(ax.status);
    for (const [k, v] of Object.entries(ax.headers || {})) {
      if (k.toLowerCase().startsWith('content-')) res.setHeader(k, v);
    }
    res.send(ax.data);
  } catch (e) { next(e); }
}

app.use((req, res, next) => {
  if (req.path === '/api/icu' || req.path.startsWith('/api/icu/')) {
    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      return icuProxyHandler(req, res, next);
    });
  }
  next();
});

// Errors
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const body = { error: err.message || 'server_error' };
  if (status >= 500) console.error('ERROR', err);
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`STAS Auth Gateway listening on :${PORT}`);
  console.log(`SKIP_STAS_VALIDATE=${SKIP_STAS_VALIDATE}`);
  // Safe env diagnostics (no secrets printed)
  console.log('DB cfg:', {
    host: typeof process.env.DB_HOST === 'string',
    port: typeof process.env.DB_PORT === 'string',
    name: typeof process.env.DB_NAME === 'string',
    user: typeof process.env.DB_USER === 'string',
    passwordPresent: typeof process.env.DB_PASSWORD === 'string',
    ssl: String(process.env.DB_SSL || ''),
  });
});
