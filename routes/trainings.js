const express = require('express');
const router  = express.Router();
const getStasKey = require('../lib/get_stas_key');
const { getRequestUserId } = require('../lib/request-auth');
const { buildStasSourceHeaders } = require('../lib/request-source');

const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

/**
 * GET /gw/trainings
 * Backward-compatible training list route for Actions and MCP.
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ status: 401, error: 'missing_or_invalid_token' });

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));
    for (const k of ['days','oldest','newest','limit','offset','full']) {
      if (req.query[k] != null && req.query[k] !== '') qs.set(k, String(req.query[k]));
    }

    const url = new URL(`/api/db/trainings?${qs.toString()}`, STAS_BASE);
    const response = await fetch(url, {
      headers: buildStasSourceHeaders(req, {
        'X-API-Key': getStasKey(),
        Accept: 'application/json',
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return res.json([]);

    const json = await response.json().catch(() => null);
    if (Array.isArray(json)) return res.json(json);
    if (json && Array.isArray(json.trainings)) return res.json(json.trainings);
    if (json && Array.isArray(json.activities)) return res.json(json.activities);
    return res.json([]);

  } catch (e) {
    return res.json([]);
  }
});

module.exports = router;
