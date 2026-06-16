const express = require('express');
const router  = express.Router();
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

// GET /gw/icu/events?days=7 (или oldest/newest)
router.get('/events', async (req, res) => {
  try {
    const auth = await getIcuRequestAuth(req);

    // Проксируем ICU events «как есть»
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(req.query || {})) {
      // никакого user_id из query
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    if (!qs.has('days') && !qs.has('oldest') && !qs.has('newest')) qs.set('days','7');

    const icuUrl = new URL(`/api/v1/athlete/${encodeURIComponent(auth.athleteId)}/events?${qs.toString()}`, 'https://intervals.icu');
    try { console.log("[icu][DBG] GET", icuUrl, { athlete_id: auth.athleteId, auth_mode: auth.authMode }); } catch(e){}

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
    console.error('[icu.events]', e && e.stack || e);
    return res.status(502).json({ error: 'bad_gateway' });
  }
});

module.exports = router;
