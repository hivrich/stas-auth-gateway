'use strict';
const { Pool } = require('pg');
let pool;
const getPool = () => pool ?? (pool = new Pool({ connectionString: process.env.STAS_PGURL }));
const clamp = s => (s||'').toString().slice(0,10);
const normAthlete = v => (v ? (String(v).trim().startsWith('i') ? String(v).trim() : `i${String(v).trim()}`) : null);
const b64 = key => `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`;

module.exports = app => {
  console.log('[v2][load] icu_get_plan_gw');

  app.get('/gw/icu/plan', async (req, res) => {
    const uid = res.locals.user_id || null;
    if (!uid) return res.status(401).json({ status:401, error:'missing_or_invalid_token' });

    const oldest = clamp(req.query.oldest);
    const newest = clamp(req.query.newest);

    try {
      const { rows } = await getPool().query('select api_key, athlete_id from "user" where id=$1 limit 1', [uid]);
      if (!rows?.length) return res.status(400).json({ status:400, error:'icu_creds_not_found' });

      const api_key = rows[0].api_key;
      const athlete = normAthlete(rows[0].athlete_id);
      if (!api_key || !athlete) {
        return res.status(400).json({ status:400, error:'icu_creds_invalid', missing:{ api_key:!api_key, athlete_id:!athlete } });
      }

      const base = process.env.ICU_BASE_URL || 'https://intervals.icu/api/v1';
      const u = new URL(`${base}/athlete/${athlete}/events`);
      if (oldest) u.searchParams.set('oldest', oldest);
      if (newest) u.searchParams.set('newest', newest);
      u.searchParams.set('includePlanned', 'true');

      const r = await fetch(u, { headers: { Authorization: b64(api_key), Accept:'application/json' } });
      const t = await r.text();
      if (!r.ok) return res.status(r.status).json({ status:r.status, error:'icu_upstream_error', detail:t });
      res.type('application/json').send(t);
    } catch (e) {
      return res.status(502).json({ status:502, error:'icu_upstream_error', detail:e.message });
    }
  });
};
