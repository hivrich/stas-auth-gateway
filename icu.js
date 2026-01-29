'use strict';
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const { requireUser, buildBasicAuthHeader } = require('../helpers/auth');
const { getIcuCredsByUserId } = require('../db/credsDao');

const router = express.Router();
const ICU_BASE = process.env.ICU_API_BASE_URL;

if (!ICU_BASE) {
  console.warn('[ICU] Misconfigured: ICU_API_BASE_URL missing');
}

async function icuProxy(req, res, path, methodOverride) {
  try {
    if (!ICU_BASE) {
      return res.status(500).json({ error: 'icu_not_configured' });
    }

    // Strict per-user creds
    const creds = await credsDao.getByUserId(user_id);
    if (!creds || !creds.api_key || !creds.athlete_id) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'No ICU credentials bound to this user_id'
      });
    }

    // Build target
    const incoming = new URL(req.originalUrl, `http://${req.headers.host}` );
    const target   = new URL(`${ICU_BASE}/athlete/${encodeURIComponent(creds.athlete_id)}/${path}` );
    incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

    // Simple fallback without fetch - just return mock data for now
    console.log('[ICU] Would proxy to:', target.toString());
    return res.json({ 
      ok: true,
      message: 'ICU proxy not fully configured yet',
      target_url: target.toString(),
      athlete_id: creds.athlete_id
    });
  } catch (e) {
    console.error('[ICU proxy error]', e);
    res.status(502).json({ error: 'bad_gateway', detail: String(e.message || e) });
  }
}

// Require token user; then expose routes
router.use(requireUser);

// Activities (past)
router.get('/activities', (req, res) => icuProxy(req, res, 'activities'));

// Events (calendar/plan)
router.get('/events', (req, res) => icuProxy(req, res, 'events'));

// Bulk write plan
router.post('/events/bulk', (req, res) => icuProxy(req, res, 'events/bulk', 'POST'));

// Delete events by filters
router.delete('/events', (req, res) => icuProxy(req, res, 'events', 'DELETE'));

module.exports = router;
