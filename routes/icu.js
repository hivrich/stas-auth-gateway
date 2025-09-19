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
    const creds = await getIcuCredsByUserId(req.user_id);
    if (!creds || !creds.icu_api_key || !creds.icu_athlete_id) {
      return res.status(403).json({
        error: 'forbidden',
        detail: 'No ICU credentials bound to this user_id'
      });
    }

    const { icu_api_key, icu_athlete_id } = creds;

    // Build target
    const incoming = new URL(req.originalUrl, `http://${req.headers.host}` );
    const target   = new URL(`${ICU_BASE}/athlete/${encodeURIComponent(icu_athlete_id)}/${path}` );
    incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

    const headers = {
      'Authorization': buildBasicAuthHeader(icu_api_key, icu_api_key),
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    const method = methodOverride || req.method;
    const opts = { method, headers };
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      opts.body = JSON.stringify(req.body || {});
    }

    const r = await fetch(target.toString(), opts);
    const text = await r.text();
    res.status(r.status)
      .type(r.headers.get('content-type') || 'application/json')
      .send(text);
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
