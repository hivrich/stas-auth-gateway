'use strict';
const { getIcuRequestAuth } = require('../lib/icu-request-auth');
const { applyInferredWorkoutTarget } = require('../lib/structured_workout_target');
const { normalizeEventDateTimes } = require('../lib/icu_event_normalize');

const yes = v => /^(1|true|yes|on)$/i.test((v ?? '').toString());
const normAthlete = v => (v ? (String(v).trim().startsWith('i') ? String(v).trim() : `i${String(v).trim()}`) : null);
const b64 = key => `Basic ${Buffer.from(`API_KEY:${key}`).toString('base64')}`;

const RL_MAX = Number(process.env.RATE_LIMIT_EVENTS || 5);
const RL_WIN = Number(process.env.RATE_WINDOW_MS || 60_000);
const rlBuckets = new Map();
function rlAllow(uid){ const now=Date.now(); const a=(rlBuckets.get(uid)||[]).filter(ts => now-ts < RL_WIN); if(a.length>=RL_MAX) return {ok:false,retryAfterMs: RL_WIN-(now-a[0])}; a.push(now); rlBuckets.set(uid,a); return {ok:true}; }

module.exports = app => {
  console.log('[v2][load] icu_post_real_gw');

  app.post('/gw/icu/events', async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    try {
      const auth = await getIcuRequestAuth(req);
      if (!events.length) return res.status(400).json({ status:400, error:'no_events' });

      const dry = yes(req.query?.dry_run);
      if (!dry) {
        const gate = rlAllow(auth.userId);
        if (!gate.ok) {
          const secs=Math.ceil(gate.retryAfterMs/1000);
          res.set('Retry-After', String(secs));
          return res.status(429).json({ status:429, error:'rate_limited', retry_after_sec: secs, limit: RL_MAX, window_ms: RL_WIN });
        }
      }
      if (dry) return res.json({ ok:true, dry_run:true, count: events.length });

      const base = process.env.ICU_BASE_URL || process.env.ICU_API_BASE_URL || 'https://intervals.icu/api/v1';
      const athlete = auth.authMode === 'legacy' ? normAthlete(auth.athleteId) : auth.athleteId;
      const url  = `${base}/athlete/${athlete}/events/bulk?upsert=true` + (dry ? '&dry_run=true' : '');

      const payload = events.map(e => {
        const normalized = (e && !e.external_id && e.externalId)
          ? (({ externalId, ...rest }) => ({ ...rest, external_id: externalId }))(e)
          : { ...e };
        normalizeEventDateTimes(normalized);
        return applyInferredWorkoutTarget(normalized);
      });

      // Bearer (OAuth) → fallback на Basic (API_KEY)
      let r = await fetch(url, {
        method:'POST',
        headers:{ Authorization:`Bearer ${auth.token}`, 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      });
      if ((r.status===401 || r.status===403) && auth.authMode === 'legacy') {
        r = await fetch(url, {
          method:'POST',
          headers:{ Authorization:b64(auth.token), 'Content-Type':'application/json' },
          body: JSON.stringify(payload)
        });
      }
      if ((r.status===401 || r.status===403) && auth.authMode === 'intervals') {
        return res.status(401).json({
          status:401,
          error:'auth_required',
          message:'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
        });
      }

      const text = await r.text().catch(()=> '');
      if (!r.ok) return res.status(r.status).json({ status:r.status, error:'icu_upstream_error', detail: text.slice(0,400) });
      return res.json({ ok:true, dry_run:false, count: events.length, upstream_status: r.status });
    } catch (e) {
      if (e?.status === 401) return res.status(401).json({ status:401, error:'missing_or_invalid_token' });
      if (e?.status === 404) return res.status(404).json({ status:404, error:'icu_creds_not_found' });
      return res.status(502).json({ status:502, error:'icu_upstream_error', detail: String(e?.message||e) });
    }
  });
};
