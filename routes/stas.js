'use strict';
const express = require('express');
const { URL } = require('url');
const { requireUser } = require('../helpers/auth');
const { sendProxied, withTimeout } = require('../helpers/proxy');

const router = express.Router();
const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL;
const STAS_KEY  = process.env.STAS_API_KEY;

router.use(requireUser);

async function stasProxy(req, res, targetPath) {
  try {
    if (!STAS_BASE || !STAS_KEY) return res.status(500).json({ error: 'stas_not_configured' });
    const incoming = new URL(req.originalUrl, `http://${req.headers.host}` );
    const target   = new URL(`/api/${targetPath}` , STAS_BASE);
    incoming.searchParams.forEach((v,k)=>target.searchParams.set(k,v));
    target.searchParams.set('user_id', req.user_id);
    const { signal, clear } = withTimeout(15000);
    const opts = { method:req.method, headers:{ 'X-API-Key':STAS_KEY, 'Accept':'application/json','Content-Type':'application/json' }, signal };
    if (/^(POST|PUT|PATCH)$/i.test(req.method)) opts.body = JSON.stringify(req.body || {});
    const r = await fetch(target.toString(), opts);
    clear();
    const data = await r.json(); res.json(data);
  } catch (e) {
    console.error('[STAS proxy error]', e);
    res.status(502).json({ error:'bad_gateway', detail:String(e.message||e) });
  }
}

router.get('/db/user_summary',    (req,res)=>stasProxy(req,res,'db/user_summary'));
router.get('/db/activities',      (req,res)=>stasProxy(req,res,'db/activities'));
router.get('/db/activities_full', (req,res)=>stasProxy(req,res,'db/activities_full'));
router.get('/db/monthly_summary', (req,res)=>stasProxy(req,res,'db/monthly_summary'));

// DEPRECATED alias: /trainings -> /activities
router.get('/db/trainings', (req,res)=>{
  res.setHeader('Deprecation','true');
  res.setHeader('Link','</gw/api/db/activities>; rel="successor-version"');
  res.setHeader('Sunset','Wed, 31 Dec 2025 23:59:59 GMT');
  return stasProxy(req,res,'db/activities');
});

module.exports = router;
