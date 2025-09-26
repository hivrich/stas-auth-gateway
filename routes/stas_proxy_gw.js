'use strict';
const BASE = process.env.STAS_BASE_URL || 'http://127.0.0.1:3336';
const clamp = s => (s||'').toString().slice(0,10);

module.exports = app => {
  console.log('[v2][load] stas_proxy_gw');

  app.get('/gw/stas/user_summary', async (req, res) => {
    const uid = res.locals.user_id || null;
    if (!uid) return res.status(401).json({ status:401, error:'missing_or_invalid_token' });

    const u = new URL(`${BASE}/api/db/user_summary`);
    u.searchParams.set('user_id', uid);

    try {
      const r = await fetch(u, { headers:{Accept:'application/json'} });
      const t = await r.text();
      if (!r.ok) return res.status(r.status).json({ status:r.status, error:'stas_upstream_error', detail:t });
      res.type('application/json').send(t);
    } catch (e) {
      return res.status(502).json({ status:502, error:'stas_upstream_error', detail: e.message });
    }
  });

  app.get('/gw/stas/trainings', async (req, res) => {
    const uid = res.locals.user_id || null;
    if (!uid) return res.status(401).json({ status:401, error:'missing_or_invalid_token' });

    const from = clamp(req.query.from), to = clamp(req.query.to);
    const u = new URL(`${BASE}/api/db/trainings`);
    u.searchParams.set('user_id', uid);
    if (from) u.searchParams.set('from', from);
    if (to)   u.searchParams.set('to', to);

    try {
      const r = await fetch(u, { headers:{Accept:'application/json'} });
      const t = await r.text();
      if (!r.ok) return res.status(r.status).json({ status:r.status, error:'stas_upstream_error', detail:t });
      res.type('application/json').send(t);
    } catch (e) {
      return res.status(502).json({ status:502, error:'stas_upstream_error', detail: e.message });
    }
  });
};
