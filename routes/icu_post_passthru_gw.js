const express = require('express');
const { getIcuRequestAuth } = require('../lib/icu-request-auth');

module.exports = function(app){
  const router = express.Router();

  router.post('/events', express.json({limit:'1mb'}), async (req, res) => {
    try{
      const q = req.query || {};
      const body = req.body || {};

      const ua = (req.get && req.get('user-agent')) || req.headers['user-agent'] || '';
      const isGPT = /ChatGPT-User/i.test(ua);
      const dryParam = String(q.dry_run || '').toLowerCase();

      // Новая политика:
      //  - для GPT: REAL по умолчанию; DRY только если явно dry_run=true
      //  - для остальных: DRY по умолчанию; REAL только если явно dry_run=false
      const isDryRun = isGPT ? (dryParam === 'true')
                             : (dryParam ? (dryParam !== 'false') : true);

      // Поддерживаем {events:[…]} и bare-array
      const eventsIn = Array.isArray(body.events) ? body.events : (Array.isArray(body) ? body : []);
      const events = Array.isArray(eventsIn) ? eventsIn : [];

      if (isDryRun){
        return res.json({ ok:true, dry_run:true, count: events.length, mode_hint: isGPT?'gpt':'default' });
      }

      const auth = await getIcuRequestAuth(req);
      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';

      // Нормализация: гарантируем category и единое поле external_id.
      // Intervals.icu должен обновлять событие с тем же external_id, а не создавать дубль.
      const payloadArr = events.map(ev => {
        const normalized = { category:'WORKOUT', ...ev };
        if (normalized.externalId) {
          normalized.external_id = normalized.external_id || normalized.externalId;
          delete normalized.externalId;
        }
        return normalized;
      });
      const url = `${API_BASE}/athlete/${encodeURIComponent(auth.athleteId)}/events/bulk?upsert=true`;
      const bodyJson = JSON.stringify(payloadArr);

      const hdrs = (mode)=> {
        const h = { 'Accept':'application/json', 'Content-Type':'application/json' };
        if (mode==='bearer') h['Authorization'] = `Bearer ${auth.token}`;
        else h['Authorization'] = `Basic ${Buffer.from(`API_KEY:${auth.token}`).toString('base64')}`;
        return h;
      };

      let r = await fetch(url, { method:'POST', headers: hdrs('bearer'), body: bodyJson });
      if ((r.status===401 || r.status===403) && auth.authMode === 'legacy') {
        r = await fetch(url, { method:'POST', headers: hdrs('basic'), body: bodyJson });
      }
      if ((r.status===401 || r.status===403) && auth.authMode === 'intervals') {
        return res.status(401).json({
          ok:false,
          error:'auth_required',
          message:'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
        });
      }

      const text = await r.text(); let json; try{ json = JSON.parse(text);}catch(_){}
      if (!r.ok){
        return res.status(502).json({ ok:false, error:'icu_upstream_error', status:r.status, detail:text.slice(0,500) });
      }

      const result = (json && typeof json==='object') ? json : { ok:true };
      if (!('ok' in result)) result.ok = true;
      if (!('dry_run' in result)) result.dry_run = false;
      result.mode_hint = isGPT ? 'gpt' : 'default';
      return res.json(result);

    }catch(e){
      if (e?.status === 401) {
        return res.status(401).json({ ok:false, error:'missing_or_invalid_token' });
      }
      if (e?.status === 404) {
        return res.status(404).json({ ok:false, error:'icu_creds_not_found' });
      }
      console.error('[icu][POST][passthru] error:', e && e.stack || e);
      return res.status(500).json({ ok:false, error:'post_passthru_failed' });
    }
  });

  app.use('/gw/icu', router);
  console.log('[icu][POST][passthru] /gw/icu/events attached (BEFORE real_gw, BULK, GPT=REAL-by-default)');
};
