const express = require('express');
const r = express.Router();

const ICU_BASE = process.env.ICU_API_BASE_URL || 'https://intervals.icu/api/v1';

// Пытаемся взять getCreds2 из credsDao, иначе используем локальный SQL фолбэк.
let getCreds2 = null;
try {
  const dao = require('../credsDao');
  if (dao && typeof dao.getCreds2 === 'function') getCreds2 = dao.getCreds2;
} catch(_e){ /* noop */ }

async function getCredsFallback(uid){
  const { Client } = require('pg');
  const url = process.env.STAS_PGURL;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // 1) user
    const a = await client.query('SELECT api_key, athlete_id FROM "user" WHERE id=$1::bigint LIMIT 1',[uid]);
    if (a.rows && a.rows[0] && a.rows[0].api_key && a.rows[0].athlete_id) {
      return { api_key: a.rows[0].api_key, athlete_id: a.rows[0].athlete_id };
    }
    // 2) gw_user_creds (fallback)
    const b = await client.query(
      `SELECT COALESCE(api_key, icu_api_key) AS api_key,
              COALESCE(athlete_id, icu_athlete_id) AS athlete_id
         FROM gw_user_creds WHERE user_id=$1::text LIMIT 1`, [String(uid)]
    );
    if (b.rows && b.rows[0] && b.rows[0].api_key && b.rows[0].athlete_id) {
      return { api_key: b.rows[0].api_key, athlete_id: b.rows[0].athlete_id };
    }
    return null;
  } finally {
    try{ await client.end(); } catch(_e){}
  }
}

function b64urlToUtf8(s){
  try {
    const b64 = s.replace(/-/g,'+').replace(/_/g,'/').replace(/\s+/g,'');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    return Buffer.from(b64 + pad, 'base64').toString('utf8');
  } catch(_e){ return ''; }
}

function uidFromBearer(req){
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || !/^Bearer\s+/i.test(h)) return null;
  let raw = h.replace(/^Bearer\s+/i,'').trim();
  if (raw.startsWith('t_')) raw = raw.slice(2);
  const txt = b64urlToUtf8(raw);
  try {
    const json = JSON.parse(txt);
    const uid = json.uid || json.user_id || json.sub || null;
    return uid ? String(uid) : null;
  } catch(_e){ return null; }
}

function pickUid(req){
  if (req.auth && (req.auth.user_id || req.auth.uid)) return String(req.auth.user_id || req.auth.uid);
  const fromBearer = uidFromBearer(req);
  if (fromBearer) return fromBearer;
  if (req.query && (req.query.user_id || req.query.uid)) return String(req.query.user_id || req.query.uid);
  if (req.headers['x-user-id']) return String(req.headers['x-user-id']);
  return null;
}

async function loadCreds(uid, res){
  try {
    if (getCreds2) {
      const c = await getCreds2(uid);
      if (c && c.api_key && c.athlete_id) { res.set('X-ICU-Creds','dao'); return c; }
    }
    const c2 = await getCredsFallback(uid);
    if (c2 && c2.api_key && c2.athlete_id) { res.set('X-ICU-Creds','fallback-sql'); return c2; }
    res.set('X-ICU-Creds','missing');
    return null;
  } catch(e){
    res.set('X-ICU-Creds','exception');
    res.set('X-ICU-Err', String(e && e.message || e).slice(0,120));
    throw e;
  }
}

r.get('/icu/plan', async (req, res) => {
  res.set('X-Route','icu_plan_fix');
  try {
    const oldest = String(req.query.oldest || '').trim();
    const newest = String(req.query.newest || '').trim();
    const uid    = pickUid(req);
    if (uid) res.set('X-ICU-Uid', uid);

    if (!uid || !oldest || !newest) {
      res.set('X-ICU-Status', 'skip-no-uid-or-range');
      return res.json([]);
    }

    // 1) креды
    res.set('X-ICU-Where','creds');
    const creds = await loadCreds(uid, res);
    const apiKey  = creds && creds.api_key;
    const athlete = creds && creds.athlete_id;
    res.set('X-ICU-KeyLen', String(apiKey ? String(apiKey).length : 0));
    res.set('X-ICU-Athlete', athlete || '');

    if (!apiKey || !athlete) {
      res.set('X-ICU-Status', 'skip-no-creds');
      return res.json([]);
    }

    // 2) ICU fetch
    res.set('X-ICU-Where','fetch');
    const url  = `${ICU_BASE}/athlete/${encodeURIComponent(athlete)}/events?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
    const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');

    const rr = await fetch(url, { headers: { Authorization: auth } });
    res.set('X-ICU-Http', String(rr.status));
    if (!rr.ok) {
      const body = await rr.text().catch(()=> '');
      res.set('X-ICU-Status','icu-bad');
      return res.status(502).json({ ok:false, source:'icu', status: rr.status, body: (body||'').slice(0,400) });
    }

    // 3) JSON
    res.set('X-ICU-Where','json');
    let data = await rr.json().catch((e)=>{ res.set('X-ICU-Err', String(e && e.message || e).slice(0,120)); return []; });
    const len = Array.isArray(data) ? data.length : 0;
    res.set('X-ICU-Len', String(len));
    if (!Array.isArray(data)) data = [];
    res.set('X-ICU-Status','ok');
    return res.json(data);
  } catch (e) {
    console.error('[icu_plan_fix][ERR]', e && (e.stack||e));
    if (!res.headersSent) {
      res.set('X-ICU-Status','exception');
      res.set('X-ICU-Err', String(e && e.message || e).slice(0,120));
      res.json([]);
    }
  }
});

// Диагностика: покажем, что именно видим по кредам и как выглядит URL
r.get('/icu/plan/_probe', async (req,res)=>{
  const oldest = String(req.query.oldest || '').trim();
  const newest = String(req.query.newest || '').trim();
  const uid    = pickUid(req);
  let info = { ok:true, uid, oldest, newest };
  try{
    const creds = await (async ()=> {
      if (getCreds2) try { return await getCreds2(uid); } catch(_e){}
      return await getCredsFallback(uid);
    })();
    info.have_creds = !!(creds && creds.api_key && creds.athlete_id);
    info.api_key_len = creds && creds.api_key ? String(creds.api_key).length : 0;
    info.athlete_id  = creds && creds.athlete_id || null;
    if (info.athlete_id) {
      info.icu_url = `${ICU_BASE}/athlete/${encodeURIComponent(info.athlete_id)}/events?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
    }
  }catch(e){
    info.error = String(e && e.message || e);
  }
  res.json(info);
});

module.exports = r;
