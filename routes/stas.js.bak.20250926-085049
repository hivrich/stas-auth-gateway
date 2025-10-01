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
