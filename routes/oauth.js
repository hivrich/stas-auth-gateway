const express = require('express');
const crypto = require('node:crypto');
const router  = express.Router();
const { forgetDirectIntervalsToken, resolveDirectIntervalsAuth } = require('../lib/request-auth');
const { handleAgentCallback } = require('./agent');
const {
  isAllowedChatGptRedirectUri,
  isAllowedClaudeRedirectUri,
  resolveOauthSource,
} = require('../lib/request-source');
const {
  AGENT_AUTH_GRANT_TYPE,
  isAgentAuthConfigured,
  pollAgentClaimToken,
  revokeAgentAccessToken,
} = require('../lib/agent-auth');
const {
  clientDiagnostic,
  loadCimdClientMetadata,
  parseCimdClientId,
  readClientMetadata,
  redirectUriMatches,
  summarizeClientMetadataInput,
} = require('../lib/mcp-client-registration');
const {
  getIssuer,
  getMcpResource,
  issueMcpTokens,
  refreshMcpTokens,
  revokeMcpToken,
} = require('../lib/mcp-oauth-tokens');
const { normalizeMcpScopes } = require('../lib/mcp-oauth-scopes');

const INTERVALS_AUTH_URL = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN_URL = 'https://intervals.icu/api/oauth/token';
const DEFAULT_INTERVALS_CALLBACK_URL = 'https://intervals.stas.run/gw/oauth/callback';
const INTERVALS_SCOPE_RE = /\b(?:ACTIVITY|WELLNESS|CALENDAR|CHATS|LIBRARY|SETTINGS):(?:READ|WRITE)\b/;
const DEFAULT_INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const BRIDGE_PKCE_METHOD = 'S256';
const MCP_CLIENT_ID_PREFIX = 'stas_mcp_';
const MCP_CLIENT_ID_VERSION = 1;
const MCP_CLIENT_ID_MAX_LENGTH = 4096;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const OAUTH_STATE_DEV_SECRET = 'stas-oauth-state-dev-secret';
const PLACEHOLDER_OAUTH_STATE_SECRETS = new Set([
  'changeme',
  'change-me',
  'change_me',
  'dev',
  'development',
  'placeholder',
  'replace-me',
  'replace_me',
  'secret',
  'stas-oauth-state-dev-secret',
  'test',
]);
const PLACEHOLDER_OAUTH_STATE_SECRET_MARKERS = [
  'change-me',
  'changeme',
  'generate-with',
  'openssl',
  'placeholder',
  'replace-me',
  'todo',
  'your-',
];

// Local one-process stores only. Multi-instance deploys need Redis/DB-backed state.
const pendingBridgeStates = new Map();
const pendingBridgeCodes = new Map();
const consumedMcpConsentTokens = new Map();

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function hashPrefix(value) {
  const raw = trimToString(value);
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

function normalizedLogKey(key) {
  return trimToString(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function isSensitiveLogKey(key) {
  const normalized = normalizedLogKey(key);
  if (normalized.startsWith('has_')) return false;

  if (normalized === 'client_id' || normalized.endsWith('_client_id')) return true;

  return new Set([
    'access_token',
    'authorization_code',
    'client_secret',
    'code',
    'code_verifier',
    'claim_token',
    'legacy_token',
    'refresh_token',
    'state',
    'token',
  ]).has(normalized)
    || normalized.endsWith('_secret')
    || normalized.endsWith('_token')
    || normalized.endsWith('_verifier');
}

function isRedirectUriLogKey(key) {
  const normalized = normalizedLogKey(key);
  return normalized === 'redirect_uri'
    || normalized === 'redirect_uris'
    || normalized.endsWith('_redirect_uri')
    || normalized.endsWith('_redirect_uris');
}

function summarizeRedirectUri(uri) {
  const raw = trimToString(uri);
  if (!raw) return null;

  try {
    const url = new URL(raw);
    return {
      origin: url.origin,
      pathHash: hashPrefix(url.pathname),
      hasQuery: Boolean(url.search),
      hasHash: Boolean(url.hash),
    };
  } catch {
    return {
      invalid: true,
      valueHash: hashPrefix(raw),
    };
  }
}

function sanitizeLogValue(key, value) {
  if (isSensitiveLogKey(key)) {
    return value ? { redacted: true, hash: hashPrefix(value) } : null;
  }

  if (isRedirectUriLogKey(key)) {
    if (Array.isArray(value)) return value.map((item) => summarizeRedirectUri(item));
    return summarizeRedirectUri(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => (
      item && typeof item === 'object' ? sanitizeLogFields(item) : item
    ));
  }

  if (value && typeof value === 'object') {
    return sanitizeLogFields(value);
  }

  return value;
}

function sanitizeLogFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) {
    out[key] = sanitizeLogValue(key, value);
  }
  return out;
}

function logOauth(level, event, fields) {
  try {
    const method = console[level] || console.log;
    method.call(console, event, JSON.stringify(sanitizeLogFields(fields)));
  } catch {}
}

function summarizeUpstreamOAuthError(payload, text) {
  const error = payload && typeof payload === 'object' && typeof payload.error === 'string'
    ? payload.error
    : null;
  return {
    error,
    bodyHash: hashPrefix(text),
  };
}

function envFlagEnabled(...names) {
  return names.some((name) => /^(1|true|yes|on)$/i.test(trimToString(process.env[name])));
}

function isLegacyStasIdOauthEnabled() {
  return envFlagEnabled('ENABLE_LEGACY_STAS_ID_OAUTH', 'LEGACY_STAS_ID_OAUTH_ENABLED');
}

function isLegacyStasIdTokenExchangeEnabled() {
  return envFlagEnabled('ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE', 'LEGACY_STAS_ID_TOKEN_EXCHANGE_ENABLED');
}

function isIntervalsScope(scope) {
  return INTERVALS_SCOPE_RE.test(trimToString(scope));
}

function getBasicAuthCredentials(req) {
  const raw = trimToString(req.get('authorization') || req.headers.authorization);
  if (!/^Basic\s+/i.test(raw)) return { clientId: '', clientSecret: '' };

  try {
    const decoded = Buffer.from(raw.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return { clientId: '', clientSecret: '' };
    return {
      clientId: decoded.slice(0, idx),
      clientSecret: decoded.slice(idx + 1),
    };
  } catch {
    return { clientId: '', clientSecret: '' };
  }
}

function getServerIntervalsClientId() {
  return trimToString(process.env.INTERVALS_CLIENT_ID);
}

function getServerIntervalsClientSecret() {
  return trimToString(process.env.INTERVALS_CLIENT_SECRET);
}

function getIntervalsCallbackUrl() {
  return trimToString(
    process.env.INTERVALS_OAUTH_CALLBACK_URL ||
    process.env.INTERVALS_REDIRECT_URI ||
    process.env.OAUTH_CALLBACK_URL,
  ) || DEFAULT_INTERVALS_CALLBACK_URL;
}

function getClaudeIntervalsAuthConfig() {
  const clientId = getServerIntervalsClientId();
  const clientSecret = getServerIntervalsClientSecret();

  if (!clientId || !clientSecret) {
    const error = new Error('claude_intervals_oauth_not_configured');
    error.status = 500;
    throw error;
  }

  return { clientId, clientSecret };
}

function isProductionRuntime() {
  return trimToString(process.env.NODE_ENV).toLowerCase() === 'production';
}

function isUsableProductionStateSecret(secret) {
  const raw = trimToString(secret);
  const normalized = raw.toLowerCase();
  return raw.length >= 32
    && !PLACEHOLDER_OAUTH_STATE_SECRETS.has(normalized)
    && !PLACEHOLDER_OAUTH_STATE_SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

function makeOauthConfigError(message) {
  const error = new Error(message);
  error.status = 500;
  return error;
}

function getOauthStateSecret() {
  const explicitSecret = trimToString(process.env.OAUTH_STATE_SECRET);
  if (explicitSecret) {
    if (isProductionRuntime() && !isUsableProductionStateSecret(explicitSecret)) {
      throw makeOauthConfigError('oauth_state_secret_not_configured');
    }
    return explicitSecret;
  }

  const clientSecretFallback = getServerIntervalsClientSecret();
  if (clientSecretFallback) {
    if (isProductionRuntime() && !isUsableProductionStateSecret(clientSecretFallback)) {
      throw makeOauthConfigError('oauth_state_secret_not_configured');
    }
    return clientSecretFallback;
  }

  if (isProductionRuntime()) {
    throw makeOauthConfigError('oauth_state_secret_not_configured');
  }

  return OAUTH_STATE_DEV_SECRET;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(value) {
  const secret = getOauthStateSecret();
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function signState(payload) {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(body)}`;
}

function readSignedState(value) {
  const raw = trimToString(value);
  const [body, signature] = raw.split('.');
  if (!body || !signature) return null;

  const expected = hmac(body);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.exp || Date.now() > Number(payload.exp)) return null;
    return payload;
  } catch {
    return null;
  }
}

function cleanupBridgeCodes() {
  const now = Date.now();
  for (const [code, record] of pendingBridgeCodes.entries()) {
    if (!record || Number(record.expiresAt) <= now) pendingBridgeCodes.delete(code);
  }
}

function cleanupBridgeStates() {
  const now = Date.now();
  for (const [stateId, record] of pendingBridgeStates.entries()) {
    if (!record || Number(record.expiresAt) <= now) pendingBridgeStates.delete(stateId);
  }
}

function cleanupConsumedMcpConsentTokens() {
  const now = Date.now();
  for (const [tokenId, expiresAt] of consumedMcpConsentTokens.entries()) {
    if (Number(expiresAt) <= now) consumedMcpConsentTokens.delete(tokenId);
  }
}

function createBridgeState(record) {
  cleanupBridgeStates();
  const stateId = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + OAUTH_STATE_TTL_MS;
  pendingBridgeStates.set(stateId, {
    ...record,
    expiresAt,
  });
  return signState({
    jti: stateId,
    exp: expiresAt,
  });
}

function takeBridgeState(state) {
  const payload = readSignedState(state);
  if (!payload) return null;

  const stateId = trimToString(payload.jti || payload.nonce);
  if (!stateId) return null;

  cleanupBridgeStates();
  const record = pendingBridgeStates.get(stateId);
  if (!record) return null;
  pendingBridgeStates.delete(stateId);
  if (Number(record.expiresAt) <= Date.now()) return null;
  return record;
}

function createBridgeCode(record) {
  cleanupBridgeCodes();
  const code = `gpt_${crypto.randomBytes(24).toString('base64url')}`;
  pendingBridgeCodes.set(code, {
    ...record,
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS,
  });
  return code;
}

function takeBridgeCode(code) {
  cleanupBridgeCodes();
  const record = pendingBridgeCodes.get(code);
  if (!record) return null;
  pendingBridgeCodes.delete(code);
  if (Number(record.expiresAt) <= Date.now()) return null;
  return record;
}

function readBridgePkce(codeChallenge, codeChallengeMethod, options = {}) {
  const challenge = trimToString(codeChallenge);
  const method = trimToString(codeChallengeMethod) || (challenge ? BRIDGE_PKCE_METHOD : '');

  if (!challenge && !method && options.allowMissing === true) {
    return {
      codeChallenge: '',
      codeChallengeMethod: '',
    };
  }

  if (!challenge || method !== BRIDGE_PKCE_METHOD || !PKCE_CHALLENGE_RE.test(challenge)) {
    return null;
  }

  return {
    codeChallenge: challenge,
    codeChallengeMethod: BRIDGE_PKCE_METHOD,
  };
}

function s256ChallengeForVerifier(codeVerifier) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyBridgePkce(bridgeRecord, codeVerifier) {
  if (
    bridgeRecord &&
    bridgeRecord.source === 'gpt' &&
    !bridgeRecord.codeChallenge &&
    !bridgeRecord.codeChallengeMethod
  ) {
    return { ok: true };
  }

  if (!bridgeRecord || bridgeRecord.codeChallengeMethod !== BRIDGE_PKCE_METHOD || !bridgeRecord.codeChallenge) {
    return { ok: false, error: 'invalid_grant' };
  }

  const verifier = trimToString(codeVerifier);
  if (!verifier) return { ok: false, error: 'invalid_request' };
  if (!PKCE_VERIFIER_RE.test(verifier)) return { ok: false, error: 'invalid_grant' };

  const expected = s256ChallengeForVerifier(verifier);
  if (!timingSafeStringEqual(expected, bridgeRecord.codeChallenge)) {
    return { ok: false, error: 'invalid_grant' };
  }

  return { ok: true };
}

function appendParams(uri, params) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createRegisteredMcpClient(metadata) {
  const body = base64url(JSON.stringify({
    v: MCP_CLIENT_ID_VERSION,
    type: 'mcp_client',
    redirectUris: metadata.redirectUris,
    clientName: metadata.clientName,
    grantTypes: metadata.grantTypes,
    applicationType: metadata.applicationType,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(16).toString('base64url'),
  }));
  const signature = hmac(`mcp-client:${body}`);
  const clientId = `${MCP_CLIENT_ID_PREFIX}${body}.${signature}`;
  return clientId.length <= MCP_CLIENT_ID_MAX_LENGTH ? clientId : null;
}

function readRegisteredMcpClient(clientId) {
  const raw = trimToString(clientId);
  if (!raw.startsWith(MCP_CLIENT_ID_PREFIX) || raw.length > MCP_CLIENT_ID_MAX_LENGTH) return null;

  const signed = raw.slice(MCP_CLIENT_ID_PREFIX.length);
  const splitAt = signed.lastIndexOf('.');
  if (splitAt <= 0) return null;
  const body = signed.slice(0, splitAt);
  const signature = signed.slice(splitAt + 1);
  const expected = hmac(`mcp-client:${body}`);
  if (!timingSafeStringEqual(expected, signature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload?.v !== MCP_CLIENT_ID_VERSION || payload?.type !== 'mcp_client') return null;
    const result = readClientMetadata({
      redirect_uris: payload.redirectUris,
      client_name: payload.clientName,
      grant_types: payload.grantTypes || ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: payload.applicationType,
    });
    if (!result.ok) return null;
    return {
      ...result.metadata,
      clientId: raw,
      registrationMode: 'dcr',
    };
  } catch {
    return null;
  }
}

async function resolveMcpClient(clientId) {
  const signed = readRegisteredMcpClient(clientId);
  if (signed) return { client: signed, error: null };
  if (!parseCimdClientId(clientId)) return { client: null, error: null };
  const result = await loadCimdClientMetadata(clientId);
  if (!result.ok) return { client: null, error: result };
  return {
    client: {
      clientId: trimToString(clientId),
      ...result.metadata,
      registrationMode: 'cimd',
    },
    error: null,
  };
}

function isAllowedExternalRedirect(source, redirectUri, downstreamClientId = '', registeredClient = null) {
  if (source === 'claude') return isAllowedClaudeRedirectUri(redirectUri);
  if (source === 'gpt') return isAllowedChatGptRedirectUri(redirectUri);
  if (source === 'mcp') {
    const client = registeredClient || readRegisteredMcpClient(downstreamClientId);
    return Boolean(client && client.redirectUris.some((registered) => (
      redirectUriMatches(registered, redirectUri, client.applicationType)
    )));
  }
  return false;
}

function createMcpConsentToken(params) {
  const issuedAt = Date.now();
  return signState({
    v: 1,
    type: 'mcp_consent',
    jti: crypto.randomBytes(24).toString('base64url'),
    iat: issuedAt,
    exp: issuedAt + OAUTH_STATE_TTL_MS,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    originalState: params.originalState,
    scope: params.scope,
    responseType: params.responseType,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: params.codeChallengeMethod,
    resource: params.resource,
    client: params.client,
  });
}

function takeMcpConsentToken(value) {
  const consent = readSignedState(value);
  if (!consent || consent.v !== 1 || consent.type !== 'mcp_consent' || !trimToString(consent.jti)) {
    return { consent: null, reason: 'invalid_or_expired' };
  }

  cleanupConsumedMcpConsentTokens();
  const tokenId = trimToString(consent.jti);
  if (consumedMcpConsentTokens.has(tokenId)) {
    return { consent: null, reason: 'replayed' };
  }
  consumedMcpConsentTokens.set(tokenId, Number(consent.exp));
  return { consent, reason: null };
}

const MCP_SCOPE_LABELS = {
  ACTIVITY: 'Activities and workouts',
  WELLNESS: 'Wellness data',
  CALENDAR: 'Calendar and training plan',
  CHATS: 'STAS conversations',
  LIBRARY: 'Training library',
  SETTINGS: 'Account settings',
};

function renderMcpScopeList(scope) {
  const scopes = normalizeMcpScopes(scope, { useDefault: false }) || [];
  const accessByCategory = new Map();
  for (const item of scopes) {
    const [category, access] = item.split(':');
    if (!MCP_SCOPE_LABELS[category]) continue;
    const current = accessByCategory.get(category);
    if (access === 'WRITE' || !current) accessByCategory.set(category, access);
  }

  return [...accessByCategory.entries()].map(([category, access]) => `
    <li class="permission">
      <span class="check" aria-hidden="true">&#10003;</span>
      <span><strong>${escapeHtml(MCP_SCOPE_LABELS[category])}</strong><small>${access === 'WRITE' ? 'View and update' : 'View only'}</small></span>
    </li>`).join('');
}

const MCP_CONSENT_PAGE_CSS = `
  :root { color-scheme: only light; }
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body { margin: 0; padding: 4px; background: #fff; color: #000; font: 400 18px/1.34 "Suisse Intl", "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .page { min-height: calc(100vh - 8px); min-height: calc(100dvh - 8px); display: flex; align-items: center; justify-content: center; padding: clamp(16px, 5vw, 52px); border-radius: 20px; background: #f0f1f1; }
  .shell { width: 100%; max-width: 680px; }
  .brand { display: inline-flex; align-items: center; gap: 9px; margin: 0 0 16px 4px; color: #002726; font-size: 18px; font-weight: 600; letter-spacing: .01em; }
  .brand-dot { width: 14px; height: 14px; border-radius: 999px; background: #78fff0; }
  .card { border-radius: 20px; background: #fff; padding: clamp(24px, 5vw, 40px); }
  .eyebrow { margin: 0 0 12px; color: #7a838a; font-size: 12px; line-height: 1.28; text-transform: uppercase; letter-spacing: .08em; }
  h1 { max-width: 560px; margin: 0; font-size: clamp(30px, 5vw, 38px); line-height: 1.08; font-weight: 400; letter-spacing: -.025em; }
  .lead { max-width: 580px; margin: 16px 0 0; color: #4b555d; font-size: 18px; line-height: 1.42; }
  .client { margin-top: 24px; padding: 16px; border-radius: 16px; background: #f7f8f8; }
  .client-label, .section-label { display: block; margin: 0 0 8px; color: #7a838a; font-size: 12px; line-height: 1.28; }
  .client strong, .client span { display: block; overflow-wrap: anywhere; }
  .client strong { font-size: 18px; line-height: 1.28; font-weight: 500; }
  .client span { margin-top: 4px; color: #4b555d; font-size: 15px; line-height: 1.32; }
  .permissions-wrap { margin-top: 24px; }
  .permissions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
  .permission { min-width: 0; display: flex; align-items: flex-start; gap: 10px; padding: 14px; border-radius: 14px; background: #f7f8f8; }
  .permission .check { width: 24px; height: 24px; flex: 0 0 24px; display: grid; place-items: center; border-radius: 8px; background: #d8fbf7; color: #002726; font-size: 15px; line-height: 1; }
  .permission strong, .permission small { display: block; }
  .permission strong { font-size: 15px; line-height: 1.32; font-weight: 500; }
  .permission small { margin-top: 3px; color: #7a838a; font-size: 12px; line-height: 1.28; }
  .notice { margin: 24px 0 0; padding: 14px 16px; border-radius: 14px; background: #fff1cc; color: #6b4700; font-size: 15px; line-height: 1.36; }
  .actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; margin-top: 24px; }
  button, .button-link { min-height: 52px; width: 100%; display: inline-flex; align-items: center; justify-content: center; border-radius: 14px; padding: 0 18px; font-family: inherit; font-size: 18px; font-weight: 400; line-height: 1; text-align: center; text-decoration: none; cursor: pointer; touch-action: manipulation; }
  button { border: 1px solid transparent; background: #78fff0; color: #000; }
  .button-link { border: 1px solid #4b555d; background: transparent; color: #000; }
  @media (hover: hover) {
    button:hover, .button-link:hover { border-radius: 999px; }
    .button-link:hover { background: #f7f8f8; }
  }
  button:active, .button-link:active { transform: translateY(1px); }
  button:focus-visible, .button-link:focus-visible, .help-link:focus-visible { outline: 3px solid #002726; outline-offset: 3px; }
  .footnote { margin: 16px 0 0; color: #7a838a; font-size: 12px; line-height: 1.4; text-align: center; }
  .help-link { color: #000; text-underline-offset: 4px; }
  @media (max-width: 560px) {
    .page { align-items: flex-start; padding: 20px 12px; }
    .brand { margin-top: 4px; }
    .card { padding: 24px 20px; }
    .permissions, .actions { grid-template-columns: 1fr; }
    .actions form { order: 0; }
    .button-link { order: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    button:active, .button-link:active { transform: none; }
  }
`;

function setMcpConsentPageHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('content-type', 'text/html; charset=utf-8');
}

function renderMcpConsentPage(res, client, params) {
  const consentToken = createMcpConsentToken(params);
  const callbackHost = new URL(params.redirectUri).hostname;
  const clientName = trimToString(client.clientName) || 'MCP client';
  const cancelUri = appendParams(params.redirectUri, {
    error: 'access_denied',
    state: params.originalState,
  });
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Connect ${escapeHtml(clientName)} to STAS</title>
<style>${MCP_CONSENT_PAGE_CSS}</style>
</head>
<body>
<div class="page">
  <main class="shell" aria-labelledby="consent-title">
    <div class="brand" aria-label="STAS"><span class="brand-dot" aria-hidden="true"></span>STAS</div>
    <section class="card">
      <p class="eyebrow">Secure connection</p>
      <h1 id="consent-title">Connect ${escapeHtml(clientName)} to STAS?</h1>
      <p class="lead">This lets the client work with your STAS training data. You will review access with Intervals.icu next.</p>
      <div class="client">
        <span class="client-label">Connecting</span>
        <strong>${escapeHtml(clientName)}</strong>
        <span>${escapeHtml(callbackHost)}</span>
      </div>
      <div class="permissions-wrap">
        <span class="section-label">Requested access</span>
        <ul class="permissions">${renderMcpScopeList(params.scope)}</ul>
      </div>
      <p class="notice"><strong>Only continue if you started this connection</strong> in ${escapeHtml(clientName)}.</p>
      <div class="actions">
        <form method="post" action="/gw/oauth/authorize">
          <input type="hidden" name="mcp_consent_token" value="${escapeHtml(consentToken)}"/>
          <button type="submit">Continue to Intervals.icu</button>
        </form>
        <a class="button-link" href="${escapeHtml(cancelUri)}">Cancel connection</a>
      </div>
      <p class="footnote">STAS never shares your Intervals.icu password with the client.</p>
    </section>
  </main>
</div>
</body>
</html>`;

  setMcpConsentPageHeaders(res);
  return res.status(200).send(html);
}

function renderMcpConsentErrorPage(res) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Start the STAS connection again</title>
<style>${MCP_CONSENT_PAGE_CSS}</style>
</head>
<body>
<div class="page">
  <main class="shell" aria-labelledby="error-title">
    <div class="brand" aria-label="STAS"><span class="brand-dot" aria-hidden="true"></span>STAS</div>
    <section class="card">
      <p class="eyebrow">Connection expired</p>
      <h1 id="error-title">Start the connection again</h1>
      <p class="lead">This connection request is no longer valid. Close this page, return to your MCP client, and connect STAS again.</p>
      <p class="notice">No access was granted and no account changes were made.</p>
      <p class="footnote">Need help? <a class="help-link" href="https://stas.run">Visit stas.run</a></p>
    </section>
  </main>
</div>
</body>
</html>`;

  setMcpConsentPageHeaders(res);
  return res.status(400).send(html);
}

function beginBridgeAuthorization(res, params) {
  const {
    source,
    redirectUri,
    originalState,
    requestedClientId,
    downstreamClientId = '',
    scope,
    responseType,
    codeChallenge,
    codeChallengeMethod,
    resource,
    registeredClient,
  } = params;
  const useServerClientForChatGpt = source === 'gpt'
    && !requestedClientId
    && isAllowedChatGptRedirectUri(redirectUri);
  const useServerClient = source === 'claude' || source === 'mcp' || useServerClientForChatGpt;
  const effectiveClientId = useServerClient
    ? getClaudeIntervalsAuthConfig().clientId
    : requestedClientId;

  if (
    !redirectUri
    || !effectiveClientId
    || !isAllowedExternalRedirect(source, redirectUri, downstreamClientId || requestedClientId, registeredClient)
  ) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  const allowMissingPkce = source === 'gpt' && !codeChallenge && !codeChallengeMethod;
  const pkce = readBridgePkce(codeChallenge, codeChallengeMethod, { allowMissing: allowMissingPkce });
  if (!pkce) return res.status(400).json({ error: 'invalid_request' });

  const mcpScopes = source === 'mcp' ? normalizeMcpScopes(scope) : null;
  if (source === 'mcp' && !mcpScopes) return res.status(400).json({ error: 'invalid_scope' });
  const clientScope = mcpScopes ? mcpScopes.join(' ') : null;
  // Client scopes limit only the STAS token. The internal Intervals credential
  // must retain the stable product permissions used by background/calendar work.
  const effectiveScope = source === 'mcp'
    ? DEFAULT_INTERVALS_SCOPE
    : (isIntervalsScope(scope) ? scope : DEFAULT_INTERVALS_SCOPE);
  const intervalsRedirectUri = getIntervalsCallbackUrl();
  const bridgeState = createBridgeState({
    source,
    redirectUri,
    originalState,
    effectiveClientId,
    downstreamClientId: downstreamClientId || null,
    scope: clientScope || effectiveScope,
    intervalsRedirectUri,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: pkce.codeChallengeMethod,
    resource: source === 'mcp' ? resource : null,
    client: source === 'mcp' ? registeredClient : null,
  });
  const url = new URL(INTERVALS_AUTH_URL);
  url.searchParams.set('client_id', effectiveClientId);
  url.searchParams.set('redirect_uri', intervalsRedirectUri);
  url.searchParams.set('response_type', responseType || 'code');
  if (effectiveScope) url.searchParams.set('scope', effectiveScope);
  url.searchParams.set('state', bridgeState);
  if (pkce.codeChallenge) {
    url.searchParams.set('code_challenge', pkce.codeChallenge);
    url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
  }

  logOauth('log', '[oauth][authorize]', {
    source,
    redirectUri,
    intervalsRedirectUri,
    requestedClientId: requestedClientId || null,
    effectiveClientId,
    usedServerClientFallback: useServerClient,
    hasCodeChallenge: Boolean(pkce.codeChallenge),
    codeChallengeMethod: pkce.codeChallengeMethod || null,
  });

  return res.redirect(302, url.toString());
}

router.post('/oauth/register', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = readClientMetadata(body);

  if (!result.ok) {
    logOauth('warn', '[oauth][register][rejected]', summarizeClientMetadataInput(body, result));
    return res.status(400).json({
      error: result.error,
      error_description: result.reason,
    });
  }
  const metadata = result.metadata;
  const registeredClientId = createRegisteredMcpClient(metadata);
  if (!registeredClientId) {
    return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'client_metadata_too_large' });
  }

  const response = {
    client_id: registeredClientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: metadata.clientName,
    redirect_uris: metadata.redirectUris,
    grant_types: metadata.grantTypes,
    response_types: metadata.responseTypes,
    token_endpoint_auth_method: 'none',
    application_type: metadata.applicationType,
  };

  logOauth('log', '[oauth][register]', {
    clientNameHash: hashPrefix(metadata.clientName),
    redirectUris: metadata.redirectUris,
    redirectUriCount: metadata.redirectUris.length,
    clientId: response.client_id,
    applicationType: metadata.applicationType,
    grantTypes: metadata.grantTypes,
  });
  return res.status(201).json(response);
});

router.post('/oauth/authorize', (req, res) => {
  try {
    const result = takeMcpConsentToken(req.body?.mcp_consent_token);
    if (!result.consent) {
      logOauth('warn', '[oauth][consent][rejected]', { reason: result.reason });
      return renderMcpConsentErrorPage(res);
    }
    const consent = result.consent;

    const client = consent.client;
    const redirectUri = trimToString(consent.redirectUri);
    if (!client || !isAllowedExternalRedirect('mcp', redirectUri, client.clientId, client)) {
      return res.status(400).json({ error: 'invalid_client' });
    }

    return beginBridgeAuthorization(res, {
      source: 'mcp',
      redirectUri,
      originalState: trimToString(consent.originalState),
      requestedClientId: client.clientId,
      downstreamClientId: client.clientId,
      scope: trimToString(consent.scope),
      responseType: trimToString(consent.responseType) || 'code',
      codeChallenge: trimToString(consent.codeChallenge),
      codeChallengeMethod: trimToString(consent.codeChallengeMethod),
      resource: trimToString(consent.resource),
      registeredClient: client,
    });
  } catch (error) {
    if (error && error.status) {
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }
    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/oauth/authorize', async (req, res, next) => {
  try {
    const q = req.query || {};
    const redirect_uri = trimToString(q.redirect_uri);
    const state = trimToString(q.state);
    const requestedClientId = trimToString(q.client_id);
    const scope = trimToString(q.scope);
    const codeChallenge = trimToString(q.code_challenge);
    const codeChallengeMethod = trimToString(q.code_challenge_method);
    const resolvedMcpClient = await resolveMcpClient(requestedClientId);
    const registeredMcpClient = resolvedMcpClient.client;
    if (requestedClientId.startsWith(MCP_CLIENT_ID_PREFIX) && !registeredMcpClient) {
      return res.status(400).json({ error: 'invalid_client' });
    }
    if (resolvedMcpClient.error) {
      logOauth('warn', '[oauth][cimd][rejected]', {
        reason: resolvedMcpClient.error.reason,
        clientHost: parseCimdClientId(requestedClientId)?.hostname || null,
      });
      return res.status(400).json({ error: resolvedMcpClient.error.error || 'invalid_client' });
    }
    const source = registeredMcpClient
      ? 'mcp'
      : resolveOauthSource({ clientId: requestedClientId, redirectUri: redirect_uri });
    const uid = q.uid || q.user_id || '';

    if (source === 'mcp') {
      const resource = trimToString(q.resource);
      const mcpScopes = normalizeMcpScopes(scope);
      if (
        trimToString(q.response_type) !== 'code'
        || !isAllowedExternalRedirect('mcp', redirect_uri, requestedClientId, registeredMcpClient)
        || !readBridgePkce(codeChallenge, codeChallengeMethod)
        || resource !== getMcpResource()
        || !mcpScopes
      ) {
        return res.status(400).json({ error: mcpScopes ? 'invalid_request' : 'invalid_scope' });
      }

      return renderMcpConsentPage(res, registeredMcpClient, {
        clientId: registeredMcpClient.clientId,
        redirectUri: redirect_uri,
        originalState: state,
        scope: mcpScopes.join(' '),
        responseType: trimToString(q.response_type),
        codeChallenge,
        codeChallengeMethod,
        resource,
        client: registeredMcpClient,
      });
    }

    if (isIntervalsScope(scope) || source === 'claude') {
      if (!source) {
        return res.status(400).json({ error: 'invalid_request' });
      }

      return beginBridgeAuthorization(res, {
        source,
        redirectUri: redirect_uri,
        originalState: state,
        requestedClientId,
        scope,
        responseType: trimToString(q.response_type),
        codeChallenge,
        codeChallengeMethod,
      });
    }

    if (!/^[0-9]+$/.test(String(uid))) return next();

    if (!isLegacyStasIdOauthEnabled()) {
      return res.status(400).json({ error: 'legacy_stas_id_oauth_disabled' });
    }

    if (!isAllowedChatGptRedirectUri(redirect_uri)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }

    const payload = JSON.stringify({ uid: String(uid), ts: Date.now() });
    const code = 'c_' + Buffer.from(payload, 'utf8').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sep = redirect_uri.includes('?') ? '&' : '?';
    const url = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    logOauth('log', '[oauth][302]', {
      redirectUri: redirect_uri,
      hasCode: true,
      hasState: Boolean(state),
    });
    return res.redirect(302, url);
  } catch (error) {
    if (error && error.status) {
      logOauth('error', '[oauth][authorize][config_error]', {
        status: error.status,
        error: error.message || 'server_error',
      });
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }

    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/oauth/callback', async (req, res, next) => {
  if (await handleAgentCallback(req, res, next)) return;

  const q = req.query || {};
  let stateRecord = null;
  try {
    stateRecord = takeBridgeState(q.state);
  } catch (error) {
    if (error && error.status) {
      logOauth('error', '[oauth][callback][config_error]', {
        status: error.status,
        error: error.message || 'server_error',
      });
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }

    return res.status(500).json({ error: 'server_error' });
  }

  if (!stateRecord) {
    return res.status(400).json({ error: 'invalid_state' });
  }

  const source = stateRecord.source;
  if (source !== 'claude' && source !== 'gpt' && source !== 'mcp') {
    return res.status(400).json({ error: 'invalid_state' });
  }
  const redirectUri = trimToString(stateRecord.redirectUri);
  const downstreamClientId = trimToString(stateRecord.downstreamClientId);
  const registeredClient = stateRecord.client || null;

  if (!isAllowedExternalRedirect(source, redirectUri, downstreamClientId, registeredClient)) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  const upstreamError = trimToString(q.error);
  if (upstreamError) {
    return res.redirect(302, appendParams(redirectUri, {
      error: upstreamError,
      error_description: trimToString(q.error_description),
      state: trimToString(stateRecord.originalState),
      ...(source === 'mcp' ? { iss: getIssuer() } : {}),
    }));
  }

  const upstreamCode = trimToString(q.code);
  if (!upstreamCode) {
    return res.redirect(302, appendParams(redirectUri, {
      error: 'invalid_request',
      state: trimToString(stateRecord.originalState),
      ...(source === 'mcp' ? { iss: getIssuer() } : {}),
    }));
  }

  const bridgeCode = createBridgeCode({
    upstreamCode,
    source,
    redirectUri,
    downstreamClientId,
    originalState: trimToString(stateRecord.originalState),
    effectiveClientId: trimToString(stateRecord.effectiveClientId),
    intervalsRedirectUri: trimToString(stateRecord.intervalsRedirectUri) || getIntervalsCallbackUrl(),
    codeChallenge: trimToString(stateRecord.codeChallenge),
    codeChallengeMethod: trimToString(stateRecord.codeChallengeMethod),
    resource: trimToString(stateRecord.resource),
    client: registeredClient,
    scope: trimToString(stateRecord.scope),
  });

  logOauth('log', '[oauth][callback]', {
    source,
    redirectUri,
    effectiveClientId: stateRecord.effectiveClientId || null,
  });

  return res.redirect(302, appendParams(redirectUri, {
    code: bridgeCode,
    state: trimToString(stateRecord.originalState),
    iss: getIssuer(),
  }));
});

router.post('/oauth/revoke', async (req, res) => {
  const token = trimToString(req.body?.token || req.body?.access_token);
  if (!token) return res.status(200).end();

  const agentRevocation = revokeAgentAccessToken(token);
  if (agentRevocation.matched) return res.status(200).end();

  if (await revokeMcpToken(token)) return res.status(200).end();

  try {
    const upstream = await fetch('https://intervals.icu/api/v1/disconnect-app', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (upstream.ok || upstream.status === 401) {
      forgetDirectIntervalsToken(token);
      return res.status(200).end();
    }

    logOauth('error', '[oauth][revoke][intervals_error]', { status: upstream.status });
    return res.status(502).json({ error: 'temporarily_unavailable' });
  } catch {
    return res.status(503).json({ error: 'temporarily_unavailable' });
  }
});

router.post('/oauth/token', async (req, res) => {
  try {
    const b = Object.assign({}, req.body || {});
    const grantType = trimToString(b.grant_type);

    if (grantType === AGENT_AUTH_GRANT_TYPE) {
      if (!isAgentAuthConfigured()) {
        return res.status(503).json({ error: 'service_unavailable', reason: 'agent_auth_not_configured' });
      }

      const claimToken = trimToString(b.claim_token);
      if (!claimToken) return res.status(400).json({ error: 'invalid_request' });

      const result = pollAgentClaimToken(claimToken);
      if (!result.ok) {
        const body = { error: result.error };
        if (result.interval) body.interval = result.interval;
        return res.status(result.status || 400).json(body);
      }

      return res.json(result.body);
    }

    if (grantType === 'refresh_token') {
      const refreshToken = trimToString(b.refresh_token);
      const clientId = trimToString(b.client_id) || getBasicAuthCredentials(req).clientId;
      const resource = trimToString(b.resource);
      if (!refreshToken || !clientId || resource !== getMcpResource()) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      const refreshed = await refreshMcpTokens(refreshToken, { clientId, resource });
      if (!refreshed) return res.status(400).json({ error: 'invalid_grant' });
      logOauth('log', '[oauth][token][refreshed]', { clientId, resource });
      return res.json(refreshed.response);
    }

    const code = trimToString(b.code || b.authorization_code);
    if (!code) return res.status(400).json({ error: 'invalid_grant' });

    if (!code.startsWith('c_')) {
      const bridgeRecord = code.startsWith('gpt_') ? takeBridgeCode(code) : null;
      if (code.startsWith('gpt_') && !bridgeRecord) {
        return res.status(400).json({ error: 'invalid_grant' });
      }

      const basic = getBasicAuthCredentials(req);
      const requestedClientId = trimToString(b.client_id) || basic.clientId;
      const requestedClientSecret = trimToString(b.client_secret) || basic.clientSecret;
      const redirectUri = bridgeRecord ? bridgeRecord.redirectUri : trimToString(b.redirect_uri);
      const requestedRedirectUri = trimToString(b.redirect_uri);
      const codeVerifier = trimToString(b.code_verifier);
      const source = bridgeRecord ? bridgeRecord.source : resolveOauthSource({
        clientId: requestedClientId,
        redirectUri,
      });

      if (!source) {
        return res.status(400).json({ error: 'invalid_request' });
      }

      if (bridgeRecord && requestedRedirectUri && requestedRedirectUri !== bridgeRecord.redirectUri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      if (
        bridgeRecord
        && bridgeRecord.source === 'mcp'
        && requestedClientId !== bridgeRecord.downstreamClientId
      ) {
        return res.status(400).json({ error: 'invalid_client' });
      }

      if (
        bridgeRecord
        && bridgeRecord.source === 'mcp'
        && (trimToString(b.resource) !== bridgeRecord.resource || bridgeRecord.resource !== getMcpResource())
      ) {
        return res.status(400).json({ error: 'invalid_target' });
      }

      if (!bridgeRecord && redirectUri) {
        if (!isAllowedExternalRedirect(source, redirectUri, requestedClientId)) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'invalid redirect_uri' });
        }
      }

      const useServerClientForChatGpt = source === 'gpt' && isAllowedChatGptRedirectUri(redirectUri) && (!requestedClientId || !requestedClientSecret);
      const clientConfig = source === 'claude' || source === 'mcp' || useServerClientForChatGpt
        ? getClaudeIntervalsAuthConfig()
        : { clientId: requestedClientId, clientSecret: requestedClientSecret };
      const clientId = clientConfig.clientId;
      const clientSecret = clientConfig.clientSecret;

      if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'invalid_client' });
      }

      if (bridgeRecord && bridgeRecord.effectiveClientId && clientId !== bridgeRecord.effectiveClientId) {
        return res.status(400).json({ error: 'invalid_client' });
      }

      if (bridgeRecord) {
        const pkce = verifyBridgePkce(bridgeRecord, codeVerifier);
        if (!pkce.ok) {
          return res.status(400).json({ error: pkce.error });
        }
      }

      const form = new URLSearchParams();
      form.set('grant_type', trimToString(b.grant_type) || 'authorization_code');
      form.set('client_id', clientId);
      form.set('client_secret', clientSecret);
      form.set('code', bridgeRecord ? bridgeRecord.upstreamCode : code);

      const upstreamPayload = {
        source,
        redirectUri: redirectUri || null,
        intervalsRedirectUri: bridgeRecord ? bridgeRecord.intervalsRedirectUri : null,
        hasCodeVerifier: Boolean(codeVerifier),
        requestedClientId: requestedClientId || null,
        effectiveClientId: clientId,
        usedServerClientFallback: useServerClientForChatGpt,
      };

      if (bridgeRecord) {
        form.set('redirect_uri', bridgeRecord.intervalsRedirectUri);
        if (codeVerifier) form.set('code_verifier', codeVerifier);
      } else if (source !== 'claude') {
        if (redirectUri) form.set('redirect_uri', redirectUri);
        if (codeVerifier) form.set('code_verifier', codeVerifier);
      }

      logOauth('log', '[oauth][token][request]', upstreamPayload);

      const upstream = await fetch(INTERVALS_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });

      const text = await upstream.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }

      if (!upstream.ok) {
        logOauth('error', '[oauth][token][intervals_error]', {
          status: upstream.status,
          ...summarizeUpstreamOAuthError(payload, text),
        });
        if (payload && typeof payload === 'object') {
          return res.status(upstream.status).json(payload);
        }
        return res.status(upstream.status).json({ error: 'invalid_grant' });
      }

      const response = payload && typeof payload === 'object' ? payload : {};
      if (!response.token_type) response.token_type = 'Bearer';
      if (response.expires_in === undefined) response.expires_in = 315360000;

      let resolvedIntervalsAuth = null;
      if (response.access_token) {
        try {
          resolvedIntervalsAuth = await resolveDirectIntervalsAuth(response.access_token, {
            source,
          });
        } catch (error) {
          logOauth('error', '[oauth][token][user_sync_failed]', {
            status: error?.status || 502,
            error: error?.code || error?.message || 'user_sync_failed',
          });
          return res.status(error?.status || 502).json({ error: 'user_sync_failed' });
        }
      }

      if (source === 'mcp') {
        if (!resolvedIntervalsAuth?.userId || !resolvedIntervalsAuth?.athleteId || !bridgeRecord?.client) {
          return res.status(502).json({ error: 'user_sync_failed' });
        }
        const diagnostic = clientDiagnostic(bridgeRecord.client);
        const tokenResponse = await issueMcpTokens({
          subject: resolvedIntervalsAuth.userId,
          userId: resolvedIntervalsAuth.athleteId,
          clientId: bridgeRecord.downstreamClientId,
          resource: bridgeRecord.resource,
          scopes: bridgeRecord.scope,
          allowRefresh: bridgeRecord.client.grantTypes.includes('refresh_token'),
          ...diagnostic,
        });
        logOauth('log', '[oauth][token][issued]', {
          clientId: bridgeRecord.downstreamClientId,
          resource: bridgeRecord.resource,
          allowRefresh: bridgeRecord.client.grantTypes.includes('refresh_token'),
          clientNameHash: hashPrefix(diagnostic.clientName),
          clientHost: diagnostic.clientHost,
        });
        return res.json(tokenResponse);
      }

      return res.json(response);
    }

    if (!isLegacyStasIdTokenExchangeEnabled()) {
      return res.status(400).json({ error: 'legacy_token_exchange_disabled' });
    }

    return res.status(400).json({
      error: 'legacy_token_exchange_removed',
      error_description: 'Legacy c_ authorization codes can no longer be exchanged for unsigned t_ tokens.',
    });
  } catch (error) {
    if (error && error.status) {
      logOauth('error', '[oauth][token][config_error]', {
        status: error.status,
        error: error.message || 'server_error',
      });
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }

    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;

module.exports.__testing = {
  resetVolatileState() {
    pendingBridgeStates.clear();
    pendingBridgeCodes.clear();
    consumedMcpConsentTokens.clear();
  },
};
