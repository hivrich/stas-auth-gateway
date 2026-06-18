const getStasKey = require('./get_stas_key');
const { getIntervalsToken, getRequestUserId, getResolvedAuth } = require('./request-auth');
const { buildStasSourceHeaders } = require('./request-source');

const STAS_BASE = process.env.STAS_BASE || 'http://127.0.0.1:3336';

async function loadStoredIcuCreds(req, userId) {
  const stasKey = getStasKey();
  if (!stasKey) {
    const error = new Error('missing_stas_key');
    error.status = 500;
    throw error;
  }

  const url = new URL(`${STAS_BASE.replace(/\/+$/, '')}/api/db/icu_creds`);
  url.searchParams.set('user_id', userId);

  const response = await fetch(url, {
    headers: buildStasSourceHeaders(req, {
      'X-API-Key': stasKey,
      Accept: 'application/json',
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const error = new Error(response.status === 404 ? 'icu_creds_not_found' : 'icu_creds_error');
    error.status = response.status;
    try {
      error.details = await response.json();
    } catch {
      error.details = null;
    }
    throw error;
  }

  const payload = await response.json();
  if (!payload?.api_key || !payload?.athlete_id) {
    const error = new Error('icu_creds_not_found');
    error.status = 404;
    throw error;
  }

  return {
    token: String(payload.api_key),
    athleteId: String(payload.athlete_id),
    authMode: 'legacy',
  };
}

async function getIcuRequestAuth(req) {
  const userId = getRequestUserId(req);
  if (!userId) {
    const error = new Error('missing_or_invalid_token');
    error.status = 401;
    throw error;
  }

  const intervalsToken = getIntervalsToken(req);
  if (intervalsToken) {
    const resolvedAuth = getResolvedAuth(req);
    return {
      token: intervalsToken,
      athleteId: '0',
      authMode: resolvedAuth?.authMode === 'agent' ? 'agent' : 'intervals',
      userId,
    };
  }

  const stored = await loadStoredIcuCreds(req, userId);
  return {
    ...stored,
    userId,
  };
}

module.exports = {
  getIcuRequestAuth,
};
