const express = require('express');
const { pipeProxy } = require('../helpers/simpleProxy');

const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_API_KEY || '';
const router = express.Router();

function requireUserId(req, res, next) {
  if (!req.query.user_id) return res.status(400).json({ error: 'user_id (integer) is required' });
  next();
}

// Рерайт префикса: /gw/api/... -> /api/...
const rw = (p)=> p.replace(/^\/gw\/api\//, '/api/');

// alias trainings -> activities с Deprecation
router.get('/db/trainings', requireUserId, (req, res) => {
  res.set('Deprecation','true');
  res.set('Link','</gw/api/db/activities>; rel="successor-version"');
  res.set('Sunset','Wed, 31 Dec 2025 23:59:59 GMT');
  req.url = (req.originalUrl || req.url).replace('/db/trainings','/db/activities');
  return pipeProxy(STAS_BASE, req, res, {'X-API-Key': STAS_KEY}, rw);
});

router.get('/db/activities',      requireUserId, (req, res) => pipeProxy(STAS_BASE, req, res, {'X-API-Key': STAS_KEY}, rw));
router.get('/db/activities_full', requireUserId, (req, res) => pipeProxy(STAS_BASE, req, res, {'X-API-Key': STAS_KEY}, rw));
router.get('/db/user_summary',    requireUserId, (req, res) => pipeProxy(STAS_BASE, req, res, {'X-API-Key': STAS_KEY}, rw));

module.exports = router;
// explicit: /gw/api/db/user_summary → DB-Bridge
router.get('/api/db/user_summary', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const fs = require('fs');
    const qs = new URLSearchParams();
    const uid = (req.user_id) || (req.bearer && req.bearer.uid) || req.query.user_id;
    if (uid) qs.set('user_id', String(uid));
    const env = fs.readFileSync('/opt/stas-db-bridge/.env','utf8');
    const apikey = (env.split(/\r?\n/).find(x=>/^API_KEY=__SET_IN_ENV__
    const r = await fetch(`http://127.0.0.1:3336/api/db/user_summary?${qs.toString()}`, { headers: { 'X-API-Key': apikey }});
    if (!r.ok) return res.status(r.status).json({ ok:false, status:r.status });
    const j = await r.json();
    return res.json(j);
  } catch(e) { return res.status(500).json({ ok:false, error:'user_summary_proxy_error' }); }
});
