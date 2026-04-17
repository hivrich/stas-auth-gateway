const getStasKey = require('./get_stas_key');
const { getRequestSource, normalizeSource } = require('./request-source');

const DIRECT_TOKEN_CACHE_TTL_MS = Number(process.env.INTERVALS_TOKEN_CACHE_TTL_MS || 60 * 60 * 1000);
const DIRECT_TOKEN_CACHE_MAX = Number(process.env.INTERVALS_TOKEN_CACHE_MAX || 1000);
const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

const directTokenCache = new Map();

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function cleanupDirectTokenCache() {
  const now = Date.now();

  for (const [token, entry] of directTokenCache.entries()) {
    if (entry.expiresAt <= now) directTokenCache.delete(token);
  }

  if (directTokenCache.size <= DIRECT_TOKEN_CACHE_MAX) return;

  const overflow = directTokenCache.size - DIRECT_TOKEN_CACHE_MAX;
  const keys = directTokenCache.keys();
  for (let i = 0; i < overflow; i += 1) {
    const next = keys.next();
    if (next.done) break;
    directTokenCache.delete(next.value);
  }
}

function getBearerToken(req) {
  const auth = trimToString(req?.get?.('authorization') || req?.headers?.authorization || req?.headers?.Authorization);
  if (!/^Bearer\s+/i.test(auth)) return null;
  return auth.replace(/^Bearer\s+/i, '').trim() || null;
}

function parseLegacyAccessToken(token) {
  if (!token || !token.startsWith('t_')) return null;

  try {
    let b64 = token.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const userId = trimToString(payload?.uid ?? payload?.user_id);
    if (!userId) return null;
    return { userId, authMode: 'legacy' };
  } catch {
    return null;
  }
}

async function fetchIntervalsAthlete(token) {
  const response = await fetch('https://intervals.icu/api/v1/athlete/0', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  const userId = trimToString(payload?.id);
  if (!userId) return null;

  return {
    userId,
    athleteName: typeof payload?.name === 'string' ? payload.name.trim() : undefined,
  };
}

async function ensureIntervalsUser({ userId, intervalsToken, athleteName, source = 'gpt' }) {
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
  const cached = directTokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      userId: cached.userId,
      authMode: 'intervals',
      intervalsToken: token,
      source,
    };
  }

  const athlete = await fetchIntervalsAthlete(token);
  if (!athlete) return null;

  await ensureIntervalsUser({
    userId: athlete.userId,
    intervalsToken: token,
    athleteName: athlete.athleteName,
    source,
  });

  cleanupDirectTokenCache();
  directTokenCache.set(token, {
    userId: athlete.userId,
    expiresAt: Date.now() + DIRECT_TOKEN_CACHE_TTL_MS,
  });

  return {
    userId: athlete.userId,
    authMode: 'intervals',
    intervalsToken: token,
    source,
  };
}

async function resolveRequestAuth(req) {
  if (req?.auth?.userId) return req.auth;

  const token = getBearerToken(req);
  if (!token) return null;

  const legacy = parseLegacyAccessToken(token);
  if (legacy) {
    return {
      ...legacy,
      source: getRequestSource(req),
    };
  }

  return resolveDirectIntervalsAuth(token, { source: getRequestSource(req) });
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

module.exports = {
  applyResolvedAuth,
  getBearerToken,
  getIntervalsToken,
  getRequestUserId,
  getResolvedAuth,
  parseLegacyAccessToken,
  resolveDirectIntervalsAuth,
  resolveRequestAuth,
};
