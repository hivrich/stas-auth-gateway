const express = require('express');
const { pipeProxy } = require('../helpers/simpleProxy');
const { getRequestUserId } = require('../lib/request-auth');

const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL || 'http://127.0.0.1:3336';
const STAS_KEY  = process.env.STAS_API_KEY || '';
const router = express.Router();

function rewriteIdentityQuery(value, uid) {
  if (!value) return value;
  const parsed = new URL(value, 'http://gateway.local');
  parsed.searchParams.delete('uid');
  parsed.searchParams.set('user_id', uid);
  return `${parsed.pathname}${parsed.search}`;
}

function requireUserId(req, res, next) {
  const uid = getRequestUserId(req);
  if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
  const query = { ...(req.query || {}) };
  delete query.uid;
  query.user_id = uid;
  req.query = query;
  req.url = rewriteIdentityQuery(req.url, uid);
  req.originalUrl = rewriteIdentityQuery(req.originalUrl, uid);
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
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });
    qs.set('user_id', String(uid));
    const env = fs.readFileSync('/opt/stas-db-bridge/.env','utf8');
    const apikey = (env.split(/\r?\n/).find(x=>/^API_KEY=/.test(x))||'').split('=',2)[1].trim();
    const r = await fetch(`http://127.0.0.1:3336/api/db/user_summary?${qs.toString()}`, { headers: { 'X-API-Key': apikey }});
    if (!r.ok) return res.status(r.status).json({ ok:false, status:r.status });
    const j = await r.json();
    return res.json(j);
  } catch(e) { return res.status(500).json({ ok:false, error:'user_summary_proxy_error' }); }
});
