const express = require('express');
const router  = express.Router();

const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

async function readDbBridgeApiKey() {
  const fs = require('fs');
  if (process.env.DB_BRIDGE_API_KEY) return process.env.DB_BRIDGE_API_KEY;
  try {
    const raw = fs.readFileSync('/opt/stas-db-bridge/.env', 'utf8');
    const line = (raw.split(/\r?\n/).find(x => /^API_KEY=/.test(x)) || '').split('=', 2)[1] || '';
    return String(line).trim();
  } catch {
    return '';
  }
}

function uidFromReq(req) {
  return req.user_id || (req.bearer && req.bearer.uid) || req.query.user_id || null;
}

function isFull(req) {
  const v = String(req.query.full ?? '').toLowerCase();
  return v === '1' || v === 'true';
}

function applyWindow(qs, req) {
  if (req.query.oldest != null && String(req.query.oldest) !== '') qs.set('oldest', String(req.query.oldest));
  if (req.query.newest != null && String(req.query.newest) !== '') qs.set('newest', String(req.query.newest));

  if (!qs.has('oldest') && !qs.has('newest')) {
    const d = parseInt(String(req.query.days ?? ''), 10);
    if (Number.isFinite(d) && d > 0) {
      const now = new Date();
      const newest = now.toISOString().slice(0, 10);
      const oldestDate = new Date(now.getTime() - (d - 1) * 86400000);
      const oldest = oldestDate.toISOString().slice(0, 10);
      qs.set('oldest', oldest);
      qs.set('newest', newest);
    }
  }
}

/**
 * GET /gw/trainings (mounted on /gw)
 * - default      -> DB-Bridge /api/db/trainings       (summary)
 * - full=1|true  -> DB-Bridge /api/db/activities_full (detail)
 *
 * Returns ARRAY (per OpenAPI /trainings).
 */
router.get('/trainings', async (req, res) => {
  try {
    const { URLSearchParams } = require('node:url');

    const uid = uidFromReq(req);
    if (!uid) return res.json([]);

    const qs = new URLSearchParams();
    qs.set('user_id', String(uid));

    applyWindow(qs, req);

    for (const k of ['limit', 'offset']) {
      const val = req.query[k];
      if (val != null && String(val) !== '') qs.set(k, String(val));
    }

    const apiKey = await readDbBridgeApiKey();
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;

    const full = isFull(req);
    const path = full ? '/api/db/activities_full' : '/api/db/trainings';
    const url  = STAS_BASE + path + '?' + qs.toString();

    const r = await fetch(url, { headers });
    if (!r.ok) return res.json([]);

    const j = await r.json();

    if (full) {
      const arr = Array.isArray(j.activities) ? j.activities
                : Array.isArray(j.trainings)  ? j.trainings
                : Array.isArray(j)            ? j
                : [];
      return res.json(arr);
    } else {
      const arr = Array.isArray(j.trainings) ? j.trainings
                : Array.isArray(j)           ? j
                : [];
      return res.json(arr);
    }
  } catch (_e) {
    return res.json([]);
  }
});

module.exports = router;
