// Ручная запись выполненной тренировки в Intervals от имени атлета токена:
//  POST /gw/icu/activities/manual - только серверный вызов сайта STAS (source site + ключ STAS).
// Нужна кнопке «Уже выполнено» и отметке запланированного события как выполненного.
// Бюджет запросов: [GET событие] + GET список за день + POST manual (+ один PUT для привязки).
// Создание никогда не повторяется шлюзом; повтор с тем же external_id безопасен (ищем по списку дня).
// В GPT Actions (openapi.actions.json) маршрут не публикуется.
const express = require('express');
const { getIcuRequestAuth } = require('./icu-request-auth');
const { getRequestUserId } = require('./request-auth');
const { getStasRequestId } = require('./request-id');
const { fetchIntervals, forwardRetryAfter } = require('./icu-attempt-ledger');
const { getRequestSource, isStasServerRequest } = require('./request-source');

const EXTERNAL_ID_RE = /^stas-done:[A-Za-z0-9_.:-]{1,80}$/;
const SPORT_TYPE_RE = /^[A-Za-z0-9]{1,40}$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const PLAN_ID_RE = /^\d{1,15}$/;
const BODY_LIMIT_BYTES = 16 * 1024;
const ICU_TIMEOUT_MS = 10000;
const SIMILAR_START_MS = 5 * 60 * 1000;
const SIMILAR_DURATION_RATIO = 0.1;
const PICKED_FIELDS = [
  'id', 'external_id', 'type', 'source', 'name', 'start_date_local', 'moving_time', 'elapsed_time',
  'distance', 'icu_rpe', 'feel', 'session_rpe', 'icu_training_load', 'icu_intensity',
  'paired_event_id', 'icu_athlete_id', 'description',
];

// Выполняющиеся запросы: ключ атлет|external_id -> промис всего алгоритма.
const inflight = new Map();
// Очередь по атлету: последний хвост цепочки.
const athleteQueue = new Map();

function apiBase() {
  return (process.env.INTERVALS_API_BASE_URL || 'https://intervals.icu/api/v1').replace(/\/+$/, '');
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
    headers.Authorization = `Bearer ${auth.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetchIntervals(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(ICU_TIMEOUT_MS),
    }, { req, auth, kind: mode });
  };

  // Только Bearer одного OAuth-токена: схему не меняем и запрос не повторяем (создание не должно уходить дважды).
  const resp = await attempt('bearer');
  if (!resp.ok) throw new IcuHttpError(resp.status, resp.headers?.get?.('retry-after') ?? null);

  const text = await resp.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
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

function sendIcuError(req, res, error) {
  const status = error?.icuStatus;
  if (status === 404) return res.status(404).json({ ok: false, error: 'not_found' });
  if (status === 429) {
    // Лимит Intervals: честный 429 и Retry-After, создание не повторяем.
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
  if (status >= 400 && status < 500) {
    return res.status(status).json({ ok: false, error: 'rejected', status });
  }
  try { console.error(`[icu][POST][activity_manual][ERR] ${logFields(req, {
    status: 502,
    category: status ? 'upstream_error' : upstreamErrorCategory(error),
    ...(status ? { icu_status: status } : {}),
  })}`); } catch {}
  return res.status(502).json({ ok: false, error: 'upstream_error' });
}

function sendRequestAuthError(res, error) {
  if (error?.status === 401) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });
  if (error?.status === 404) return res.status(404).json({ ok: false, error: 'icu_creds_not_found' });
  return null;
}

// Только доверенный серверный вызов сайта: источник site и ключ STAS. До любого запроса в Intervals.
function siteOnlyGate(req, res, next) {
  if (isStasServerRequest(req) && getRequestSource(req) === 'site') return next();
  return res.status(403).json({ ok: false, error: 'site_only' });
}

function uidGate(req, res, next) {
  if (!getRequestUserId(req)) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });
  return next();
}

// Тело мелкое: лимит 16kb; слишком большое -> 413, битый JSON -> 400 invalid_body.
function bodyParser(req, res, next) {
  if (Number(req.headers['content-length']) > BODY_LIMIT_BYTES) {
    return res.status(413).json({ ok: false, error: 'payload_too_large' });
  }
  express.json({ limit: '16kb' })(req, res, (error) => {
    if (error && (error.type === 'entity.too.large' || error.status === 413)) {
      return res.status(413).json({ ok: false, error: 'payload_too_large' });
    }
    if (error) return res.status(400).json({ ok: false, error: 'invalid_body', field: 'body' });
    return next();
  });
}

// Реальная календарная дата и время начала (локальные, без часового пояса) -> миллисекунды (как UTC) или null.
function parseLocalDateTime(value) {
  const m = LOCAL_DATETIME_RE.exec(String(value ?? '').slice(0, 19));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d ||
      check.getUTCHours() !== h || check.getUTCMinutes() !== mi || check.getUTCSeconds() !== s) {
    return null;
  }
  return ms;
}

// Строгая проверка тела: возвращает { value } или { field }.
function validateBody(body) {
  if (!isPlainObject(body)) return { field: 'body' };
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
  const out = {};

  if (typeof body.external_id !== 'string' || !EXTERNAL_ID_RE.test(body.external_id)) return { field: 'external_id' };
  out.external_id = body.external_id;
  if (typeof body.type !== 'string' || !SPORT_TYPE_RE.test(body.type)) return { field: 'type' };
  out.type = body.type;
  if (typeof body.start_date_local !== 'string' || parseLocalDateTime(body.start_date_local) === null) {
    return { field: 'start_date_local' };
  }
  out.start_date_local = body.start_date_local;
  if (!Number.isInteger(body.moving_time) || body.moving_time < 60 || body.moving_time > 172800) {
    return { field: 'moving_time' };
  }
  out.moving_time = body.moving_time;

  if (has('name')) {
    if (typeof body.name !== 'string' || body.name.length > 120) return { field: 'name' };
    out.name = body.name;
  }
  if (has('distance')) {
    if (typeof body.distance !== 'number' || !Number.isFinite(body.distance) || body.distance < 0 || body.distance > 1000000) {
      return { field: 'distance' };
    }
    out.distance = body.distance;
  }
  if (has('icu_rpe')) {
    if (!Number.isInteger(body.icu_rpe) || body.icu_rpe < 1 || body.icu_rpe > 10) return { field: 'icu_rpe' };
    out.icu_rpe = body.icu_rpe;
  }
  if (has('description')) {
    if (typeof body.description !== 'string' || body.description.length > 2000) return { field: 'description' };
    out.description = body.description;
  }
  if (has('plan_event_id')) {
    if (typeof body.plan_event_id !== 'string' || !PLAN_ID_RE.test(body.plan_event_id)) return { field: 'plan_event_id' };
    // Каноническая форма номера (без ведущих нулей): ключ и сравнения с paired_event_id не зависят от написания.
    out.plan_event_id = String(Number(body.plan_event_id));
  }
  return { value: out };
}

function pick(activity) {
  const src = isPlainObject(activity) ? activity : {};
  const out = {};
  for (const key of PICKED_FIELDS) out[key] = src[key] === undefined ? null : src[key];
  return out;
}

// Похожая активность: тот же вид спорта, старт в пределах 5 минут, длительность в пределах 10 %.
function isSimilar(candidate, want) {
  if (!isPlainObject(candidate)) return false;
  if (String(candidate.type || '').toLowerCase() !== want.type.toLowerCase()) return false;
  const start = parseLocalDateTime(candidate.start_date_local);
  if (start === null || Math.abs(start - want.startMs) > SIMILAR_START_MS) return false;
  const moving = Number(candidate.moving_time);
  if (!Number.isFinite(moving)) return false;
  return Math.abs(moving - want.moving_time) <= want.moving_time * SIMILAR_DURATION_RATIO;
}

const isPairedTo = (activity, planId) =>
  activity?.paired_event_id !== undefined && activity?.paired_event_id !== null &&
  String(activity.paired_event_id) === planId;

// Шаг 5: если привязки к плану нет - один PUT. Сбой PUT (429 с Retry-After, 5xx, сеть) не глотаем: он уходит наверх
// честным статусом; активность уже создана, повтор с тем же ключом найдёт её и допишет привязку без второго POST.
async function ensurePaired(req, auth, activity, planId) {
  if (isPairedTo(activity, planId)) return { activity, paired: true };
  const written = await icuFetch(auth, `/activity/${encodeURIComponent(String(activity.id))}`, {
    method: 'PUT',
    body: { paired_event_id: Number(planId) },
    req,
  });
  if (isPlainObject(written) && isPairedTo(written, planId)) {
    return { activity: { ...activity, ...written }, paired: true };
  }
  // PUT ответил 2xx, но привязки нет (или ответ нечитаем): шаг не завершён. Честный 502: повтор с тем же ключом найдёт
  // созданную активность и допишет связь, а ok:true со словом paired:false сайт не должен принимать за успех.
  throw new IcuHttpError(502);
}

// Весь алгоритм. Возвращает { status, body }; ошибки Intervals пробрасываются (их разбирает обработчик).
// Дата YYYY-MM-DD со сдвигом в днях (по UTC-календарю, без часовых поясов).
function shiftDay(day, delta) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function runCreate(req, auth, expected, input) {
  const planId = input.plan_event_id || null;
  let planDay = null;

  // Шаг 2: запланированное событие. Чужое и несуществующее для атлета одинаково -> 404.
  if (planId) {
    let event;
    try {
      event = await icuFetch(auth, `/athlete/0/events/${planId}`, { req });
    } catch (error) {
      if (error?.icuStatus === 404) return { status: 404, body: { ok: false, error: 'plan_not_found' } };
      throw error;
    }
    if (!isPlainObject(event)) return { status: 404, body: { ok: false, error: 'plan_not_found' } };
    // Владелец плана обязателен: событие без athlete_id или чужое - 404 (ничего не создаём).
    if (event.athlete_id === undefined || event.athlete_id === null || normalizeAthleteId(event.athlete_id) !== expected) {
      return { status: 404, body: { ok: false, error: 'plan_not_found' } };
    }
    if (typeof event.start_date_local === 'string' && /^\d{4}-\d{2}-\d{2}/.test(event.start_date_local)) {
      planDay = event.start_date_local.slice(0, 10);
    }
    // Без даты у плана окно поиска не определить: ничего не создаём.
    if (!planDay) return { status: 404, body: { ok: false, error: 'plan_not_found' } };
    // Дата записи вне окна плана (день плана -1 ... +14): отказ раньше любого поиска, в том числе для выполненного плана.
    const recordDay = input.start_date_local.slice(0, 10);
    const allowedFrom = shiftDay(planDay, -1);
    const allowedTo = shiftDay(planDay, 14);
    if (recordDay < allowedFrom || recordDay > allowedTo) {
      return { status: 400, body: { ok: false, error: 'date_out_of_window', from: allowedFrom, to: allowedTo } };
    }
    // У события Intervals поля paired_activity_id в ответе обычно нет (проверено на живом аккаунте):
    // выполненность плана определяем по активности с paired_event_id ниже; это поле - только запасной путь.
    if (event.paired_activity_id) {
      const paired = await icuFetch(auth, `/activity/${encodeURIComponent(String(event.paired_activity_id))}`, { req });
      return {
        status: 200,
        body: {
          ok: true, created: false, existing: true, reason: 'plan_already_done', paired: true, activity: pick(paired),
        },
      };
    }
  }

  // Шаг 3: один запрос списка за день; ищем свой external_id, затем похожую активность.
  const day = input.start_date_local.slice(0, 10);
  // Без плана: три дня вокруг даты записи (похожая активность через полночь, 23:59 и 00:01, находится).
  // С планом: окно фиксировано вокруг даты планового события и не зависит от даты запроса: день плана -2 ... +15;
  // дата записи допускается от дня плана -1 до +14, иначе отказ до любого поиска и создания (повтор не уйдёт в обход окна).
  let rangeFrom = shiftDay(day, -1);
  let rangeTo = shiftDay(day, 1);
  if (planId && planDay) {
    rangeFrom = shiftDay(planDay, -2);
    rangeTo = shiftDay(planDay, 15);
  }
  const list = await icuFetch(
    auth,
    `/athlete/0/activities?oldest=${encodeURIComponent(rangeFrom)}&newest=${encodeURIComponent(rangeTo)}`,
    { req },
  );
  // Ответ не массивом (или нечитаемый) - дубли не проверить: ничего не создаём.
  if (!Array.isArray(list)) throw new IcuHttpError(502);
  const items = list.filter(isPlainObject);
  const want = {
    type: input.type,
    startMs: parseLocalDateTime(input.start_date_local),
    moving_time: input.moving_time,
  };
  let found = null;
  let reason = 'external_id';
  if (planId) {
    // План уже выполнен, если за его день или за день записи есть активность, привязанная к этому событию.
    found = items.find((a) => String(a.paired_event_id) === planId) || null;
    if (found) {
      return {
        status: 200,
        body: { ok: true, created: false, existing: true, reason: 'plan_already_done', paired: true, activity: pick(found) },
      };
    }
  }
  found = items.find((a) => a.external_id === input.external_id) || null;
  if (!found) {
    found = items.find((a) => isSimilar(a, want)) || null;
    reason = 'similar';
  }
  if (found) {
    let activity = found;
    let paired = null;
    if (planId) {
      // Найденная активность уже привязана к ДРУГОМУ плану: не перепривязываем (первый план потерял бы «выполнено»).
      if (found.paired_event_id !== undefined && found.paired_event_id !== null && String(found.paired_event_id) !== planId) {
        return { status: 409, body: { ok: false, error: 'activity_paired_to_other_plan' } };
      }
      const result = await ensurePaired(req, auth, found, planId);
      activity = result.activity;
      paired = result.paired;
    }
    return { status: 200, body: { ok: true, created: false, existing: true, reason, paired, activity: pick(activity) } };
  }

  // Шаг 4: создание (один POST, без повторов).
  const payload = {
    type: input.type,
    start_date_local: input.start_date_local,
    name: input.name || input.type,
    moving_time: input.moving_time,
    external_id: input.external_id,
    ...(input.distance !== undefined ? { distance: input.distance } : {}),
    ...(input.icu_rpe !== undefined ? { icu_rpe: input.icu_rpe } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(planId ? { paired_event_id: Number(planId) } : {}),
  };
  const response = await icuFetch(auth, '/athlete/0/activities/manual', { method: 'POST', body: payload, req });
  let created = Array.isArray(response) ? response[0] : response;
  if (!isPlainObject(created) || created.id === undefined || created.id === null || created.id === '') {
    throw new IcuHttpError(502);
  }

  // Шаг 5: проверка привязки.
  let paired = null;
  if (planId) {
    const result = await ensurePaired(req, auth, created, planId);
    created = result.activity;
    paired = result.paired;
  }
  return { status: 200, body: { ok: true, created: true, existing: false, paired, activity: pick(created) } };
}

module.exports = function attachActivityCreate(app) {
  app.post('/gw/icu/activities/manual', siteOnlyGate, uidGate, bodyParser, async (req, res) => {
    try {
      const checked = validateBody(req.body);
      if (!checked.value) {
        return res.status(400).json({ ok: false, error: 'invalid_body', field: checked.field });
      }
      const input = checked.value;
      // Ключ плана строит сервер: stas-done:plan:<id> (клиентский external_id для плана не принимается).
      if (input.plan_event_id) input.external_id = `stas-done:plan:${input.plan_event_id}`;

      const auth = await getIcuRequestAuth(req);
      // Сайт пишет только с OAuth-токеном: ключи (legacy) здесь не принимаем, подмены схемы авторизации нет.
      if (auth.authMode !== 'intervals') {
        return res.status(401).json({ ok: false, error: 'auth_required' });
      }
      const expected = expectedAthleteId(req, auth);
      if (!expected) return res.status(401).json({ ok: false, error: 'missing_or_invalid_token' });

      // Одновременные одинаковые запросы ждут один и тот же результат: Intervals вызывается один раз.
      // Объединяются только запросы с одинаковым содержимым (включая дату): запрос с другой датой идёт по очереди и
      // проходит собственную проверку окна, а не присоединяется к чужому результату.
      const key = `${expected}|${JSON.stringify([
        input.external_id, input.plan_event_id || null, input.type, input.start_date_local, input.moving_time,
        input.name || null, input.distance ?? null, input.icu_rpe ?? null, input.description ?? null,
      ])}`;
      let shared = inflight.get(key);
      if (!shared) {
        // Запросы одного атлета идут по очереди: поиск дублей и создание не перекрываются у разных ключей.
        const previous = athleteQueue.get(expected) || Promise.resolve();
        shared = previous
          .then(() => runCreate(req, auth, expected, input))
          .then((result) => ({ result }), (error) => ({ error }))
          .finally(() => {
            inflight.delete(key);
            if (athleteQueue.get(expected) === shared) athleteQueue.delete(expected);
          });
        athleteQueue.set(expected, shared);
        inflight.set(key, shared);
      }
      const outcome = await shared;
      if (outcome.error) throw outcome.error;

      const { status, body } = outcome.result;
      try { console.log(`[icu][POST][activity_manual] ${logFields(req, {
        status,
        auth_mode: auth.authMode,
        ...(body.created !== undefined ? { created: body.created, reason: body.reason || null, paired: body.paired } : {}),
      })}`); } catch {}
      return res.status(status).json(body);
    } catch (e) {
      return sendRequestAuthError(res, e) || sendIcuError(req, res, e);
    }
  });
};

// Нужен server.js: проверка «только сайт» идёт раньше общей авторизации по токену.
module.exports.siteOnlyGate = siteOnlyGate;
