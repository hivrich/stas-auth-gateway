const express = require('express');
const router  = express.Router();
const { buildStasSourceHeaders } = require('../lib/request-source');

function getDbBridgeApiKey() {
  return process.env.STAS_KEY || process.env.DB_BRIDGE_API_KEY || '';
}

function uidFromReq(req) {
  return req.user_id || (req.bearer && req.bearer.uid) || req.query.user_id || null;
}

/**
 * GET /gw/trainings
 * - default: компактный список как было ранее (массива объектов из /gw/api/db/trainings)
 * - full=1: детальный список из DB-Bridge /api/db/activities_full (если недоступно — мягкий фоллбек)
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const uid = uidFromReq(req);
    if (!uid) return res.json([]);

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));
    for (const k of ['days','oldest','newest','limit','offset']) {
      if (req.query[k] != null && req.query[k] !== '') qs.set(k, String(req.query[k]));
    }

    const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';
    const apiKey = getDbBridgeApiKey();

    // full=1 → детальные активности
    const wantFull = String(req.query.full || '') === '1' || String(req.query.full || '').toLowerCase() === 'true';
    const endpoint = wantFull ? '/api/db/activities_full' : '/api/db/activities';

    const url = `${STAS_BASE}${endpoint}?${qs.toString()}`;
    const r = await fetch(url, {
      headers: buildStasSourceHeaders(req, { 'X-API-Key': apiKey, 'Accept': 'application/json' }),
    });
    if (!r.ok) return res.json([]);
    const j = await r.json();
    const arr = Array.isArray(j.activities) ? j.activities
              : Array.isArray(j.trainings)  ? j.trainings
              : Array.isArray(j) ? j : [];
    return res.json(arr);

  } catch (e) {
    return res.json([]);
  }
});

module.exports = router;
