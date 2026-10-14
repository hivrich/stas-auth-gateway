// Журнал попыток к Intervals.icu: каждая реальная HTTP-попытка шлюза (в том числе повтор Basic
// после отказа Bearer и поиск атлета /athlete/0) уходит записью в STAS.
// Отчёт - fire-and-forget: ответ пользователю он не задерживает и не ломает (таймаут 2 с, ошибки глотаем).
const getStasKey = require('./get_stas_key');
const { STAS_REQUEST_ID_HEADER, getStasRequestId } = require('./request-id');
const { getRequestSource } = require('./request-source');

const REPORT_TIMEOUT_MS = 2000;
const INITIATORS = new Set(['site', 'gpt', 'claude', 'mcp']);
const ATTEMPT_KINDS = new Set(['bearer', 'basic', 'athlete_lookup', 'other']);

const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const HTTP_DATE_RE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

// Retry-After Intervals: целые секунды или HTTP-дата (IMF-fixdate). Всё остальное (минус, дробь, мусор) - не разбирается.
// Возвращает { header, ms }: значение, которое можно переслать дальше, и миллисекунды (не больше суток).
function parseRetryAfter(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const cap = MAX_RETRY_AFTER_SECONDS * 1000;
  if (/^\d+$/.test(raw)) {
    const seconds = Math.min(Number(raw), MAX_RETRY_AFTER_SECONDS);
    return { header: String(seconds), ms: seconds * 1000 };
  }
  if (!HTTP_DATE_RE.test(raw)) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return { header: raw, ms: Math.min(Math.max(0, at - now), cap) };
}

function parseRetryAfterMs(value, now = Date.now()) {
  return parseRetryAfter(value, now)?.ms ?? null;
}

// Ставит Retry-After в ответ (только разобранное значение) и возвращает миллисекунды или null.
function forwardRetryAfter(res, value) {
  const parsed = parseRetryAfter(value);
  if (!parsed) return null;
  res.set('Retry-After', parsed.header);
  return parsed.ms;
}

function headerOf(resp, name) {
  try { return resp?.headers?.get?.(name) ?? null; } catch { return null; }
}

function normalizeProviderId(value) {
  const id = String(value ?? '').trim().replace(/^i/i, '');
  return /^\d{1,20}$/.test(id) && id !== '0' ? id : null;
}

// Атлет попытки: явный ctx.athleteId; сохранённые ключи (legacy) - athleteId учётных данных;
// прямой OAuth - id из /athlete/0 (uid запроса).
function providerAthleteIdOf(ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx, 'athleteId')) return normalizeProviderId(ctx.athleteId);
  if (ctx.auth?.authMode === 'legacy') return normalizeProviderId(ctx.auth.athleteId);
  if (!ctx.req) return null;
  // Ленивый require: request-auth сам подключает этот модуль.
  const { getRequestUserId } = require('./request-auth');
  return normalizeProviderId(getRequestUserId(ctx.req));
}

function initiatorOf(ctx) {
  const value = ctx.initiator || (ctx.req ? getRequestSource(ctx.req) : 'gpt');
  return INITIATORS.has(value) ? value : 'gpt';
}

function attemptNumberOf(req) {
  const raw = String(req?.get?.('x-stas-attempt') ?? req?.headers?.['x-stas-attempt'] ?? '').trim();
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 100 ? n : null;
}

function pathOf(url) {
  try { return new URL(String(url)).pathname.slice(0, 300); } catch { return ''; }
}

function outcomeOfError(error) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  return (name === 'AbortError' || name === 'TimeoutError' ||
    /\b(abort|aborted|timeout|timed out)\b/i.test(message)) ? 'timeout' : 'network_error';
}

async function sendRecord(record, requestId) {
  const stasKey = getStasKey();
  if (!stasKey) return;
  const base = (process.env.STAS_BASE || 'http://127.0.0.1:3336').replace(/\/+$/, '');
  await fetch(`${base}/api/db/intervals-attempts`, {
    method: 'POST',
    headers: {
      'X-API-Key': stasKey,
      'Content-Type': 'application/json',
      ...(requestId ? { [STAS_REQUEST_ID_HEADER]: requestId } : {}),
    },
    body: JSON.stringify(record),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
}

// Собирает запись и отправляет, не блокируя вызывающего. Любая ошибка проглатывается.
function report(ctx, url, method, startedAt, latencyMs, result) {
  try {
    if (!getStasKey()) return;
    const requestId = ctx.requestId || getStasRequestId(ctx.req);
    const kind = ATTEMPT_KINDS.has(ctx.kind) ? ctx.kind : 'other';
    const build = async () => {
      let providerId = providerAthleteIdOf(ctx);
      // Поиск атлета: id берём из тела ответа (копия, основной ответ читает вызывающий).
      if (ctx.idFromBody) {
        providerId = null;
        if (result.bodyClone) {
          const payload = await result.bodyClone.json().catch(() => null);
          providerId = normalizeProviderId(payload?.id);
        }
      }
      await sendRecord({
        provider_athlete_id: providerId,
        initiator: initiatorOf(ctx),
        method,
        path: pathOf(url),
        http_status: result.status,
        outcome: result.outcome,
        retry_after_ms: result.status === 429 ? result.retryAfterMs : null,
        latency_ms: latencyMs,
        started_at: startedAt,
        attempt_kind: kind,
        attempt_number: attemptNumberOf(ctx.req),
      }, requestId);
    };
    build().catch(() => {});
  } catch {}
}

// Обёртка над fetch для всех прямых вызовов intervals.icu.
// ctx: { req, auth, kind: 'bearer'|'basic'|'athlete_lookup'|'other', athleteId?, initiator?, requestId?, idFromBody? }
async function fetchIntervals(url, init, ctx = {}) {
  const method = String(init?.method || 'GET').toUpperCase();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let resp;
  try {
    resp = await fetch(url, init);
  } catch (error) {
    report(ctx, url, method, startedAt, Date.now() - t0, { status: null, outcome: outcomeOfError(error), retryAfterMs: null });
    throw error;
  }
  let bodyClone = null;
  if (ctx.idFromBody && resp.ok) {
    try { bodyClone = resp.clone(); } catch {}
  }
  report(ctx, url, method, startedAt, Date.now() - t0, {
    status: Number.isInteger(resp.status) ? resp.status : null,
    outcome: resp.ok ? 'ok' : 'http_error',
    retryAfterMs: parseRetryAfterMs(headerOf(resp, 'retry-after')),
    bodyClone,
  });
  return resp;
}

module.exports = {
  fetchIntervals,
  forwardRetryAfter,
  parseRetryAfter,
  parseRetryAfterMs,
  __testing: { normalizeProviderId },
};
