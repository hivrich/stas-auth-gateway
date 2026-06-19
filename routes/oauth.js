const express = require('express');
const crypto = require('node:crypto');
const router  = express.Router();
const { resolveDirectIntervalsAuth } = require('../lib/request-auth');
const {
  getClaudeOauthClientId,
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

const INTERVALS_AUTH_URL = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN_URL = 'https://intervals.icu/api/oauth/token';
const DEFAULT_INTERVALS_CALLBACK_URL = 'https://intervals.stas.run/gw/oauth/callback';
const INTERVALS_SCOPE_RE = /\b(?:ACTIVITY|WELLNESS|CALENDAR|CHATS|LIBRARY|SETTINGS):(?:READ|WRITE)\b/;
const DEFAULT_INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const BRIDGE_PKCE_METHOD = 'S256';
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

function getClaudeClientId() {
  return getClaudeOauthClientId();
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

function readBridgePkce(codeChallenge, codeChallengeMethod) {
  const challenge = trimToString(codeChallenge);
  const method = trimToString(codeChallengeMethod) || (challenge ? BRIDGE_PKCE_METHOD : '');

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

router.post('/oauth/register', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map((value) => trimToString(value)).filter(Boolean)
    : [];

  if (redirectUris.length === 0 || !redirectUris.every(isAllowedClaudeRedirectUri)) {
    return res.status(400).json({
      error: 'invalid_client_metadata',
      error_description: 'redirect_uris must contain only Claude MCP callback URLs',
    });
  }

  const response = {
    client_id: getClaudeClientId(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: 'Claude',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };

  logOauth('log', '[oauth][register]', {
    redirectUris,
    redirectUriCount: redirectUris.length,
    clientId: response.client_id,
  });
  return res.status(201).json(response);
});

router.get('/oauth/authorize', (req, res, next) => {
  try {
    const q = req.query || {};
    const redirect_uri = trimToString(q.redirect_uri);
    const state = trimToString(q.state);
    const requestedClientId = trimToString(q.client_id);
    const scope = trimToString(q.scope);
    const codeChallenge = trimToString(q.code_challenge);
    const codeChallengeMethod = trimToString(q.code_challenge_method);
    const source = resolveOauthSource({ clientId: requestedClientId, redirectUri: redirect_uri });
    const uid = q.uid || q.user_id || '';

    if (isIntervalsScope(scope) || source === 'claude') {
      if (!source) {
        return res.status(400).json({ error: 'invalid_request' });
      }

      const isAllowedExternalRedirect = source === 'claude'
        ? isAllowedClaudeRedirectUri(redirect_uri)
        : isAllowedChatGptRedirectUri(redirect_uri);
      const useServerClientForChatGpt = source === 'gpt' && !requestedClientId && isAllowedChatGptRedirectUri(redirect_uri);
      const effectiveClientId = source === 'claude' || useServerClientForChatGpt
        ? getClaudeIntervalsAuthConfig().clientId
        : requestedClientId;

      if (!redirect_uri || !effectiveClientId || !isAllowedExternalRedirect) {
        return res.status(400).json({ error: 'invalid_request' });
      }

      const pkce = readBridgePkce(codeChallenge, codeChallengeMethod);
      if (!pkce) {
        return res.status(400).json({ error: 'invalid_request' });
      }

      const effectiveScope = isIntervalsScope(scope) ? scope : DEFAULT_INTERVALS_SCOPE;
      const intervalsRedirectUri = getIntervalsCallbackUrl();
      const bridgeState = createBridgeState({
        source,
        redirectUri: redirect_uri,
        originalState: state,
        effectiveClientId,
        scope: effectiveScope,
        intervalsRedirectUri,
        codeChallenge: pkce.codeChallenge,
        codeChallengeMethod: pkce.codeChallengeMethod,
      });
      const url = new URL(INTERVALS_AUTH_URL);
      url.searchParams.set('client_id', effectiveClientId);
      url.searchParams.set('redirect_uri', intervalsRedirectUri);
      url.searchParams.set('response_type', trimToString(q.response_type) || 'code');
      if (effectiveScope) url.searchParams.set('scope', effectiveScope);
      url.searchParams.set('state', bridgeState);
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);

      logOauth('log', '[oauth][authorize]', {
        source,
        redirectUri: redirect_uri,
        intervalsRedirectUri,
        requestedClientId: requestedClientId || null,
        effectiveClientId,
        usedServerClientFallback: useServerClientForChatGpt,
        hasCodeChallenge: true,
        codeChallengeMethod: pkce.codeChallengeMethod,
      });

      return res.redirect(302, url.toString());
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

router.get('/oauth/callback', (req, res) => {
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
  if (source !== 'claude' && source !== 'gpt') {
    return res.status(400).json({ error: 'invalid_state' });
  }
  const redirectUri = trimToString(stateRecord.redirectUri);
  const isAllowedExternalRedirect = source === 'claude'
    ? isAllowedClaudeRedirectUri(redirectUri)
    : isAllowedChatGptRedirectUri(redirectUri);

  if (!isAllowedExternalRedirect) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  const upstreamError = trimToString(q.error);
  if (upstreamError) {
    return res.redirect(302, appendParams(redirectUri, {
      error: upstreamError,
      error_description: trimToString(q.error_description),
      state: trimToString(stateRecord.originalState),
    }));
  }

  const upstreamCode = trimToString(q.code);
  if (!upstreamCode) {
    return res.redirect(302, appendParams(redirectUri, {
      error: 'invalid_request',
      state: trimToString(stateRecord.originalState),
    }));
  }

  const bridgeCode = createBridgeCode({
    upstreamCode,
    source,
    redirectUri,
    originalState: trimToString(stateRecord.originalState),
    effectiveClientId: trimToString(stateRecord.effectiveClientId),
    intervalsRedirectUri: trimToString(stateRecord.intervalsRedirectUri) || getIntervalsCallbackUrl(),
    codeChallenge: trimToString(stateRecord.codeChallenge),
    codeChallengeMethod: trimToString(stateRecord.codeChallengeMethod),
  });

  logOauth('log', '[oauth][callback]', {
    source,
    redirectUri,
    effectiveClientId: stateRecord.effectiveClientId || null,
  });

  return res.redirect(302, appendParams(redirectUri, {
    code: bridgeCode,
    state: trimToString(stateRecord.originalState),
  }));
});

router.post('/oauth/revoke', (req, res) => {
  if (!isAgentAuthConfigured()) {
    return res.status(503).json({ error: 'service_unavailable', reason: 'agent_auth_not_configured' });
  }

  const token = trimToString(req.body?.token || req.body?.access_token);
  if (token) revokeAgentAccessToken(token);
  return res.json({ ok: true });
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

      if (!bridgeRecord && redirectUri) {
        const isAllowedExternalRedirect = source === 'claude'
          ? isAllowedClaudeRedirectUri(redirectUri)
          : isAllowedChatGptRedirectUri(redirectUri);
        if (!isAllowedExternalRedirect) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'invalid redirect_uri' });
        }
      }

      const useServerClientForChatGpt = source === 'gpt' && isAllowedChatGptRedirectUri(redirectUri) && (!requestedClientId || !requestedClientSecret);
      const clientConfig = source === 'claude' || useServerClientForChatGpt
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

      if (response.access_token) {
        try {
          await resolveDirectIntervalsAuth(response.access_token, { source });
        } catch (error) {
          logOauth('error', '[oauth][token][user_sync_failed]', {
            status: error?.status || 502,
            error: error?.code || error?.message || 'user_sync_failed',
          });
          return res.status(error?.status || 502).json({ error: 'user_sync_failed' });
        }
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
