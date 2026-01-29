const express = require('express');
const r = express.Router();

const ICU_BASE = process.env.ICU_API_BASE_URL || 'https://intervals.icu/api/v1';

async function getCredsFallback(uid){
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.STAS_PGURL });
  await client.connect();
  try {
    const a = await client.query(
      'SELECT api_key, athlete_id FROM "user" WHERE id=$1::bigint LIMIT 1',[uid]
    );
    if (a.rows?.[0]?.api_key && a.rows?.[0]?.athlete_id) {
      return { api_key:a.rows[0].api_key, athlete_id:a.rows[0].athlete_id };
    }
    const b = await client.query(
      `SELECT COALESCE(api_key,icu_api_key) AS api_key,
              COALESCE(athlete_id,icu_athlete_id) AS athlete_id
         FROM gw_user_creds WHERE user_id=$1::text LIMIT 1`, [String(uid)]
    );
    if (b.rows?.[0]?.api_key && b.rows?.[0]?.athlete_id) {
      return { api_key:b.rows[0].api_key, athlete_id:b.rows[0].athlete_id };
    }
    return null;
  } finally { try{ await client.end(); }catch(_){} }
}

r.get('/icu/plan/_probe_open', async (req,res)=>{
  res.set('X-Route','icu_probe_open');
  const oldest = String(req.query.oldest||'').trim();
  const newest = String(req.query.newest||'').trim();
  const uid    = String(req.query.uid||'').trim();
  if (uid) res.set('X-ICU-Uid', uid);
  if (!uid || !oldest || !newest) { res.set('X-ICU-Status','skip'); return res.json([]); }

  try {
    const creds   = await getCredsFallback(uid);
    const apiKey  = creds?.api_key;
    const athlete = creds?.athlete_id;
    res.set('X-ICU-KeyLen', String(apiKey ? String(apiKey).length : 0));
    res.set('X-ICU-Athlete', athlete || '');
    if (!apiKey || !athlete) { res.set('X-ICU-Status','no-creds'); return res.json([]); }

    const url  = `${ICU_BASE}/athlete/${encodeURIComponent(athlete)}/events?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
    res.set('X-ICU-URL', url);
    const auth = 'Basic ' + Buffer.from(`API_KEY:${apiKey}`).toString('base64');

    const rr = await fetch(url, { headers: { Authorization: auth } });
    res.set('X-ICU-Http', String(rr.status));
    if (!rr.ok) {
      const txt = await rr.text().catch(()=> '');
      res.set('X-ICU-Status','icu-bad');
      return res.status(502).json({ ok:false, source:'icu', status: rr.status, body: (txt||'').slice(0,400) });
    }

    let data = await rr.json().catch(()=>[]);
    const len = Array.isArray(data) ? data.length : 0;
    res.set('X-ICU-Len', String(len));
    res.set('X-ICU-Status','ok');
    if (!Array.isArray(data)) data = [];
    return res.json(data);
  } catch(e){
    res.set('X-ICU-Status','exception');
    res.set('X-ICU-Err', String(e?.message || e).slice(0,120));
    return res.json([]);
  }
});

module.exports = r;
