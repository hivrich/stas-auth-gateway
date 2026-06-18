const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const AGENT_AUTH_GRANT_TYPE = 'urn:workos:agent-auth:grant-type:claim';
const AGENT_AUTH_SCOPE = 'stas.mcp.read';
const AGENT_TOKEN_PREFIX = 'stas_agent_';
const AGENT_INTERVALS_READ_SCOPE = 'ACTIVITY:READ,WELLNESS:READ,CALENDAR:READ';
const AGENT_AUTH_ISSUER = 'stas-auth-gateway';
const AGENT_AUTH_AUDIENCE = 'stas-agent-auth';

const DEFAULT_CLAIM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_AGENT_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_STATE_TTL_MS = 10 * 60 * 1000;
const REGISTRATION_RATE_WINDOW_MS = 60 * 1000;
const REGISTRATION_RATE_LIMIT = 20;
const CLAIM_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_ATTEMPT_LIMIT = 20;
const DEFAULT_REGISTRATION_CODE_ATTEMPT_LIMIT = 5;

const registrationsById = new Map();
const claimHashToRegistrationId = new Map();
const userCodeHashToRegistrationId = new Map();
const agentStatesByHash = new Map();
const agentSessionsByJti = new Map();
const revokedAgentJtis = new Set();
const registrationRateByIp = new Map();
const claimAttemptRateByIp = new Map();

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function boolFromEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(trimToString(value).toLowerCase());
}

function getAgentAuthSecret() {
  return trimToString(process.env.AGENT_AUTH_TOKEN_SECRET);
}

function isAgentAuthConfigured() {
  return boolFromEnv(process.env.AGENT_AUTH_ENABLED) && Boolean(getAgentAuthSecret());
}

function getClaimTtlMs() {
  return Math.max(1000, Number(process.env.AGENT_AUTH_CLAIM_TTL_MS || DEFAULT_CLAIM_TTL_MS));
}

function getAgentTokenTtlSeconds() {
  return Math.max(60, Number(process.env.AGENT_AUTH_TOKEN_TTL_SECONDS || DEFAULT_AGENT_TOKEN_TTL_SECONDS));
}

function getPollIntervalSeconds() {
  return Math.max(1, Number(process.env.AGENT_AUTH_POLL_INTERVAL_SECONDS || DEFAULT_POLL_INTERVAL_SECONDS));
}

function getRegistrationCodeAttemptLimit() {
  return Math.max(1, Number(process.env.AGENT_AUTH_CODE_ATTEMPT_LIMIT || DEFAULT_REGISTRATION_CODE_ATTEMPT_LIMIT));
}

function randomBase64Url(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashValue(namespace, value) {
  const secret = getAgentAuthSecret() || 'agent-auth-disabled';
  return crypto
    .createHmac('sha256', secret)
    .update(namespace)
    .update('\0')
    .update(trimToString(value))
    .digest('hex');
}

function signValue(namespace, value) {
  const secret = getAgentAuthSecret() || 'agent-auth-disabled';
  return crypto
    .createHmac('sha256', secret)
    .update(namespace)
    .update('\0')
    .update(trimToString(value))
    .digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(trimToString(a));
  const right = Buffer.from(trimToString(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function secondsUntil(ts) {
  return Math.max(0, Math.ceil((Number(ts) - Date.now()) / 1000));
}

function makeError(message, status = 400, code = message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function assertAgentAuthConfigured() {
  if (!isAgentAuthConfigured()) {
    throw makeError('agent_auth_not_configured', 503, 'service_unavailable');
  }
}

function checkWindowCounter(map, key, limit, windowMs) {
  const now = Date.now();
  const current = map.get(key);
  if (!current || current.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  current.count += 1;
  return current.count <= limit;
}

function cleanupAgentAuthState() {
  const now = Date.now();

  for (const [hash, state] of agentStatesByHash.entries()) {
    if (!state || Number(state.expiresAt) <= now) agentStatesByHash.delete(hash);
  }

  for (const [jti, session] of agentSessionsByJti.entries()) {
    if (!session || session.revoked || Number(session.expiresAt) <= now) {
      agentSessionsByJti.delete(jti);
    }
  }

  for (const [registrationId, registration] of registrationsById.entries()) {
    if (!registration) {
      registrationsById.delete(registrationId);
      continue;
    }

    const hasLiveSession = Array.from(registration.agentJtis || []).some((jti) => agentSessionsByJti.has(jti));
    if (registration.status === 'pending' && Number(registration.expiresAt) <= now) {
      registration.status = 'expired';
      removeAllUserCodeMappings(registration);
    }

    if ((registration.status === 'expired' || registration.status === 'revoked') && !hasLiveSession) {
      claimHashToRegistrationId.delete(registration.claimTokenHash);
      removeAllUserCodeMappings(registration);
      registrationsById.delete(registrationId);
    }
  }

  for (const [key, record] of registrationRateByIp.entries()) {
    if (!record || Number(record.resetAt) <= now) registrationRateByIp.delete(key);
  }

  for (const [key, record] of claimAttemptRateByIp.entries()) {
    if (!record || Number(record.resetAt) <= now) claimAttemptRateByIp.delete(key);
  }
}

function isClaimExpired(registration) {
  return !registration || Number(registration.expiresAt) <= Date.now();
}

function isClaimUsable(registration) {
  return registration
    && registration.status !== 'revoked'
    && registration.status !== 'expired'
    && registration.status !== 'blocked'
    && !registration.blockedAt
    && !isClaimExpired(registration);
}

function buildVerificationUri(origin) {
  return `${trimToString(origin).replace(/\/+$/, '')}/gw/agent/claim`;
}

function buildClaimResponse(registration, claimToken, origin, userCode) {
  const expiresIn = secondsUntil(registration.expiresAt);
  const interval = Number(registration.pollIntervalSeconds) || getPollIntervalSeconds();

  return {
    registration_id: registration.registrationId,
    claim_token: claimToken,
    expires_in: expiresIn,
    interval,
    claim: {
      user_code: userCode || null,
      verification_uri: buildVerificationUri(origin),
      expires_in: expiresIn,
      interval,
    },
  };
}

function generateUniqueUserCode() {
  for (let i = 0; i < 100; i += 1) {
    const userCode = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const userCodeHash = hashValue('agent-user-code', userCode);
    const collisionRegistrationId = userCodeHashToRegistrationId.get(userCodeHash);
    if (!collisionRegistrationId) return userCode;

    const collisionRegistration = registrationsById.get(collisionRegistrationId);
    if (
      !collisionRegistration
      || collisionRegistration.status === 'expired'
      || collisionRegistration.status === 'revoked'
      || isClaimExpired(collisionRegistration)
    ) {
      userCodeHashToRegistrationId.delete(userCodeHash);
      return userCode;
    }
  }

  throw makeError('user_code_generation_failed', 500, 'server_error');
}

function ensureRetiredUserCodeHashes(registration) {
  if (!registration.retiredUserCodeHashes) registration.retiredUserCodeHashes = new Set();
  return registration.retiredUserCodeHashes;
}

function ensureInvalidUserCodeAttemptsByHash(registration) {
  if (!registration.invalidUserCodeAttemptsByHash) registration.invalidUserCodeAttemptsByHash = new Map();
  return registration.invalidUserCodeAttemptsByHash;
}

function removeAllUserCodeMappings(registration) {
  if (!registration) return;

  if (registration.userCodeHash) {
    userCodeHashToRegistrationId.delete(registration.userCodeHash);
  }

  for (const hash of registration.retiredUserCodeHashes || []) {
    userCodeHashToRegistrationId.delete(hash);
  }

  registration.userCodeHash = null;
  registration.retiredUserCodeHashes = new Set();
}

function retireActiveUserCodeHash(registration) {
  if (!registration?.userCodeHash) return;

  ensureRetiredUserCodeHashes(registration).add(registration.userCodeHash);
  registration.userCodeHash = null;
}

function assignFreshUserCode(registration) {
  retireActiveUserCodeHash(registration);

  const userCode = generateUniqueUserCode();
  const userCodeHash = hashValue('agent-user-code', userCode);
  registration.userCodeHash = userCodeHash;
  registration.userCodeRotatedAt = Date.now();
  userCodeHashToRegistrationId.set(userCodeHash, registration.registrationId);
  return userCode;
}

function blockRegistrationForInvalidCodeAttempts(registration) {
  registration.status = 'blocked';
  registration.blockedAt = Date.now();
  removeAllUserCodeMappings(registration);
}

function recordInvalidUserCodeAttempt(userCodeHash) {
  const registrationId = userCodeHashToRegistrationId.get(userCodeHash);
  if (!registrationId) return null;

  const registration = registrationsById.get(registrationId);
  if (!registration || !isClaimUsable(registration) || registration.status !== 'pending') return null;

  const attemptsByHash = ensureInvalidUserCodeAttemptsByHash(registration);
  const perCodeAttempts = Number(attemptsByHash.get(userCodeHash) || 0) + 1;
  attemptsByHash.set(userCodeHash, perCodeAttempts);
  registration.invalidUserCodeAttempts = Number(registration.invalidUserCodeAttempts || 0) + 1;

  const limit = getRegistrationCodeAttemptLimit();
  if (perCodeAttempts >= limit || registration.invalidUserCodeAttempts >= limit) {
    blockRegistrationForInvalidCodeAttempts(registration);
  }

  return registration;
}

function createAnonymousIdentity({ origin, ip = 'unknown' }) {
  assertAgentAuthConfigured();
  cleanupAgentAuthState();

  if (!checkWindowCounter(registrationRateByIp, trimToString(ip) || 'unknown', REGISTRATION_RATE_LIMIT, REGISTRATION_RATE_WINDOW_MS)) {
    throw makeError('too_many_registration_attempts', 429, 'slow_down');
  }

  const registrationId = `areg_${randomBase64Url(16)}`;
  const claimToken = `claim_${randomBase64Url(32)}`;
  const expiresAt = Date.now() + getClaimTtlMs();
  const registration = {
    registrationId,
    claimTokenHash: hashValue('agent-claim-token', claimToken),
    userCodeHash: null,
    retiredUserCodeHashes: new Set(),
    invalidUserCodeAttempts: 0,
    invalidUserCodeAttemptsByHash: new Map(),
    createdAt: Date.now(),
    expiresAt,
    status: 'pending',
    pollIntervalSeconds: getPollIntervalSeconds(),
    lastPollAt: 0,
    agentJtis: new Set(),
  };
  const issuedUserCode = assignFreshUserCode(registration);

  registrationsById.set(registrationId, registration);
  claimHashToRegistrationId.set(registration.claimTokenHash, registrationId);

  return buildClaimResponse(registration, claimToken, origin, issuedUserCode);
}

function findRegistrationByClaimToken(claimToken) {
  cleanupAgentAuthState();
  const token = trimToString(claimToken);
  if (!token) return null;

  const registrationId = claimHashToRegistrationId.get(hashValue('agent-claim-token', token));
  if (!registrationId) return null;
  return registrationsById.get(registrationId) || null;
}

function getClaimCeremony(claimToken, { origin }) {
  assertAgentAuthConfigured();
  const registration = findRegistrationByClaimToken(claimToken);
  if (!isClaimUsable(registration) || registration.status !== 'pending' || registration.tokenIssuedAt) {
    throw makeError('invalid_grant', 400, 'invalid_grant');
  }

  const userCode = assignFreshUserCode(registration);
  return buildClaimResponse(registration, claimToken, origin, userCode);
}

function base64urlJson(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function signAgentState(registrationId) {
  assertAgentAuthConfigured();
  const payload = {
    ns: 'agent_auth',
    registration_id: registrationId,
    nonce: randomBase64Url(18),
    exp: Date.now() + DEFAULT_STATE_TTL_MS,
  };
  const body = base64urlJson(payload);
  const signature = signValue('agent-state', body);
  const state = `${body}.${signature}`;
  agentStatesByHash.set(hashValue('agent-state-token', state), {
    registrationId,
    expiresAt: payload.exp,
  });
  return state;
}

function readSignedAgentState(value) {
  const raw = trimToString(value);
  const [body, signature] = raw.split('.');
  if (!body || !signature) return null;

  const expected = signValue('agent-state', body);
  if (!safeEqual(expected, signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.ns !== 'agent_auth') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function findRegistrationByUserCode(userCode) {
  const normalized = trimToString(userCode).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;

  const userCodeHash = hashValue('agent-user-code', normalized);
  const registrationId = userCodeHashToRegistrationId.get(userCodeHash);
  if (!registrationId) return null;

  const registration = registrationsById.get(registrationId);
  if (
    registration
    && registration.userCodeHash === userCodeHash
    && isClaimUsable(registration)
    && registration.status === 'pending'
  ) {
    return registration;
  }

  return null;
}

function createIntervalsClaimStateForUserCode(userCode, { ip = 'unknown' } = {}) {
  assertAgentAuthConfigured();
  cleanupAgentAuthState();

  const rateKey = trimToString(ip) || 'unknown';
  if (!checkWindowCounter(claimAttemptRateByIp, rateKey, CLAIM_ATTEMPT_LIMIT, CLAIM_ATTEMPT_WINDOW_MS)) {
    throw makeError('too_many_claim_attempts', 429, 'slow_down');
  }

  const registration = findRegistrationByUserCode(userCode);
  if (!registration) {
    const normalized = trimToString(userCode).replace(/\s+/g, '');
    if (/^\d{6}$/.test(normalized)) {
      recordInvalidUserCodeAttempt(hashValue('agent-user-code', normalized));
    }
    throw makeError('invalid_claim', 400, 'invalid_grant');
  }

  registration.status = 'claiming';
  retireActiveUserCodeHash(registration);
  registration.claimStartedAt = Date.now();

  return {
    registrationId: registration.registrationId,
    state: signAgentState(registration.registrationId),
  };
}

function consumeIntervalsClaimState(stateValue) {
  assertAgentAuthConfigured();
  cleanupAgentAuthState();

  const payload = readSignedAgentState(stateValue);
  if (!payload) return null;

  const stateHash = hashValue('agent-state-token', stateValue);
  const stored = agentStatesByHash.get(stateHash);
  if (!stored) return null;
  agentStatesByHash.delete(stateHash);

  if (stored.registrationId !== payload.registration_id) return null;

  const registration = registrationsById.get(payload.registration_id);
  if (!isClaimUsable(registration)) return null;

  return registration;
}

function completeAgentRegistration(registrationId, { userId, intervalsAccessToken }) {
  assertAgentAuthConfigured();
  const registration = registrationsById.get(trimToString(registrationId));
  const resolvedUserId = trimToString(userId);
  const rawIntervalsToken = trimToString(intervalsAccessToken);

  if (!isClaimUsable(registration)) {
    throw makeError('invalid_grant', 400, 'invalid_grant');
  }
  if (!resolvedUserId || !rawIntervalsToken) {
    throw makeError('invalid_agent_registration', 500, 'server_error');
  }

  registration.status = 'completed';
  registration.userId = resolvedUserId;
  registration.intervalsAccessToken = rawIntervalsToken;
  registration.completedAt = Date.now();
  removeAllUserCodeMappings(registration);

  return registration;
}

function issueAgentAccessToken(registration) {
  assertAgentAuthConfigured();
  if (!registration || registration.status !== 'completed' || !registration.userId || !registration.intervalsAccessToken) {
    throw makeError('invalid_grant', 400, 'invalid_grant');
  }

  const ttl = getAgentTokenTtlSeconds();
  const jti = `ajti_${randomBase64Url(18)}`;
  const payload = {
    registration_id: registration.registrationId,
    user_id: registration.userId,
    scope: AGENT_AUTH_SCOPE,
    authMode: 'agent',
  };
  const token = jwt.sign(payload, getAgentAuthSecret(), {
    algorithm: 'HS256',
    audience: AGENT_AUTH_AUDIENCE,
    expiresIn: ttl,
    issuer: AGENT_AUTH_ISSUER,
    jwtid: jti,
    subject: String(registration.userId),
  });

  agentSessionsByJti.set(jti, {
    jti,
    registrationId: registration.registrationId,
    userId: registration.userId,
    intervalsAccessToken: registration.intervalsAccessToken,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000,
    revoked: false,
  });
  registration.agentJtis.add(jti);
  registration.tokenIssuedAt = Date.now();

  return {
    access_token: `${AGENT_TOKEN_PREFIX}${token}`,
    token_type: 'Bearer',
    expires_in: ttl,
    scope: AGENT_AUTH_SCOPE,
  };
}

function pollAgentClaimToken(claimToken) {
  assertAgentAuthConfigured();
  const registration = findRegistrationByClaimToken(claimToken);
  if (!isClaimUsable(registration) || registration.tokenIssuedAt) {
    return { ok: false, status: 400, error: 'invalid_grant' };
  }

  if (registration.status !== 'completed') {
    const now = Date.now();
    const minWaitMs = Number(registration.pollIntervalSeconds || getPollIntervalSeconds()) * 1000;
    if (registration.lastPollAt && now - registration.lastPollAt < minWaitMs) {
      registration.lastPollAt = now;
      return {
        ok: false,
        status: 400,
        error: 'slow_down',
        interval: registration.pollIntervalSeconds,
      };
    }

    registration.lastPollAt = now;
    return {
      ok: false,
      status: 400,
      error: 'authorization_pending',
      interval: registration.pollIntervalSeconds,
    };
  }

  return {
    ok: true,
    body: issueAgentAccessToken(registration),
  };
}

function resolveAgentAccessToken(token) {
  const raw = trimToString(token);
  if (!raw.startsWith(AGENT_TOKEN_PREFIX)) {
    return { matched: false, auth: null };
  }

  if (!isAgentAuthConfigured()) {
    return { matched: true, auth: null, error: 'agent_auth_not_configured' };
  }

  let payload = null;
  try {
    payload = jwt.verify(raw.slice(AGENT_TOKEN_PREFIX.length), getAgentAuthSecret(), {
      algorithms: ['HS256'],
      audience: AGENT_AUTH_AUDIENCE,
      issuer: AGENT_AUTH_ISSUER,
    });
  } catch {
    return { matched: true, auth: null, error: 'invalid_agent_token' };
  }

  const jti = trimToString(payload?.jti);
  const registrationId = trimToString(payload?.registration_id);
  const userId = trimToString(payload?.user_id);
  const scope = trimToString(payload?.scope);
  if (!jti || !registrationId || !userId || scope !== AGENT_AUTH_SCOPE || payload?.authMode !== 'agent') {
    return { matched: true, auth: null, error: 'invalid_agent_token' };
  }

  if (revokedAgentJtis.has(jti)) {
    return { matched: true, auth: null, error: 'revoked_agent_token' };
  }

  const session = agentSessionsByJti.get(jti);
  if (!session || session.revoked || Number(session.expiresAt) <= Date.now()) {
    return { matched: true, auth: null, error: 'invalid_agent_session' };
  }

  const registration = registrationsById.get(registrationId);
  if (!registration || registration.status !== 'completed' || registration.userId !== userId) {
    return { matched: true, auth: null, error: 'invalid_agent_registration' };
  }

  return {
    matched: true,
    auth: {
      userId,
      authMode: 'agent',
      scope,
      registrationId,
      agentTokenId: jti,
      intervalsToken: session.intervalsAccessToken,
      source: 'gpt',
    },
  };
}

function revokeAgentAccessToken(token) {
  const raw = trimToString(token);
  if (!raw.startsWith(AGENT_TOKEN_PREFIX)) {
    return { matched: false, revoked: false };
  }

  const decoded = jwt.decode(raw.slice(AGENT_TOKEN_PREFIX.length)) || {};
  const jti = trimToString(decoded.jti);
  if (!jti) return { matched: true, revoked: false };

  revokedAgentJtis.add(jti);
  const session = agentSessionsByJti.get(jti);
  if (!session) return { matched: true, revoked: false };

  session.revoked = true;
  agentSessionsByJti.delete(jti);

  const registration = registrationsById.get(session.registrationId);
  if (registration) registration.status = 'revoked';

  return { matched: true, revoked: true };
}

function buildAgentAuthMetadata(origin) {
  const base = trimToString(origin).replace(/\/+$/, '');
  const identityEndpoint = `${base}/gw/agent/identity`;
  const claimEndpoint = `${base}/gw/agent/identity/claim`;
  return {
    skill: 'https://stas.run/auth.md',
    identity_endpoint: identityEndpoint,
    register_uri: identityEndpoint,
    claim_endpoint: claimEndpoint,
    claim_uri: claimEndpoint,
    token_endpoint: `${base}/gw/oauth/token`,
    revocation_endpoint: `${base}/gw/oauth/revoke`,
    identity_types_supported: ['anonymous'],
    credential_types_supported: ['bearer'],
    anonymous: {
      credential_types_supported: ['bearer'],
    },
    scopes_supported: [AGENT_AUTH_SCOPE],
  };
}

function resetAgentAuthStateForTests() {
  registrationsById.clear();
  claimHashToRegistrationId.clear();
  userCodeHashToRegistrationId.clear();
  agentStatesByHash.clear();
  agentSessionsByJti.clear();
  revokedAgentJtis.clear();
  registrationRateByIp.clear();
  claimAttemptRateByIp.clear();
}

function expireRegistrationByClaimTokenForTests(claimToken) {
  const registration = findRegistrationByClaimToken(claimToken);
  if (!registration) return false;
  registration.expiresAt = Date.now() - 1000;
  registration.status = 'expired';
  removeAllUserCodeMappings(registration);
  return true;
}

function getRegistrationSnapshotByClaimTokenForTests(claimToken) {
  const registration = findRegistrationByClaimToken(claimToken);
  if (!registration) return null;

  return {
    registrationId: registration.registrationId,
    status: registration.status,
    userCodeHash: registration.userCodeHash || null,
    hasPlaintextUserCode: Object.prototype.hasOwnProperty.call(registration, 'userCode'),
    invalidUserCodeAttempts: Number(registration.invalidUserCodeAttempts || 0),
    retiredUserCodeHashCount: (registration.retiredUserCodeHashes || new Set()).size,
  };
}

module.exports = {
  AGENT_AUTH_GRANT_TYPE,
  AGENT_AUTH_SCOPE,
  AGENT_INTERVALS_READ_SCOPE,
  AGENT_TOKEN_PREFIX,
  buildAgentAuthMetadata,
  completeAgentRegistration,
  consumeIntervalsClaimState,
  createAnonymousIdentity,
  createIntervalsClaimStateForUserCode,
  getClaimCeremony,
  isAgentAuthConfigured,
  pollAgentClaimToken,
  resolveAgentAccessToken,
  revokeAgentAccessToken,
  __testing: {
    expireRegistrationByClaimToken: expireRegistrationByClaimTokenForTests,
    getRegistrationSnapshotByClaimToken: getRegistrationSnapshotByClaimTokenForTests,
    reset: resetAgentAuthStateForTests,
  },
};
