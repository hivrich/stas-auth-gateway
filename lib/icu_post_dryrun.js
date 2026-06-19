const express = require('express');
const { getRequestUserId } = require('./request-auth');

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeEvents(events, prefix='plan:') {
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

module.exports = function attachIcuPostDryRun(app) {
  const router = express.Router();

  router.post('/events', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      if (!getRequestUserId(req)) throw Object.assign(new Error('missing_or_invalid_token'), { status: 401 });
      const prefix = (req.query.external_id_prefix || 'plan:') + '';
      const dryRun = String(req.query.dry_run || 'true').toLowerCase() === 'true';

      if (!req.body || !Array.isArray(req.body.events) || req.body.events.length < 1) {
        return res.status(400).json({ error: 'bad_request', message: 'body.events[] is required' });
      }

      const normalized = normalizeEvents(req.body.events, prefix);

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, count: normalized.length, events: normalized });
      }

      // NOTE: боевая запись будет добавлена отдельным шагом (ICU API call).
      return res.status(501).json({ error: 'not_implemented', message: 'ICU write is not enabled yet' });
    } catch (e) {
      const code = e.status || 500;
      return res.status(code).json({ error: e.message || 'internal_error' });
    }
  });

  app.use('/gw/icu', router);
};
