const express = require('express');
const router  = express.Router();
const { getRequestUserId } = require('../lib/request-auth');
const { getStasRequestId } = require('../lib/request-id');
const { buildStasSourceHeaders } = require('../lib/request-source');

// === Config to STAS DB Bridge ===
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_KEY  ;
const DEFAULT_DB_PROXY_TIMEOUT_MS = 10000;
const ACTIVITY_DETAIL_TIMEOUT_MS = 40000;
const USER_SUMMARY_TIMEOUT_MS = 15000;

function safeJSON(text, fallback=null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// Log-safe upstream error category: timeout vs any other upstream failure.
// Raw error text, URLs and query strings never reach the log sink.
function upstreamErrorCategory(error) {
  const name = String(error?.name || '');
  const code = String(error?.code || '');
  const message = String(error?.message || '');
  return (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)) ? 'upstream_timeout' : 'upstream_error';
}

function proxyLogFields(req, extra = {}) {
  return JSON.stringify({
    stas_request_id: getStasRequestId(req),
    method: req.method,
    path: req.path,
    ...extra,
  });
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
  if (normalizedMethod === 'GET' && ['/user_summary/v2', '/user_summary/v3'].includes(normalizedPath)) {
    return USER_SUMMARY_TIMEOUT_MS;
  }
  if (normalizedMethod === 'GET' && normalizedPath === '/activity_detail') {
    return ACTIVITY_DETAIL_TIMEOUT_MS;
  }
  return DEFAULT_DB_PROXY_TIMEOUT_MS;
}

// STAS endpoints that are internal: written only by the gateway itself
// (lib/plan-change-callback.js, lib/icu-attempt-ledger.js, lib/request-auth.js), never via this proxy.
// Compared in normalised form (lowercase, "-" and "_" equal).
const INTERNAL_FIRST_SEGMENTS = Object.freeze(['plan_changes', 'intervals-attempts', 'ensure-intervals-user']);

function comparable(segment) {
  return String(segment || '').toLowerCase().replace(/-/g, '_');
}
const DENIED_SEGMENTS = new Set(INTERNAL_FIRST_SEGMENTS.map(comparable));

// Returns { rest } (decoded, slash-collapsed path without edge slashes), { error: 'bad_path' }
// for undecodable or ".." paths, or { denied: true } for an internal endpoint.
function classifyDbPath(rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(String(rawPath || '')); } catch { return { error: 'bad_path' }; }
  const segments = decoded.toLowerCase().replace(/\\/g, '/').split('/').filter(Boolean);
  // '.' and '..' would be dropped or resolved by new URL() after this check: refuse them outright.
  if (segments.some((s) => s === '.' || s === '..')) return { error: 'bad_path' };
  if (segments.length && DENIED_SEGMENTS.has(comparable(segments[0]))) return { denied: true };
  return { rest: segments.join('/') };
}

// === Main proxy for /gw/api/db/* ===
router.use(async (req, res) => {
  const verdict = classifyDbPath(req.path);
  if (verdict.error) return res.status(400).json({ status: 400, error: 'bad_request' });
  if (verdict.denied) return res.status(404).json({ status: 404, error: 'not_found' });

  const rest = req.path.replace(/^\/+/, '');          // e.g. "trainings"
  const url  = new URL(`/api/db/${rest}`, STAS_BASE);
  // Second check on the URL actually sent to STAS, after WHATWG normalisation.
  const finalVerdict = classifyDbPath(url.pathname.replace(/^\/api\/db\/?/, ''));
  if (finalVerdict.error || finalVerdict.denied) return res.status(404).json({ status: 404, error: 'not_found' });

  // Always use authenticated identity; query user_id/uid must not override it.
  const uid = getRequestUserId(req);
  if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

  const q = new URLSearchParams(req.query || {});
  q.delete('uid');
  q.set('user_id', uid);
  for (const [k, v] of q.entries()) url.searchParams.set(k, v);

  const started = Date.now();
  try { console.log(`[db_proxy][REQ] ${proxyLogFields(req, { upstream_path: url.pathname })}`); } catch {}

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
    try { console.log(`[db_proxy][RES] ${proxyLogFields(req, {
      status: r.status,
      duration_ms: Date.now() - started,
      bytes: body.length,
    })}`); } catch {}
    res.status(r.status).set('content-type', ct).send(body);
  } catch (e) {
    const status = e?.name === 'AbortError' || String(e.message||'').includes('aborted') ? 504 : 502;
    try { console.error(`[db_proxy][ERR] ${proxyLogFields(req, {
      status,
      duration_ms: Date.now() - started,
      category: upstreamErrorCategory(e),
    })}`); } catch {}
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
  INTERNAL_FIRST_SEGMENTS,
  classifyDbPath,
};
