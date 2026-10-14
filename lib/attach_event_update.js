// Точечные правки в Intervals от имени атлета токена (один id за запрос):
//  PUT /gw/icu/events/:id           - обновить событие календаря по номеру
//  PUT /gw/icu/activities/:id/race  - отметить выполненную активность стартом / снять отметку
// dry_run по умолчанию true (как у DELETE): реальная запись только при dry_run=0|false.
// «Только своё»: событие читается из athlete/{токен}/events/{id} (чужое -> 404 от Intervals);
// активность читается из /activity/{id} и сверяется по icu_athlete_id с атлетом токена.
const express = require('express');
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');
const { getStasRequestId } = require('./request-id');
const { fetchIntervals, forwardRetryAfter } = require('./icu-attempt-ledger');

const EVENT_ID_RE = /^\d{1,15}$/;
const ACTIVITY_ID_RE = /^i?\d{1,15}$/;
const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const EVENT_FIELDS = [
  'start_date_local', 'name', 'description', 'type', 'moving_time',
  'icu_training_load', 'workout_doc', 'end_date_local', 'for_week',
];
const ICU_TIMEOUT_MS = 10000;

function apiBase() {
  return (process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1').replace(/\/+$/, '');
}

function upstreamErrorCategory(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return (name === 'AbortError' || name === 'TimeoutError' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)) ? 'upstream_timeout' : 'upstream_error';
}

function logFields(req, extra = {}) {
  return JSON.stringify({
    stas_request_id: getStasRequestId(req),
    method: req.method,
    path: req.path,
    ...extra,
  });
}

// Как у POST /gw/icu/events: по умолчанию dry_run, выключается только явным false/0/no/off.
function parseDryRun(req) {
  const hasQuery = Object.prototype.hasOwnProperty.call(req.query || {}, 'dry_run');
  const value = hasQuery ? req.query.dry_run : (req.body && !Array.isArray(req.body) ? req.body.dry_run : undefined);
  const normalized = String(value === undefined ? 'true' : value).trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(normalized);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAthleteId(value) {
  return String(value ?? '').trim().replace(/^i/i, '');
}

// Атлет токена: прямой OAuth Intervals (athleteId '0') - id из /athlete/0 (uid запроса);
// сохранённые ключи (legacy/MCP) - athleteId из учётных данных.
function expectedAthleteId(req, auth) {
  const own = auth.authMode === 'intervals' || auth.athleteId === '0' ? getRequestUserId(req) : auth.athleteId;
  const normalized = normalizeAthleteId(own);
  return normalized && normalized !== '0' ? normalized : null;
}

class IcuHttpError extends Error {
  constructor(status, retryAfter = null) {
    super(`icu_http_${status}`);
    this.icuStatus = status;
    // Retry-After Intervals как пришёл (секунды или HTTP-дата); пусто, если заголовка нет.
    this.retryAfter = retryAfter;
  }
}

async function icuFetch(auth, path, { method = 'GET', body, req } = {}) {
  const url = `${apiBase()}${path}`;
  const attempt = async (mode) => {
    const headers = { Accept: 'application/json' };
    headers.Authorization = mode === 'basic'
      ? `Basic ${Buffer.from(`API_KEY:${auth.token}`).toString('base64')}`
      : `Bearer ${auth.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetchIntervals(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ICU_TIMEOUT_MS),
    }, { req, auth, kind: mode });
  };

  let resp = await attempt('bearer');
  if ((resp.status === 401 || resp.status === 403) && auth.authMode === 'legacy') {
    resp = await attempt('basic');
  }
  if (!resp.ok) throw new IcuHttpError(resp.status, resp.headers?.get?.('retry-after') ?? null);

  const text = await resp.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

function sendIcuError(req, res, tag, error) {
  const status = error?.icuStatus;
  if (status === 404) return res.status(404).json({ ok: false, error: 'not_found' });
  if (status === 429) {
    // Лимит Intervals: честный 429 и Retry-After, чтобы вызывающий мог подождать.
    const retryAfterMs = forwardRetryAfter(res, error.retryAfter);
    return res.status(429).json({
      ok: false,
      error: 'rate_limited',
      ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}),
    });
  }
  if (status === 401 || status === 403) {
    return res.status(401).json({
      ok: false,
      error: 'auth_required',
      message: 'Требуется переподключение. Попросите пользователя заново войти через Intervals.icu',
    });
  }
  // Отказ Intervals по запросу (400/409/422 и прочие 4xx) отдаём как есть, не как сбой апстрима.
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: 'rejected', status });
  }
  try { console.error(`[icu][${tag}][ERR] ${logFields(req, {
    status: 502,
    category: status ? 'upstream_error' : upstreamErrorCategory(error),
    ...(status ? { icu_status: status } : {}),
  })}`); } catch {}
  return res.status(502).json({ ok: false, error: 'upstream_error', ...(status ? { status } : {}) });
}

function sendRequestAuthError(res, error) {
  if (error?.status === 401) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });
  if (error?.status === 404) return res.status(404).json({ ok: false, error: 'icu_creds_not_found' });
  return null;
}

function filterEventFields(body) {
  const out = {};
  const invalid = [];
  for (const key of EVENT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const v = body[key];
    let ok;
    switch (key) {
      case 'start_date_local':
      case 'end_date_local':
        ok = typeof v === 'string' && LOCAL_DATETIME_RE.test(v);
        break;
      case 'name':
      case 'description':
      case 'type':
        ok = typeof v === 'string';
        break;
      case 'moving_time':
      case 'icu_training_load':
        ok = typeof v === 'number' && Number.isFinite(v) && v >= 0;
        break;
      case 'workout_doc':
        ok = isPlainObject(v);
        break;
      case 'for_week':
        ok = typeof v === 'boolean';
        break;
      default:
        ok = false;
    }
    if (ok) out[key] = v; else invalid.push(key);
  }
  return { fields: out, invalid };
}

// Тело отметки старта мелкое: лимит 16kb, слишком большое -> 413 до обработчика.
const RACE_BODY_LIMIT = 16 * 1024;
function raceBodyParser(req, res, next) {
  // Любой тип тела с заявленным размером больше лимита - сразу 413, не доходя до обработчика.
  if (Number(req.headers['content-length']) > RACE_BODY_LIMIT) {
    return res.status(413).json({ ok: false, error: 'payload_too_large' });
  }
  express.json({ limit: '16kb' })(req, res, (error) => {
    if (error && (error.type === 'entity.too.large' || error.status === 413)) {
      return res.status(413).json({ ok: false, error: 'payload_too_large' });
    }
    return next(error);
  });
}

module.exports = function attachEventUpdate(app) {
  app.put('/gw/icu/events/:id', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const uid = getRequestUserId(req);
      if (!uid) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });

      const id = String(req.params.id || '');
      if (!EVENT_ID_RE.test(id)) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'event id must be digits only' });
      }
      if (!isPlainObject(req.body)) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'JSON object body is required' });
      }
      const { fields, invalid } = filterEventFields(req.body);
      if (invalid.length > 0) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'invalid field values', fields: invalid });
      }
      if (Object.keys(fields).length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'bad_request',
          message: `body must contain at least one of: ${EVENT_FIELDS.join(', ')}`,
        });
      }

      const dryRun = parseDryRun(req);
      const auth = await getIcuRequestAuth(req);
      const eventPath = `/athlete/${encodeURIComponent(auth.athleteId)}/events/${id}`;

      // Читаем событие от имени атлета токена: чужого/несуществующего для него нет -> 404.
      const existing = await icuFetch(auth, eventPath, { req });
      // Событие должно принадлежать атлету токена (как у отметки старта); иначе 404 и без записи.
      const expected = expectedAthleteId(req, auth);
      if (!expected || !isPlainObject(existing) || normalizeAthleteId(existing.athlete_id) !== expected) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, would_update: fields });
      }

      const written = await icuFetch(auth, eventPath, { method: 'PUT', body: fields, req });
      const src = isPlainObject(written) && written.id !== undefined ? written : existing;
      try { console.log(`[icu][PUT][event] ${logFields(req, { status: 200, auth_mode: auth.authMode })}`); } catch {}
      return res.json({
        ok: true,
        dry_run: false,
        updated: 1,
        event: {
          id: String(src.id ?? id),
          external_id: src.external_id ?? null,
          start_date_local: src.start_date_local ?? fields.start_date_local ?? null,
          category: src.category ?? null,
        },
      });
    } catch (e) {
      return sendRequestAuthError(res, e) || sendIcuError(req, res, 'PUT][event', e);
    }
  });

  app.put('/gw/icu/activities/:id/race', raceBodyParser, async (req, res) => {
    try {
      const uid = getRequestUserId(req);
      if (!uid) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });

      const id = String(req.params.id || '');
      if (!ACTIVITY_ID_RE.test(id)) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'invalid activity id' });
      }
      const body = req.body;
      const extraKeys = isPlainObject(body) ? Object.keys(body).filter(k => k !== 'race' && k !== 'dry_run') : [];
      if (!isPlainObject(body) || typeof body.race !== 'boolean' || extraKeys.length > 0) {
        return res.status(400).json({ ok: false, error: 'bad_request', message: 'body must be {"race": true|false}' });
      }

      const dryRun = parseDryRun(req);
      const auth = await getIcuRequestAuth(req);
      const expected = expectedAthleteId(req, auth);
      const activityPath = `/activity/${encodeURIComponent(id)}`;

      const activity = await icuFetch(auth, activityPath, { req });
      // /activity/{id} открывает и чужие активности (тренер, общий доступ): сверяем владельца.
      if (!expected || !activity || normalizeAthleteId(activity.icu_athlete_id) !== expected) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const subType = body.race ? 'RACE' : 'NONE';
      if (dryRun) {
        return res.json({ ok: true, dry_run: true, would_update: { id, sub_type: subType } });
      }

      const written = await icuFetch(auth, activityPath, { method: 'PUT', body: { sub_type: subType }, req });
      try { console.log(`[icu][PUT][race] ${logFields(req, { status: 200, auth_mode: auth.authMode })}`); } catch {}
      return res.json({
        ok: true,
        dry_run: false,
        activity: {
          id: String(written?.id ?? activity.id ?? id),
          sub_type: written?.sub_type ?? subType,
        },
      });
    } catch (e) {
      return sendRequestAuthError(res, e) || sendIcuError(req, res, 'PUT][race', e);
    }
  });
};
