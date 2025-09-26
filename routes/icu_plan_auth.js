const r = require('express').Router();
const { Pool } = require('pg');

const ICU_BASE = process.env.ICU_API_BASE_URL || 'https://intervals.icu/api/v1';
const PGURL    = process.env.STAS_PGURL;
const pool     = new Pool({ connectionString: PGURL });

function bearerUid(req){
  const h = req.headers.authorization || '';
  const m = /^\s*Bearer\s+(.+)\s*$/i.exec(h);
  if(!m) return null;
  const tok = m[1].trim();
  if(!tok.startsWith('t_')) return null;
  try { const j = JSON.parse(Buffer.from(tok.slice(2),'base64').toString('utf8')); return j && (j.uid || j.user_id) || null; }
  catch { return null; }
}

async function loadCreds(uid){
  const a = await pool.query('SELECT api_key, athlete_id FROM "user" WHERE id=$1 LIMIT 1', [uid]);
  if (a.rows[0] && a.rows[0].api_key && a.rows[0].athlete_id) return { api_key: a.rows[0].api_key, athlete_id: a.rows[0].athlete_id };
  const b = await pool.query(
    'SELECT COALESCE(api_key,icu_api_key) AS api_key, COALESCE(athlete_id,icu_athlete_id) AS athlete_id FROM gw_user_creds WHERE user_id=$1::text LIMIT 1',
    [String(uid)]
  );
  return b.rows[0] || {};
}

r.get('/icu/plan', async (req,res)=>{
  res.set('X-Route','icu_plan_fix'); // чтобы не трогать потребителей
  try{
    const uid = (req.auth && (req.auth.user_id || req.auth.uid)) || bearerUid(req);
    res.set('X-ICU-Uid', String(uid||''));

    const sp = new URL(req.originalUrl, 'http://x').searchParams;
    const oldest = String(sp.get('oldest')||'').trim();
    const newest = String(sp.get('newest')||'').trim();
    res.set('X-ICU-Oldest', oldest);
    res.set('X-ICU-Newest', newest);
    if(!uid || !oldest || !newest){ res.set('X-ICU-Status','skip-no-uid-or-range'); return res.json([]); }

    const { api_key, athlete_id } = await loadCreds(uid);
    res.set('X-ICU-KeyLen', String((api_key||'').length));
    res.set('X-ICU-Athlete', String(athlete_id||''));
    if(!api_key || !athlete_id){ res.set('X-ICU-Status','skip-no-creds'); return res.json([]); }

    const url = `${ICU_BASE}/athlete/${encodeURIComponent(athlete_id)}/events?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
    const rr  = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from('API_KEY:'+api_key).toString('base64') }});
    res.set('X-ICU-Http', String(rr.status));
    if(!rr.ok){ const txt = await rr.text().catch(()=> ''); res.set('X-ICU-Status','icu-error'); return res.status(502).json({ ok:false, source:'icu', status: rr.status, body: (txt||'').slice(0,400) }); }

    const data = await rr.json().catch(()=> []);
    const len  = Array.isArray(data) ? data.length : 0;
    res.set('X-ICU-Len', String(len));
    res.set('X-ICU-Status','ok');
    return res.json(Array.isArray(data)?data:[]);
  }catch(e){
    try{ res.set('X-ICU-Status','exception'); res.set('X-ICU-Err', (e && e.message) || String(e)); }catch(_){}
    return res.json([]);
  }
});

module.exports = r;
