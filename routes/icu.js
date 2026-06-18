const express = require('express');
const router  = express.Router();
const { getIcuRequestAuth } = require('../lib/icu-request-auth');

// GET /gw/icu/events?days=7 (или oldest/newest)
router.get('/events', async (req, res) => {
  try {
    const { token, athleteId, authMode } = await getIcuRequestAuth(req);

    // 2) Проксируем ICU events «как есть»
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(req.query || {})) {
      // никакого user_id из query
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    if (!qs.has('days') && !qs.has('oldest') && !qs.has('newest')) qs.set('days','7');

    const icuUrl = new URL(`/api/v1/athlete/${athleteId}/events?${qs.toString()}`, 'https://intervals.icu');
    console.log("[icu][DBG] GET", icuUrl.toString(), { athlete_id: athleteId, auth_mode: authMode });

    // Try Bearer (OAuth token) first, fallback to Basic (API key)
    let ir = await fetch(icuUrl, { headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }});
    if ((ir.status === 401 || ir.status === 403) && authMode === 'legacy') {
      console.log("[icu][DBG] Bearer failed, trying Basic auth");
      const basic = Buffer.from(`API_KEY:${token}`).toString('base64');
      ir = await fetch(icuUrl, { headers: { 'Authorization': `Basic ${basic}`, 'Accept': 'application/json' }});
    }
    if ((ir.status === 401 || ir.status === 403) && authMode === 'intervals') {
      return res.status(401).json({
        error: 'auth_required',
        message: 'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
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
      return res.status(401).json({ error: 'missing_or_invalid_token' });
    }
    if (e?.status === 404) {
      return res.status(404).json({ error: 'icu_creds_not_found' });
    }
    console.error('[icu.events]', e && e.stack || e);
    return res.status(502).json({ error: 'bad_gateway' });
  }
});

module.exports = router;
