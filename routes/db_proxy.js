const express = require('express');
const router  = express.Router();

// === Config to STAS DB Bridge ===
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_KEY  ;

// === Helpers ===
function uidFromBearer(req) {
  const auth = String(req.headers['authorization'] || '');
  const m = auth.match(/^Bearer\s+t_([A-Za-z0-9\-_]+)$/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return json && json.uid ? String(json.uid) : null;
  } catch (_e) { return null; }
}

function safeJSON(text, fallback=null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

// === Main proxy for /gw/api/db/* ===
router.use(async (req, res) => {
  const rest = req.path.replace(/^\/+/, '');          // e.g. "trainings"
  const url  = new URL(`/api/db/${rest}`, STAS_BASE);

  // Ensure user_id (берём из Bearer, если клиент не прислал — мидлвар на /gw это уже делает, но подстрахуемся)
  const q = new URLSearchParams(req.query || {});
  if (!q.get('user_id')) {
    const uid = uidFromBearer(req);
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
    const r = await fetch(url, {
      headers: { 'X-API-Key': STAS_KEY, 'Accept': 'application/json' },
      signal: ac.signal
    });
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
