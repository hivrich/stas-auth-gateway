'use strict';
const express = require('express');
const fetch = require('node-fetch');
const { URL } = require('url');
const { requireUser } = require('../helpers/auth');

const router = express.Router();
const STAS_BASE = process.env.STAS_INTERNAL_BASE_URL;
const STAS_KEY  = process.env.STAS_API_KEY;

if (!STAS_BASE || !STAS_KEY) {
  console.warn('[STAS] Misconfigured: STAS_INTERNAL_BASE_URL or STAS_API_KEY missing');
}

async function stasProxy(req, res, targetPath) {
  try {
    if (!STAS_BASE || !STAS_KEY) {
      return res.status(500).json({ error: 'stas_not_configured' });
    }

    // Build target with query
    const incoming = new URL(req.originalUrl, `http://${req.headers.host}` );
    const target   = new URL(`/api/${targetPath}` , STAS_BASE);
    incoming.searchParams.forEach((v, k) => target.searchParams.set(k, v));

    // Enforce user_id from token only
    target.searchParams.set('user_id', req.user_id);

    // Simple fallback without fetch - just return mock data for now
    console.log('[STAS] Would proxy to:', target.toString());
    return res.json({ 
      ok: true,
      message: 'STAS proxy not fully configured yet',
      target_url: target.toString()
    });
  } catch (e) {
    console.error('[STAS proxy error]', e);
    res.status(502).json({ error: 'bad_gateway', detail: String(e.message || e) });
  }
}

// Require token user; then expose routes
router.use(requireUser);

router.get('/db/user_summary',   (req, res) => stasProxy(req, res, 'db/user_summary'));
router.get('/db/activities',     (req, res) => stasProxy(req, res, 'db/activities'));
router.get('/db/activities_full',(req, res) => stasProxy(req, res, 'db/activities_full'));
router.get('/db/monthly_summary',(req, res) => stasProxy(req, res, 'db/monthly_summary'));

// ---- Compatibility alias (DEPRECATED) ----
// /gw/api/db/trainings  →  /gw/api/db/activities
// Добавляем временно, чтобы не падали старые клиенты.
router.get('/db/trainings', async (req, res) => {
  // Проксируем как activities, но помечаем деприкацию
  res.setHeader('Deprecation', 'true'); // RFC 8594
  res.setHeader('Link', '</gw/api/db/activities>; rel="successor-version"');
  res.setHeader('Sunset', 'Tue, 31 Dec 2025 23:59:59 GMT'); // срок снятия алиаса
  return stasProxy(req, res, 'db/activities');
});

module.exports = router;
