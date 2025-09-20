'use strict';
const express = require('express');
const { URL } = require('url');
const { requireUser, buildBasicAuthHeader } = require('../helpers/auth');
const { sendProxied, withTimeout } = require('../helpers/proxy');

const router = express.Router();
const ICU_BASE  = process.env.ICU_API_BASE_URL;
const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL;
const STAS_KEY  = process.env.STAS_API_KEY;

router.use(requireUser);

function normalizeAthleteId(d){
  if (d.athlete_id && typeof d.athlete_id === 'string') return d.athlete_id.startsWith('i')?d.athlete_id:`i${d.athlete_id}` ;
  if (d.athlete_id_num != null){ const s=String(d.athlete_id_num).trim(); return s.startsWith('i')?s:`i${s}` ; }
  return null;
}

async function loadIcuCredsFromSTAS(user_id){
  if (!STAS_BASE || !STAS_KEY) throw new Error('STAS not configured');
  const u = new URL('/api/db/icu_creds', STAS_BASE); u.searchParams.set('user_id', user_id);
  const r = await fetch(u.toString(), { headers:{ 'X-API-Key':STAS_KEY, 'Accept':'application/json' }});
  if (r.status===404) return null;
  if (!r.ok) throw new Error(`STAS icu_creds ${r.status}` );
  const data = await r.json();
  const athlete_id = normalizeAthleteId(data);
  return { api_key: data.api_key, athlete_id };
}

async function icuProxy(req,res,path,methodOverride){
  try{
    if(!ICU_BASE) return res.status(500).json({ error:'icu_not_configured' });
    const creds = await loadIcuCredsFromSTAS(req.user_id);
    if(!creds || !creds.api_key || !creds.athlete_id) return res.status(403).json({ error:'forbidden', detail:'No ICU creds in STAS for this user_id' });
    const incoming = new URL(req.originalUrl, `http://${req.headers.host}` );
    const target   = new URL(`${ICU_BASE}/athlete/${encodeURIComponent(creds.athlete_id)}/${path}` );
    incoming.searchParams.forEach((v,k)=>target.searchParams.set(k,v));
    const method = methodOverride || req.method;
    const headers = { 'Authorization': buildBasicAuthHeader(creds.api_key, creds.api_key), 'Accept':'application/json','Content-Type':'application/json' };
    const { signal, clear } = withTimeout(20000);
    const opts = { method, headers, signal };
    if (/^(POST|PUT|PATCH)$/i.test(method)) opts.body = JSON.stringify(req.body || {});
    const r = await fetch(target.toString(), opts);
    clear();
    await sendProxied(res, r, { method });
  }catch(e){
    console.error('[ICU proxy error]', e);
    res.status(502).json({ error:'bad_gateway', detail:String(e.message||e) });
  }
}

router.get('/activities',   (req,res)=>icuProxy(req,res,'activities'));
router.get('/events',       (req,res)=>icuProxy(req,res,'events'));
router.post('/events/bulk', (req,res)=>icuProxy(req,res,'events/bulk','POST'));
router.delete('/events',    (req,res)=>icuProxy(req,res,'events','DELETE'));
module.exports = router;
