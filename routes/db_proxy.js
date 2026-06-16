const express = require('express');
const router  = express.Router();
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

// === Config to STAS DB Bridge ===
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_KEY  ;

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

// === Main proxy for /gw/api/db/* ===
router.use(async (req, res) => {
  const rest = req.path.replace(/^\/+/, '');          // e.g. "trainings"
  const url  = new URL(`/api/db/${rest}`, STAS_BASE);

  // Ensure user_id (берём из Bearer, если клиент не прислал — мидлвар на /gw это уже делает, но подстрахуемся)
  const q = new URLSearchParams(req.query || {});
  if (!q.get('user_id')) {
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    q.set('user_id', uid);
  }
  for (const [k, v] of q.entries()) url.searchParams.set(k, v);

  const started = Date.now();
  console.log(`[db_proxy][REQ] ${req.method} ${req.originalUrl} → ${url.toString()}`);

  // fetch with 5s timeout (AbortController)
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort('timeout'), 5000);

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
    const status = e === 'timeout' || String(e.message||'').includes('aborted') ? 504 : 502;
    res.status(status).json({ error: status === 504 ? 'gateway_timeout' : 'bad_gateway' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
