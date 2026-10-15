const crypto = require('node:crypto');
const getStasKey = require('./get_stas_key');
const { getStasRequestId, STAS_REQUEST_ID_HEADER } = require('./request-id');
const { resolveAgentAccessToken } = require('./agent-auth');
const { resolveMcpAccessToken } = require('./mcp-oauth-tokens');
const { getRequestSource, isStasServerRequest, normalizeSource } = require('./request-source');
const { fetchIntervals } = require('./icu-attempt-ledger');

const DIRECT_TOKEN_CACHE_TTL_MS = Number(process.env.INTERVALS_TOKEN_CACHE_TTL_MS || 60 * 60 * 1000);
const DIRECT_TOKEN_CACHE_MAX = Number(process.env.INTERVALS_TOKEN_CACHE_MAX || 1000);
// Кэш поиска атлета (/athlete/0) для проверенных серверных вызовов STAS: короткий TTL, отдельно от directTokenCache.
const SERVER_CALL_ATHLETE_CACHE_TTL_MS = Number(process.env.INTERVALS_SERVER_CACHE_TTL_MS || 5 * 60 * 1000);
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

const directTokenCache = new Map();
// Ключ тот же sha256 токена; значение { userId, expiresAt }. Не-серверные запросы его не читают и не пишут; серверные вызовы пишут только сюда.
const serverCallAthleteCache = new Map();
// Выполняющиеся поиски атлета по хешу токена: одновременные запросы ждут один и тот же ответ.
const athleteLookupInflight = new Map();

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function makeDirectTokenCacheKey(token) {
  const raw = trimToString(token);
  if (!raw) return null;
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

// Убирает просроченные записи и самые старые сверх DIRECT_TOKEN_CACHE_MAX.
function cleanupTokenCache(cache) {
  const now = Date.now();

  for (const [cacheKey, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(cacheKey);
  }

  if (cache.size <= DIRECT_TOKEN_CACHE_MAX) return;

  const overflow = cache.size - DIRECT_TOKEN_CACHE_MAX;
  const keys = cache.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    cache.delete(next.value);
  }
}

function cleanupDirectTokenCache() {
  cleanupTokenCache(directTokenCache);
}

function getBearerToken(req) {
  const auth = trimToString(req?.get?.('authorization') || req?.headers?.authorization || req?.headers?.Authorization);
  if (!/^Bearer\s+/i.test(auth)) return null;
  return auth.replace(/^Bearer\s+/i, '').trim() || null;
}

function logLegacyBearerRejected(req) {
  try {
    console.warn('[auth][legacy_t_bearer_rejected]', JSON.stringify({
      stas_request_id: getStasRequestId(req),
      method: trimToString(req?.method) || null,
      path: trimToString(req?.path || '').split('?')[0] || null,
      source: getRequestSource(req),
    }));
  } catch {}
}

async function fetchIntervalsAthlete(token, requestId = null, ledger = {}, rateLimitError = false) {
  const response = await fetchIntervals('https://intervals.icu/api/v1/athlete/0', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(requestId ? { [STAS_REQUEST_ID_HEADER]: requestId } : {}),
    },
    signal: AbortSignal.timeout(5000),
  }, { ...ledger, kind: 'athlete_lookup', idFromBody: true, requestId });

  if (!response.ok) {
    // Лимит Intervals на проверке токена: для запросов шлюза отдаём 429 с Retry-After, а не 401.
    if (rateLimitError && response.status === 429) {
      const error = new Error('intervals_rate_limited');
      error.status = 429;
      error.retryAfter = response.headers?.get?.('retry-after') ?? null;
      throw error;
    }
    return null;
  }

  const payload = await response.json().catch(() => null);
  const userId = trimToString(payload?.id);
  if (!userId) return null;

  return {
    userId,
    athleteName: typeof payload?.name === 'string' ? payload.name.trim() : undefined,
  };
}

async function ensureIntervalsUser({ userId, intervalsToken, athleteName, source = 'gpt', requestId = null }) {
  const stasKey = getStasKey();
  if (!stasKey) {
    const error = new Error('missing_stas_key');
    error.status = 500;
    throw error;
  }

  const response = await fetch(`${STAS_BASE.replace(/\/+$/, '')}/api/db/ensure-intervals-user`, {
    method: 'POST',
    headers: {
      'X-API-Key': stasKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(requestId ? { [STAS_REQUEST_ID_HEADER]: requestId } : {}),
    },
    body: JSON.stringify({
      intervalsAthleteId: userId,
      intervalsAccessToken: intervalsToken,
      source: normalizeSource(source),
      ...(athleteName ? { firstName: athleteName } : {}),
    }),
    signal: AbortSignal.timeout(7000),
  });

  if (response.ok) {
    return response.json().catch(() => ({ ok: true }));
  }

  let details = null;
  try {
    details = await response.json();
  } catch {
    try {
      details = await response.text();
    } catch {
      details = null;
    }
  }

  const error = new Error('ensure_intervals_user_failed');
  error.status = response.status || 502;
  error.details = details;
  throw error;
}

async function resolveDirectIntervalsAuth(token, options = {}) {
  const source = normalizeSource(options.source);
  const requestId = trimToString(options.requestId) || null;
  const cacheKey = makeDirectTokenCacheKey(token);
  if (!cacheKey) return null;

  const isServerCall = options.stasServerCall === true;

  // Серверный вызов может прочитать directTokenCache (запись от не-серверных запросов, как раньше), но писать в него не может.
  const cached = directTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      userId: cached.userId,
      athleteId: cached.athleteId,
      authMode: 'intervals',
      intervalsToken: token,
      source,
    };
  }

  // Серверный вызов: свой короткий кэш поиска атлета, без fetch и без записи в журнал попыток.
  if (isServerCall) {
    const serverCached = serverCallAthleteCache.get(cacheKey);
    if (serverCached && serverCached.expiresAt > Date.now()) {
      return {
        userId: serverCached.userId,
        athleteId: undefined,
        authMode: 'intervals',
        intervalsToken: token,
        source,
      };
    }
  }

  // Одновременные поиски атлета по одному токену объединяются: один запрос /athlete/0 на всех (бюджет запросов);
  // промис убирается по завершению, ошибки и отказы не запоминаются.
  const lookupKey = `${cacheKey}|${options.rateLimitError === true ? 'rl' : ''}`;
  let pendingLookup = athleteLookupInflight.get(lookupKey);
  if (!pendingLookup) {
    pendingLookup = fetchIntervalsAthlete(token, requestId, { req: options.req, initiator: source }, options.rateLimitError === true)
      .finally(() => { athleteLookupInflight.delete(lookupKey); });
    athleteLookupInflight.set(lookupKey, pendingLookup);
  }
  const athlete = await pendingLookup;
  if (!athlete) return null;

  // Серверный вызов STAS: атлет уже есть в STAS, ensure-intervals-user (флаги подключения,
  // событие mcp/gpt_connected, перестройка сводки) не нужен. userId - из /athlete/0.
  // В directTokenCache не пишем: иначе следующий не-серверный запрос с этим токеном пропустил бы ensure.
  // Успешный поиск кладём только в serverCallAthleteCache (отказы, в том числе 429, не кэшируются).
  if (isServerCall) {
    cleanupTokenCache(serverCallAthleteCache);
    serverCallAthleteCache.set(cacheKey, {
      userId: athlete.userId,
      expiresAt: Date.now() + SERVER_CALL_ATHLETE_CACHE_TTL_MS,
    });
    return {
      userId: athlete.userId,
      athleteId: undefined,
      authMode: 'intervals',
      intervalsToken: token,
      source,
    };
  }

  const ensured = await ensureIntervalsUser({
    userId: athlete.userId,
    intervalsToken: token,
    athleteName: athlete.athleteName,
    source,
    requestId,
  });

  cleanupDirectTokenCache();
  directTokenCache.set(cacheKey, {
    userId: athlete.userId,
    athleteId: Number(ensured?.athleteId || ensured?.user_id) || undefined,
    expiresAt: Date.now() + DIRECT_TOKEN_CACHE_TTL_MS,
  });

  return {
    userId: athlete.userId,
    athleteId: Number(ensured?.athleteId || ensured?.user_id) || undefined,
    authMode: 'intervals',
    intervalsToken: token,
    source,
  };
}

async function resolveRequestAuth(req) {
  if (req?.auth?.userId) return req.auth;

  const token = getBearerToken(req);
  if (!token) return null;

  if (token.startsWith('t_')) {
    logLegacyBearerRejected(req);
    return null;
  }

  const agent = resolveAgentAccessToken(token);
  if (agent.matched) return agent.auth || null;

  const mcp = await resolveMcpAccessToken(token);
  if (mcp.matched) return mcp.auth || null;

  return resolveDirectIntervalsAuth(token, {
    source: getRequestSource(req),
    requestId: getStasRequestId(req),
    stasServerCall: isStasServerRequest(req),
    req,
    rateLimitError: true,
  });
}

function applyResolvedAuth(req, res, auth) {
  req.auth = auth;
  req.user_id = auth.userId;
  req.bearer = { uid: auth.userId, authMode: auth.authMode };
  req.headers['x-user-id'] = auth.userId;

  if (auth.intervalsToken) {
    req.intervals_token = auth.intervalsToken;
  } else {
    delete req.intervals_token;
  }

  const nextQuery = Object.assign({}, req.query);
  nextQuery.user_id = auth.userId;
  req.query = nextQuery;

  if (res?.locals) {
    res.locals.user_id = auth.userId;
    res.locals.auth = auth;
  }
}

function getResolvedAuth(req) {
  if (req?.auth?.userId) return req.auth;

  const userId = trimToString(
    req?.user_id ||
    req?.headers?.['x-user-id'] ||
    req?.bearer?.uid,
  );

  if (!userId) return null;

  const intervalsToken = trimToString(req?.intervals_token);
  return {
    userId,
    authMode: intervalsToken ? 'intervals' : 'legacy',
    source: getRequestSource(req),
    ...(intervalsToken ? { intervalsToken } : {}),
  };
}

function getRequestUserId(req) {
  return getResolvedAuth(req)?.userId || null;
}

function getIntervalsToken(req) {
  return getResolvedAuth(req)?.intervalsToken || null;
}

function getDirectTokenCacheKeysForTests() {
  return Array.from(directTokenCache.keys());
}

function clearDirectTokenCacheForTests() {
  directTokenCache.clear();
  athleteLookupInflight.clear();
  serverCallAthleteCache.clear();
}

function forgetDirectIntervalsToken(token) {
  const cacheKey = makeDirectTokenCacheKey(token);
  if (!cacheKey) return false;
  serverCallAthleteCache.delete(cacheKey);
  return directTokenCache.delete(cacheKey);
}

module.exports = {
  __testing: {
    clearDirectTokenCache: clearDirectTokenCacheForTests,
    getDirectTokenCacheKeys: getDirectTokenCacheKeysForTests,
    isStasServerRequest,
    makeDirectTokenCacheKey,
  },
  applyResolvedAuth,
  getBearerToken,
  getIntervalsToken,
  getRequestUserId,
  getResolvedAuth,
  resolveDirectIntervalsAuth,
  resolveRequestAuth,
  forgetDirectIntervalsToken,
};
