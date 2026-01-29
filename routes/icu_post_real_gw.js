'use strict';
const { Pool } = require('pg');
let pool; const getPool = () => pool ?? (pool = new Pool({ connectionString: process.env.STAS_PGURL }));

const yes = v => /^(1|true|yes|on)$/i.test((v ?? '').toString());
const normAthlete = v => (v ? (String(v).trim().startsWith('i') ? String(v).trim() : `i${String(v).trim()}`) : null);
const b64 = key => `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`;

function uidFromBearer(req){
  try{
    const h = String(req.get('authorization')||'');
    const m = h.match(/^bearer\s+t_([A-Za-z0-9\-_]+)/i);
    if(!m) return null;
    const raw = Buffer.from(m[1].replace(/-/g,'+').replace(/_/g,'/'),'base64').toString();
    const obj = JSON.parse(raw);
    const u = String(obj?.uid ?? '');
    return /^\d+$/.test(u) ? u : null;
  }catch{ return null; }
}

const RL_MAX = Number(process.env.RATE_LIMIT_EVENTS || 5);
const RL_WIN = Number(process.env.RATE_WINDOW_MS || 60_000);
const rlBuckets = new Map();
function rlAllow(uid){ const now=Date.now(); const a=(rlBuckets.get(uid)||[]).filter(ts => now-ts < RL_WIN); if(a.length>=RL_MAX) return {ok:false,retryAfterMs: RL_WIN-(now-a[0])}; a.push(now); rlBuckets.set(uid,a); return {ok:true}; }

module.exports = app => {
  console.log('[v2][load] icu_post_real_gw');

  app.post('/gw/icu/events', async (req, res) => {
    const hasAuth = /^bearer\s+/i.test(req.get('authorization')||'');
    const uid = res.locals.user_id || req.query?.user_id || uidFromBearer(req);
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    if (!hasAuth || !uid) return res.status(401).json({ status:401, error:'missing_or_invalid_token' });
    if (!events.length)   return res.status(400).json({ status:400, error:'no_events' });

    const dry = yes(req.query?.dry_run);
    if (!dry) {
      const gate = rlAllow(uid);
      if (!gate.ok) { const secs=Math.ceil(gate.retryAfterMs/1000); res.set('Retry-After', String(secs));
        return res.status(429).json({ status:429, error:'rate_limited', retry_after_sec: secs, limit: RL_MAX, window_ms: RL_WIN }); }
    }
    if (dry) return res.json({ ok:true, dry_run:true, count: events.length });

    try {
      const { rows } = await getPool().query('select "api_key","athlete_id" from "user" where "id"=$1 limit 1',[uid]);
      if (!rows?.length) return res.status(400).json({ status:400, error:'icu_creds_not_found' });
      const api_key = rows[0].api_key;
      const athlete = normAthlete(rows[0].athlete_id);
      if (!api_key || !athlete) return res.status(400).json({ status:400, error:'icu_creds_invalid', missing:{ api_key:!api_key, athlete_id:!athlete } });

      const base = process.env.ICU_BASE_URL || process.env.ICU_API_BASE_URL || 'https://intervals.icu/api/v1';
      const url  = `${base}/athlete/${athlete}/events/bulk?upsert=true` + (dry ? '&dry_run=true' : '');

      const payload = events.map(e => (e && !e.external_id && e.externalId)
        ? (({ externalId, ...rest }) => ({ ...rest, external_id: externalId }))(e)
        : e);

      // Bearer (OAuth) → fallback на Basic (API_KEY)
      let r = await fetch(url, {
        method:'POST',
        headers:{ Authorization:`Bearer ${api_key}`, 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      if (r.status===401 || r.status===403) {
        r = await fetch(url, {
          method:'POST',
          headers:{ Authorization:b64(api_key), 'Content-Type':'application/json' },
          body: JSON.stringify(payload)
        });
      }

      const text = await r.text().catch(()=> '');
      if (!r.ok) return res.status(r.status).json({ status:r.status, error:'icu_upstream_error', detail: text.slice(0,400) });
      return res.json({ ok:true, dry_run:false, count: events.length, upstream_status: r.status });
    } catch (e) {
      return res.status(502).json({ status:502, error:'icu_upstream_error', detail: String(e?.message||e) });
    }
  });
};
