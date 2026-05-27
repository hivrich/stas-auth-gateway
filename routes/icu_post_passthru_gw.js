const express = require('express');
const { getIcuRequestAuth } = require('../lib/icu-request-auth');

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKLY_REVIEW_RE = /^note:(\d{4}-\d{2}-\d{2})(:weekly-review-w(\d{1,2})(?::.*)?)$/i;

function badWeeklyNote(message, details) {
  const err = new Error(message);
  err.status = 400;
  err.error = 'bad_weekly_review_note';
  err.details = details;
  return err;
}

function parseYmd(value) {
  const m = String(value || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function formatYmd(dt) {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt, days) {
  return new Date(dt.getTime() + days * MS_PER_DAY);
}

function getIsoWeekInfo(dt) {
  const d = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((d - yearStart) / MS_PER_DAY) + 1) / 7);
  return { isoYear, week };
}

function sundayForIsoWeek(isoYear, week) {
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = addDays(jan4, 1 - jan4Day);
  return addDays(week1Monday, (week - 1) * 7 + 6);
}

function setAllDayAnchor(ev, sunday) {
  const date = formatYmd(sunday);
  const next = formatYmd(addDays(sunday, 1));
  ev.start_date_local = `${date}T00:00:00`;
  ev.end_date_local = `${next}T00:00:00`;
  if (Object.prototype.hasOwnProperty.call(ev, 'start_date')) ev.start_date = ev.start_date_local;
  if (Object.prototype.hasOwnProperty.call(ev, 'end_date')) ev.end_date = ev.end_date_local;
}

function normalizeWeeklyReviewNote(ev) {
  const externalId = String(ev.external_id || ev.externalId || '');
  const m = externalId.match(WEEKLY_REVIEW_RE);
  if (!m) return false;

  const externalDate = parseYmd(m[1]);
  const week = Number(m[3]);
  if (!externalDate || week < 1 || week > 53) {
    throw badWeeklyNote('weekly review NOTE has invalid external_id date or ISO week', { external_id: externalId });
  }

  const info = getIsoWeekInfo(externalDate);
  if (info.week !== week) {
    throw badWeeklyNote('weekly review NOTE external_id date does not belong to requested ISO week', {
      external_id: externalId,
      external_id_date_iso_week: info.week,
      requested_iso_week: week,
    });
  }

  const sunday = sundayForIsoWeek(info.isoYear, week);
  const canonicalDate = formatYmd(sunday);
  ev.category = 'NOTE';
  ev.for_week = true;
  ev.external_id = `note:${canonicalDate}${m[2]}`;
  delete ev.externalId;
  setAllDayAnchor(ev, sunday);
  return true;
}

function normalizeForWeekEvent(ev) {
  if (ev.for_week !== true) return;

  const dateText = ev.start_date_local || ev.start_date || String(ev.external_id || '').split(':')[1];
  const anchor = parseYmd(dateText);
  if (!anchor) {
    throw badWeeklyNote('for_week event requires a valid anchor date', { external_id: ev.external_id || ev.externalId });
  }

  const info = getIsoWeekInfo(anchor);
  setAllDayAnchor(ev, sundayForIsoWeek(info.isoYear, info.week));
}

module.exports = function(app){
  const router = express.Router();

  router.post('/events', express.json({limit:'1mb'}), async (req, res) => {
    try{
      const q = req.query || {};
      const body = req.body || {};

      const ua = (req.get && req.get('user-agent')) || req.headers['user-agent'] || '';
      const isGPT = /ChatGPT-User/i.test(ua);
      const dryParam = String(q.dry_run || '').toLowerCase();

      // Новая политика:
      //  - для GPT: REAL по умолчанию; DRY только если явно dry_run=true
      //  - для остальных: DRY по умолчанию; REAL только если явно dry_run=false
      const isDryRun = isGPT ? (dryParam === 'true')
                             : (dryParam ? (dryParam !== 'false') : true);

      // Поддерживаем {events:[…]} и bare-array
      const eventsIn = Array.isArray(body.events) ? body.events : (Array.isArray(body) ? body : []);
      const events = Array.isArray(eventsIn) ? eventsIn : [];

      if (isDryRun){
        return res.json({ ok:true, dry_run:true, count: events.length, mode_hint: isGPT?'gpt':'default' });
      }

      const auth = await getIcuRequestAuth(req);
      const API_BASE = process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1';

      // Нормализация: гарантируем category и единое поле external_id.
      // Intervals.icu должен обновлять событие с тем же external_id, а не создавать дубль.
      const payloadArr = events.map(ev => {
        const normalized = { category:'WORKOUT', ...ev };
        if (normalized.externalId) {
          normalized.external_id = normalized.external_id || normalized.externalId;
          delete normalized.externalId;
        }
        const isWeeklyReview = normalizeWeeklyReviewNote(normalized);
        if (!isWeeklyReview && normalized.for_week === true && normalized.category !== 'NOTE') {
          throw badWeeklyNote('for_week is only supported for NOTE events', { external_id: normalized.external_id });
        }
        if (!isWeeklyReview) normalizeForWeekEvent(normalized);
        return normalized;
      });
      const url = `${API_BASE}/athlete/${encodeURIComponent(auth.athleteId)}/events/bulk?upsert=true`;
      const bodyJson = JSON.stringify(payloadArr);

      const hdrs = (mode)=> {
        const h = { 'Accept':'application/json', 'Content-Type':'application/json' };
        if (mode==='bearer') h['Authorization'] = `Bearer ${auth.token}`;
        else h['Authorization'] = `Basic ${Buffer.from(`API_KEY:${auth.token}`).toString('base64')}`;
        return h;
      };

      let r = await fetch(url, { method:'POST', headers: hdrs('bearer'), body: bodyJson });
      if ((r.status===401 || r.status===403) && auth.authMode === 'legacy') {
        r = await fetch(url, { method:'POST', headers: hdrs('basic'), body: bodyJson });
      }
      if ((r.status===401 || r.status===403) && auth.authMode === 'intervals') {
        return res.status(401).json({
          ok:false,
          error:'auth_required',
          message:'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
        });
      }

      const text = await r.text(); let json; try{ json = JSON.parse(text);}catch(_){}
      if (!r.ok){
        return res.status(502).json({ ok:false, error:'icu_upstream_error', status:r.status, detail:text.slice(0,500) });
      }

      const result = (json && typeof json==='object') ? json : { ok:true };
      if (!('ok' in result)) result.ok = true;
      if (!('dry_run' in result)) result.dry_run = false;
      result.mode_hint = isGPT ? 'gpt' : 'default';
      return res.json(result);

    }catch(e){
      if (e?.status === 401) {
        return res.status(401).json({ ok:false, error:'missing_or_invalid_token' });
      }
      if (e?.status === 404) {
        return res.status(404).json({ ok:false, error:'icu_creds_not_found' });
      }
      if (e?.status === 400) {
        return res.status(400).json({ ok:false, error:e.error || 'bad_request', message:e.message, details:e.details });
      }
      console.error('[icu][POST][passthru] error:', e && e.stack || e);
      return res.status(500).json({ ok:false, error:'post_passthru_failed' });
    }
  });

  app.use('/gw/icu', router);
  console.log('[icu][POST][passthru] /gw/icu/events attached (BEFORE real_gw, BULK, GPT=REAL-by-default)');
};
