const express = require('express');
const { icuCreateEvents, icuListEventsWithAuth, icuUpsertEvents } = require('./icu_write');
const { normalizeEventDateTimes } = require('./icu_event_normalize');
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
function normalizeEvents(events, prefix = 'plan:') {
  return events.map(ev => {
    const e = { ...ev };
    normalizeEventDateTimes(e);
    e.category = e.category || 'WORKOUT';
    if (!e.external_id) {
      const dt = String(e.start_date_local || '').split('T')[0] || 'date';
      e.external_id = `${prefix}${dt}-${slugify(e.name || e.type || 'workout')}`.slice(0, 80);
    }
    return e;
  });
}
function parseDryRun(req) {
  const hasQueryDryRun = Object.prototype.hasOwnProperty.call(req.query || {}, 'dry_run');
  const value = hasQueryDryRun ? req.query.dry_run : req.body && req.body.dry_run;
  const normalized = String(value === undefined ? 'true' : value).trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}
const getStasKey = require("./get_stas_key");

module.exports = function attachIcuPostExact(app) {
  app.post('/gw/icu/events/preview', express.json({ limit: '256kb' }), (req, res) => {
    const uid = getRequestUserId(req);
    if (!uid) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });

    if (!req.body || !Array.isArray(req.body.events) || req.body.events.length < 1) {
      return res.status(400).json({ error: 'bad_request', message: 'body.events[] is required' });
    }

    const prefix = (req.query.external_id_prefix || 'plan:') + '';
    const normalized = normalizeEvents(req.body.events, prefix);
    return res.json({
      ok: true,
      dry_run: true,
      count: normalized.length,
      created: 0,
      skipped: 0,
      errors: [],
      events: normalized,
    });
  });

  app.post('/gw/icu/events', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const uid    = getRequestUserId(req);
      if (!uid) throw Object.assign(new Error('missing_or_invalid_token'), { status: 401 });
      const prefix = (req.query.external_id_prefix || 'plan:') + '';
      const dryRun = parseDryRun(req);
      const dedupe = String(req.query.dedupe  || 'true').toLowerCase() !== 'false';

      if (!req.body || !Array.isArray(req.body.events) || req.body.events.length < 1) {
        return res.status(400).json({ error: 'bad_request', message: 'body.events[] is required' });
      }

      let normalized = normalizeEvents(req.body.events, prefix);

      if (dryRun) {
        return res.json({
          ok: true,
          dry_run: true,
          count: normalized.length,
          created: 0,
          skipped: 0,
          errors: [],
          events: normalized,
        });
      }

      // Upsert: external_id без префикса plan:/note: не принимаем (в STAS другие не используются).
      if (dedupe && normalized.some(e => !/^(plan|note):/.test(String(e.external_id)))) {
        return res.status(400).json({ error: 'bad_request', message: 'external_id must start with plan: or note:' });
      }

      const auth = await getIcuRequestAuth(req);

      // dedupe=false: прежнее поведение, каждое событие создаётся отдельным POST без поиска существующих.
      if (!dedupe) {
        const icuResp = await icuCreateEvents({ auth, events: normalized });
        return res.status(200).json({
          ok: true,
          dry_run: false,
          created: Array.isArray(icuResp) ? icuResp.length : normalized.length,
          updated: 0,
          skipped: 0,
          errors: [],
          icu: icuResp,
        });
      }

      // Upsert по external_id. Intervals сопоставляет external_id в рамках OAuth-приложения, поэтому
      // «обновлено» считаем по факту записи: до записи читаем события в окне (даты событий пакета плюс
      // oldest/newest, по умолчанию сегодня -7..+60) и запоминаем external_id -> id (только точные
      // совпадения), после bulk upsert сравниваем id из ответа с найденным.
      const dates = normalized.map(e => String(e.start_date_local || '').slice(0, 10)).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
      const defOldest = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);
      const defNewest = new Date(Date.now() + 60 * 86400 * 1000).toISOString().slice(0, 10);
      const oldest = [req.query.oldest || defOldest, ...dates].sort()[0];
      const newest = [req.query.newest || defNewest, ...dates].sort().slice(-1)[0];
      const existing = await icuListEventsWithAuth({ auth, q: { oldest, newest } });
      const batchIds = new Set(normalized.map(e => e.external_id));
      const existingById = new Map();
      for (const x of (Array.isArray(existing) ? existing : [])) {
        if (x && x.external_id && batchIds.has(x.external_id) && x.id !== undefined && x.id !== null) {
          existingById.set(x.external_id, x.id);
        }
      }

      const icuResp = await icuUpsertEvents({ auth, events: normalized });

      // Ответ bulk upsert: массив событий с id и external_id. Если ответ не массив или строку ответа
      // не удалось сопоставить по external_id (или в ней нет id), считаем событие по старой логике:
      // external_id нашёлся в предварительном чтении -> updated, иначе created.
      // Известное ограничение: событие вне окна чтения, которое upsert обновил, в карте отсутствует
      // и считается как created.
      const respByExternalId = new Map();
      if (Array.isArray(icuResp)) {
        for (const r of icuResp) {
          if (r && r.external_id && !respByExternalId.has(r.external_id)) respByExternalId.set(r.external_id, r);
        }
      }
      let created = 0;
      let updated = 0;
      let duplicated = 0;
      for (const e of normalized) {
        const hadId = existingById.has(e.external_id);
        const row = respByExternalId.get(e.external_id);
        if (!hadId) created += 1;
        else if (row && row.id !== undefined && row.id !== null) {
          if (String(row.id) === String(existingById.get(e.external_id))) updated += 1;
          else duplicated += 1;
        } else updated += 1;
      }
      return res.status(200).json({
        ok: true,
        dry_run: false,
        created,
        updated,
        duplicated,
        skipped: 0,
        errors: [],
        icu: icuResp,
      });
    } catch (e) {
      const code = e.status || 500;
      if ((code === 401 || code === 403) && e.authMode === 'intervals') {
        return res.status(401).json({
          ok: false,
          error: 'auth_required',
          message: 'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
        });
      }
      if (e.message && /unauthori[sz]ed|401/.test(e.message)) return res.status(401).json({ error: 'icu_unauthorized' });
      if (code === 404 && e.message === 'icu_credentials_not_found') return res.status(404).json({ error: 'icu_credentials_not_found' });
      return res.status(code).json({ error: e.message || 'internal_error', details: e.body || e.details || e.raw || undefined });
    }
  });
  console.log('[icu][POST] exact /gw/icu/events with ICU write + upsert by external_id enabled');
};
