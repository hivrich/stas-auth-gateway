const express = require('express');
const router  = express.Router();
const { getStasRequestId } = require('../lib/request-id');
const { getIcuRequestAuth } = require('../lib/icu-request-auth');

function buildAuthHeaders(auth, mode) {
  const headers = { Accept: 'application/json' };
  if (mode === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`API_KEY:${auth.token}`).toString('base64')}`;
  } else {
    headers.Authorization = `Bearer ${auth.token}`;
  }
  return headers;
}

// Log-safe upstream error category: timeout vs any other upstream failure.
function upstreamErrorCategory(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return (name === 'AbortError' || name === 'TimeoutError' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)) ? 'upstream_timeout' : 'upstream_error';
}

function icuLogFields(req, extra = {}) {
  return JSON.stringify({
    stas_request_id: getStasRequestId(req),
    method: req.method,
    path: req.path,
    ...extra,
  });
}

// GET /gw/icu/events?days=7 (или oldest/newest)
router.get('/events', async (req, res) => {
  try {
    const auth = await getIcuRequestAuth(req);

    // Проксируем ICU events «как есть»
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(req.query || {})) {
      if (k === 'user_id' || k === 'uid') continue;
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    if (!qs.has('days') && !qs.has('oldest') && !qs.has('newest')) qs.set('days','7');

    const icuUrl = new URL(`/api/v1/athlete/${encodeURIComponent(auth.athleteId)}/events?${qs.toString()}`, 'https://intervals.icu');
    try { console.log(`[icu][DBG] ${icuLogFields(req, { auth_mode: auth.authMode })}`); } catch(e){}

    let ir = await fetch(icuUrl, { headers: buildAuthHeaders(auth, 'bearer') });
    if ((ir.status === 401 || ir.status === 403) && auth.authMode === 'legacy') {
      ir = await fetch(icuUrl, { headers: buildAuthHeaders(auth, 'basic') });
    }

    if ((ir.status === 401 || ir.status === 403) && auth.authMode === 'intervals') {
      return res.status(401).json({
        ok:false,
        error:'auth_required',
        message:'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
      });
    }

    const txt = await ir.text();
    const ct  = ir.headers.get('content-type') || 'application/json; charset=utf-8';

    // если JSON — вернём объект/массив, иначе — сырой текст
    try {
      const parsed = JSON.parse(txt);
      return res.status(ir.status).type('application/json').send(parsed);
    } catch {
      return res.status(ir.status).set('content-type', ct).send(txt);
    }
  } catch (e) {
    if (e?.status === 401) {
      return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    }
    if (e?.status === 404) {
      return res.status(404).json({ error: 'icu_creds_not_found' });
    }
    if (e?.status === 409) {
      return res.status(409).json({ error: 'intervals_reconnect_required' });
    }
    try { console.error(`[icu.events][ERR] ${icuLogFields(req, {
      status: 502,
      category: upstreamErrorCategory(e),
    })}`); } catch(e2){}
    return res.status(502).json({ error: 'bad_gateway' });
  }
});

module.exports = router;
