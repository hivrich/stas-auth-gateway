// Сообщаем STAS об успешной настоящей записи событий календаря в Intervals:
// STAS пишет строку журнала с автором и сразу обновляет свою копию плана.
// Вызывается после успешной записи и до ответа клиенту. Любой сбой (таймаут, сеть, не 2xx)
// ответ клиенту не меняет: пишем одну строку лога и один раз повторяем в фоне
// с тем же телом и тем же request_id (приёмник STAS идемпотентен по request_id).
const getStasKey = require('./get_stas_key');
const { getRequestUserId } = require('./request-auth');
const { buildStasSourceHeaders } = require('./request-source');
const { randomUUID } = require('node:crypto');
const { getStasRequestId } = require('./request-id');
const { getPlanChangeActor } = require('./plan-change-actor');

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_DELAY_MS = 5000;
// В одном вызове до 8 событий (и до 8 deleted). Худший случай одного события по лимитам полей
// FIELD_MAX_LENGTH: (20000 description + 500 name + 200 external_id + 100 type) символов * 3 байта
// (UTF-8, CJK) = 62 400 байт; 8 событий = около 499 200 байт плюс мелкие поля (id, даты, actor) -
// меньше лимита тела приёмника STAS 512 КБ. Расчёт для обычного текста: управляющие символы JSON
// экранирует в 6 байт (\u00XX), для такого текста запас не гарантирован.
// Пачки уходят по очереди, не параллельно: приёмнику не прилетает сразу несколько тяжёлых тел.
const MAX_ITEMS_PER_CALL = 8;
const MAX_CHANGE_REASON = 200;
const MAX_CHANGE_BASIS_LENGTH = 16000;
const MAX_CHANGE_BASIS_ITEMS = 100;

const timings = { timeoutMs: DEFAULT_TIMEOUT_MS, retryDelayMs: DEFAULT_RETRY_DELAY_MS };
const stats = { retriesScheduled: 0 };

const EVENT_FIELDS = [
  'id', 'athlete_id', 'external_id', 'category', 'start_date_local',
  'name', 'type', 'description', 'updated',
];
const DELETED_FIELDS = ['id', 'external_id', 'category', 'start_date_local', 'name'];

function logLine(fields) {
  try { console.log(`[plan_changes][callback] ${JSON.stringify(fields)}`); } catch {}
}

function errorCode(error) {
  return String(error?.name || error?.code || error?.cause?.code || 'error').slice(0, 40);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Лимиты полей приёмника STAS: длиннее строки обрезаем; вместе с пачками по 8 событий тело остаётся меньше 512 КБ.
const FIELD_MAX_LENGTH = { description: 20000, name: 500, external_id: 200, type: 100 };

// Поля события из строки ответа Intervals; чего нет в строке, берём из отправленного события
// (кроме updated и athlete_id: их выдумывать нельзя).
function pickEvent(row, sent, action, sessionType) {
  const source = isPlainObject(row) ? row : {};
  const fallback = isPlainObject(sent) ? sent : {};
  const out = action ? { action } : {};
  for (const key of EVENT_FIELDS) {
    let value = source[key];
    if ((value === undefined || value === null) && key !== 'updated' && key !== 'athlete_id') value = fallback[key];
    const max = FIELD_MAX_LENGTH[key];
    if (max && typeof value === 'string' && value.length > max) value = value.slice(0, max);
    if (value !== undefined) out[key] = value;
  }
  if (typeof sessionType === 'string' && sessionType) out.session_type = sessionType;
  return out;
}

function pickDeleted(row, id) {
  const source = isPlainObject(row) ? row : {};
  const out = { id: source.id ?? id };
  for (const key of DELETED_FIELDS) {
    if (key === 'id') continue;
    out[key] = source[key] ?? null;
  }
  return out;
}

function normalizeSessionType(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 64) : null;
}

function changeReasonFromQuery(req) {
  const raw = req?.query?.change_reason;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, MAX_CHANGE_REASON).trim();
  return trimmed || null;
}

function changeBasisFromQuery(req) {
  const raw = req?.changeBasisValidated;
  if (typeof raw !== 'string' || raw.length > MAX_CHANGE_BASIS_LENGTH) return new Map();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return new Map(); }
  if (!Array.isArray(parsed) || parsed.length > MAX_CHANGE_BASIS_ITEMS) return new Map();

  const basisByExternalId = new Map();
  for (const item of parsed) {
    if (!isPlainObject(item)
      || typeof item.external_id !== 'string' || item.external_id.length > 200
      || typeof item.frame_id !== 'string' || !/^F-[a-z0-9]+(-[a-z0-9]+)*$/.test(item.frame_id)
      || !Number.isInteger(item.frame_version) || item.frame_version <= 0
      || typeof item.decision_id !== 'string' || !/^D\d+$/.test(item.decision_id)) continue;
    basisByExternalId.set(item.external_id, {
      frame_id: item.frame_id,
      frame_version: item.frame_version,
      decision_id: item.decision_id,
    });
  }
  return basisByExternalId;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stasUrl() {
  const base = process.env.STAS_BASE || 'http://127.0.0.1:3336';
  return `${base.replace(/\/+$/, '')}/api/db/plan_changes`;
}

async function postOnce(url, headers, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(timings.timeoutMs),
  });
  // Тело ответа не нужно: освобождаем соединение.
  try { await response.body?.cancel(); } catch {}
  return { ok: response.ok === true, status: response.status };
}

async function sendChunk({ url, headers, payload, requestId, counts, part }) {
  const body = JSON.stringify(payload);
  const base = { stas_request_id: requestId, part, ...counts };
  let failure;
  try {
    const result = await postOnce(url, headers, body);
    if (result.ok) {
      logLine({ ...base, phase: 'first', outcome: 'ok', status: result.status });
      return;
    }
    failure = { status: result.status };
  } catch (error) {
    failure = { err: errorCode(error) };
  }
  logLine({ ...base, phase: 'first', outcome: 'failed', ...failure, retry_in_ms: timings.retryDelayMs });

  stats.retriesScheduled += 1;
  const timer = setTimeout(async () => {
    try {
      const result = await postOnce(url, headers, body);
      logLine({ ...base, phase: 'retry', outcome: result.ok ? 'ok' : 'failed', status: result.status });
    } catch (error) {
      logLine({ ...base, phase: 'retry', outcome: 'failed', err: errorCode(error) });
    }
  }, timings.retryDelayMs);
  if (typeof timer.unref === 'function') timer.unref();
}

// events: [{ action, row, sent, sessionType }], deleted: [{ id, row }]. Никогда не бросает.
async function reportPlanChange(req, { events = [], deleted = [] } = {}) {
  const requestId = getStasRequestId(req) || randomUUID();
  try {
    if (events.length === 0 && deleted.length === 0) return;

    const stasKey = getStasKey();
    const userId = getRequestUserId(req);
    if (!stasKey || !userId) {
      logLine({ stas_request_id: requestId, outcome: 'skipped', reason: !stasKey ? 'missing_stas_key' : 'missing_user_id' });
      return;
    }

    const eventItems = events.map((item) => pickEvent(item.row, item.sent, item.action, normalizeSessionType(item.sessionType)));
    const deletedItems = deleted.map((item) => pickDeleted(item.row, item.id));
    const changeReason = changeReasonFromQuery(req);
    const changeBasis = changeBasisFromQuery(req);
    for (const item of [...eventItems, ...deletedItems]) {
      const basis = changeBasis.get(item.external_id);
      if (basis) item.basis = basis;
    }
    const parts = [
      ...chunk(eventItems, MAX_ITEMS_PER_CALL).map((items) => ({ events: items })),
      ...chunk(deletedItems, MAX_ITEMS_PER_CALL).map((items) => ({ deleted: items })),
    ];

    const headers = buildStasSourceHeaders(req, {
      'X-API-Key': stasKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
    const url = stasUrl();
    const actor = getPlanChangeActor(req);

    // По очереди: следующая пачка уходит после ответа (или сбоя) предыдущей; повтор сбойной - в фоне, как раньше.
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const partRequestId = index === 0 ? requestId : `${requestId}#${index + 1}`;
      const payload = {
        user_id: userId,
        actor,
        request_id: partRequestId,
        ...(changeReason ? { change_reason: changeReason } : {}),
        ...part,
      };
      const counts = { actor, events: part.events?.length || 0, deleted: part.deleted?.length || 0 };
      await sendChunk({ url, headers, payload, requestId, counts, part: index + 1 });
    }
  } catch (error) {
    logLine({ stas_request_id: requestId, outcome: 'error', err: errorCode(error) });
  }
}

module.exports = {
  normalizeSessionType,
  reportPlanChange,
  __testing: {
    getStats: () => ({ ...stats }),
    resetStats: () => { stats.retriesScheduled = 0; },
    setTimings: (next = {}) => {
      timings.timeoutMs = next.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      timings.retryDelayMs = next.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    },
  },
};
