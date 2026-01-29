const express = require('express');
const { getIcuCredsForUid, icuCreateEvents } = require('./icu_write');
const { getIcuCredsForUid: getCreds2, icuListEvents } = require('./icu_delete');

function parseBearerUid(req) {
  const h = req.get('authorization') || '';
  const m = h.match(/^\s*Bearer\s+t_([A-Za-z0-9\-_]+)\s*$/i);
  if (!m) throw Object.assign(new Error('missing_or_invalid_token'), { status: 401 });
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  let obj;
  try { obj = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8')); }
  catch { throw Object.assign(new Error('invalid_token_payload'), { status: 401 }); }
  const uid = obj && String(obj.uid || '').trim();
  if (!uid || !/^\d+$/.test(uid)) throw Object.assign(new Error('missing_user_id'), { status: 401 });
  return uid;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
function normalizeEvents(events, prefix = 'plan:') {
  return events.map(ev => {
    const e = { ...ev };
    e.category = e.category || 'WORKOUT';
    if (!e.external_id) {
      const dt = String(e.start_date_local || '').split('T')[0] || 'date';
      e.external_id = `${prefix}${dt}-${slugify(e.name || e.type || 'workout')}`.slice(0, 80);
    }
    return e;
  });
}

module.exports = function attachIcuPostExact(app) {
  app.post('/gw/icu/events', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const uid    = parseBearerUid(req);
      const prefix = (req.query.external_id_prefix || 'plan:') + '';
      const dryRun = String(req.query.dry_run || 'true').toLowerCase() === 'true';
      const dedupe = String(req.query.dedupe  || 'true').toLowerCase() !== 'false';

      if (!req.body || !Array.isArray(req.body.events) || req.body.events.length < 1) {
        return res.status(400).json({ error: 'bad_request', message: 'body.events[] is required' });
      }

      let normalized = normalizeEvents(req.body.events, prefix);

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, count: normalized.length, events: normalized });
      }

      // Дедупликация по external_id с окном (дефолты -7..+60 UTC)
      if (dedupe) {
        const oldest = (req.query.oldest || new Date(Date.now()-7*86400*1000).toISOString().slice(0,10));
        const newest = (req.query.newest || new Date(Date.now()+60*86400*1000).toISOString().slice(0,10));
        const { apiKey, athlete_id } = await getCreds2(uid);
        const existing = await icuListEvents({ apiKey, athlete_id, q: { external_id_prefix: prefix, oldest, newest } });
        const existingIds = new Set((existing || []).filter(x => x.external_id).map(x => x.external_id));
        const before = normalized.length;
        normalized = normalized.filter(e => !existingIds.has(e.external_id));
        if (normalized.length === 0) {
          return res.json({ ok: true, created: 0, skipped: before, reason: 'dedupe' });
        }
      }

      const { apiKey, athlete_id } = await getIcuCredsForUid(uid);
      const icuResp = await icuCreateEvents({ apiKey, athlete_id, events: normalized });
      return res.status(200).json({ ok: true, created: Array.isArray(icuResp) ? icuResp.length : undefined, icu: icuResp });
    } catch (e) {
      const code = e.status || 500;
      if (e.message && /unauthori[sz]ed|401/.test(e.message)) return res.status(401).json({ error: 'icu_unauthorized' });
      if (code === 404 && e.message === 'icu_credentials_not_found') return res.status(404).json({ error: 'icu_credentials_not_found' });
      return res.status(code).json({ error: e.message || 'internal_error', details: e.body || e.details || e.raw || undefined });
    }
  });
  console.log('[icu][POST] exact /gw/icu/events with ICU write + dedupe enabled');
};
