const express = require('express');

function decodeUidFromBearer(auth){
  try{
    if(!auth) return null;
    const m = String(auth).match(/Bearer\s+t_([A-Za-z0-9_-]+)/i);
    if(!m) return null;
    let b64 = m[1].replace(/-/g,'+').replace(/_/g,'/'); while(b64.length%4!==0) b64+='=';
    const obj = JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
    const uid = (obj && (obj.uid||obj.user_id)) ? String(obj.uid||obj.user_id) : null;
    return uid && /^\d+$/.test(uid) ? uid : null;
  }catch(_){ return null; }
}

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

      // uid: query или Bearer t_<b64>{"uid":...}
      const authIn = (req.get && req.get('authorization')) || req.headers['authorization'];
      const uid = String(q.user_id || decodeUidFromBearer(authIn) || '').trim();
      if (!uid) return res.status(400).json({ ok:false, error:'missing_user_id' });

      // токен из DB-bridge
      const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
      const STAS_KEY  = process.env.STAS_KEY  || '';
      const credsUrl = new URL(`${STAS_BASE}/api/db/icu_creds`); credsUrl.searchParams.set('user_id', uid);
      const cr = await fetch(credsUrl, { headers: STAS_KEY ? { 'X-API-Key': STAS_KEY } : {} });
      if (!cr.ok) return res.status(502).json({ ok:false, error:'icu_creds_fetch_failed', status:cr.status });
      const cj = await cr.json();
      if (!cj || !cj.ok || !cj.api_key) return res.status(400).json({ ok:false, error:'invalid_icu_creds' });

      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';
      const token = String(cj.api_key);

      // Нормализация: гарантируем category
      const payloadArr = events.map(ev => ({ category:'WORKOUT', ...ev }));
      const url = `${API_BASE}/athlete/0/events/bulk`;
      const bodyJson = JSON.stringify(payloadArr);

      const hdrs = (mode)=> {
        const h = { 'Accept':'application/json', 'Content-Type':'application/json' };
        if (mode==='bearer') h['Authorization'] = `Bearer ${token}`;
        else h['Authorization'] = `Basic ${Buffer.from(`API_KEY:${token}`).toString('base64')}`;
        return h;
      };

      let r = await fetch(url, { method:'POST', headers: hdrs('bearer'), body: bodyJson });
      if (r.status===401 || r.status===403) {
        r = await fetch(url, { method:'POST', headers: hdrs('basic'), body: bodyJson });
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
      console.error('[icu][POST][passthru] error:', e && e.stack || e);
      return res.status(500).json({ ok:false, error:'post_passthru_failed' });
    }
  });

  app.use('/gw/icu', router);
  console.log('[icu][POST][passthru] /gw/icu/events attached (BEFORE real_gw, BULK, GPT=REAL-by-default)');
};
