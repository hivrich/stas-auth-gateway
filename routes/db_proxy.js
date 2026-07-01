const express = require('express');
const router  = express.Router();
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

// === Config to STAS DB Bridge ===
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_KEY  ;
const DEFAULT_DB_PROXY_TIMEOUT_MS = 5000;
const ACTIVITY_DETAIL_TIMEOUT_MS = 40000;

function safeJSON(text, fallback=null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function methodCanHaveBody(method) {
  return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
}

function requestBodyForFetch(req) {
  if (req.body === undefined) return undefined;
  if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

function getDbProxyTimeoutMs(method, path) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
  if (normalizedMethod === 'GET' && normalizedPath === '/activity_detail') {
    return ACTIVITY_DETAIL_TIMEOUT_MS;
  }
  return DEFAULT_DB_PROXY_TIMEOUT_MS;
}

// === Main proxy for /gw/api/db/* ===
router.use(async (req, res) => {
  const rest = req.path.replace(/^\/+/, '');          // e.g. "trainings"
  const url  = new URL(`/api/db/${rest}`, STAS_BASE);

  // Always use authenticated identity; query user_id/uid must not override it.
  const uid = getRequestUserId(req);
  if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

  const q = new URLSearchParams(req.query || {});
  q.delete('uid');
  q.set('user_id', uid);
  for (const [k, v] of q.entries()) url.searchParams.set(k, v);

  const started = Date.now();
  console.log(`[db_proxy][REQ] ${req.method} ${req.originalUrl} → ${url.toString()}`);

  // Most DB proxy calls stay short; activity_detail can wait on live activity/stream fetches.
  const timeoutMs = getDbProxyTimeoutMs(req.method, req.path);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const method = String(req.method || 'GET').toUpperCase();
    const headers = buildStasSourceHeaders(req, { 'X-API-Key': STAS_KEY, 'Accept': 'application/json' });
    const init = {
      method,
      headers,
      signal: ac.signal
    };

    if (methodCanHaveBody(method)) {
      const body = requestBodyForFetch(req);
      if (body !== undefined) {
        headers['Content-Type'] = req.get?.('content-type') || req.headers?.['content-type'] || 'application/json';
        init.body = body;
      }
    }

    const r = await fetch(url, init);
    const bodyText = await r.text();
    let body = bodyText;
    const ct  = r.headers.get('content-type') || 'application/json; charset=utf-8';

    // No heavy transforms anymore — просто проксируем как есть
    console.log(`[db_proxy][RES] ${r.status} {bytes:${body.length}} ${Date.now()-started}ms`);
    res.status(r.status).set('content-type', ct).send(body);
  } catch (e) {
    const ms = Date.now() - started;
    console.error(`[db_proxy][ERR] ${e?.message || e} after ${ms}ms`);
    const status = e?.name === 'AbortError' || String(e.message||'').includes('aborted') ? 504 : 502;
    res.status(status).json({ error: status === 504 ? 'gateway_timeout' : 'bad_gateway' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
module.exports.__testing = {
  ACTIVITY_DETAIL_TIMEOUT_MS,
  DEFAULT_DB_PROXY_TIMEOUT_MS,
  getDbProxyTimeoutMs,
};
