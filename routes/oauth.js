const express = require('express');
const crypto = require('node:crypto');
const router  = express.Router();
const { resolveDirectIntervalsAuth } = require('../lib/request-auth');
const { resolveOauthSource } = require('../lib/request-source');

const INTERVALS_AUTH_URL = 'https://intervals.icu/oauth/authorize';
const INTERVALS_TOKEN_URL = 'https://intervals.icu/api/oauth/token';
const DEFAULT_INTERVALS_CALLBACK_URL = 'https://intervals.stas.run/gw/oauth/callback';
const INTERVALS_SCOPE_RE = /\b(?:ACTIVITY|WELLNESS|CALENDAR|CHATS|LIBRARY|SETTINGS):(?:READ|WRITE)\b/;
const DEFAULT_INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CODE_TTL_MS = 10 * 60 * 1000;
const CLAUDE_CALLBACK_PATHS = new Set(['/api/mcp/auth_callback']);
const CLAUDE_ALLOWED_HOSTS = new Set(['claude.ai', 'claude.com']);
const CHATGPT_ALLOWED_HOSTS = new Set(['chat.openai.com', 'chatgpt.com']);
const CHATGPT_CALLBACK_PATH_RE = /^\/aip\/g-[^/]+\/oauth\/callback$/;
const pendingBridgeCodes = new Map();

function trimToString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
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
  return trimToString(process.env.CLAUDE_OAUTH_CLIENT_ID) || 'claude-public-client';
}

function isAllowedClaudeRedirectUri(uri) {
  const raw = trimToString(uri);
  if (!raw) return false;

  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && CLAUDE_ALLOWED_HOSTS.has(url.hostname) && CLAUDE_CALLBACK_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

function isAllowedChatGptRedirectUri(uri) {
  const raw = trimToString(uri);
  if (!raw) return false;

  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && CHATGPT_ALLOWED_HOSTS.has(url.hostname) && CHATGPT_CALLBACK_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
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

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function hmac(value) {
  const secret = getServerIntervalsClientSecret() || process.env.OAUTH_STATE_SECRET || 'stas-oauth-state-dev-secret';
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function signState(payload) {
  const body = base64url(JSON.stringify({
    ...payload,
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  }));
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

  console.log('[oauth][register]', JSON.stringify({ redirectUris, clientId: response.client_id }));
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

      const effectiveScope = isIntervalsScope(scope) ? scope : DEFAULT_INTERVALS_SCOPE;
      const intervalsRedirectUri = getIntervalsCallbackUrl();
      const bridgeState = signState({
        source,
        redirectUri: redirect_uri,
        originalState: state,
        effectiveClientId,
        scope: effectiveScope,
        intervalsRedirectUri,
      });
      const url = new URL(INTERVALS_AUTH_URL);
      url.searchParams.set('client_id', effectiveClientId);
      url.searchParams.set('redirect_uri', intervalsRedirectUri);
      url.searchParams.set('response_type', trimToString(q.response_type) || 'code');
      if (effectiveScope) url.searchParams.set('scope', effectiveScope);
      url.searchParams.set('state', bridgeState);
      if (codeChallenge) url.searchParams.set('code_challenge', codeChallenge);
      if (codeChallengeMethod) url.searchParams.set('code_challenge_method', codeChallengeMethod);

      console.log('[oauth][authorize]', JSON.stringify({
        source,
        redirect_uri,
        intervalsRedirectUri,
        requestedClientId: requestedClientId || null,
        effectiveClientId,
        usedServerClientFallback: useServerClientForChatGpt,
        hasCodeChallenge: Boolean(codeChallenge),
        codeChallengeMethod: codeChallengeMethod || null,
      }));

      return res.redirect(302, url.toString());
    }

    if (!/^[0-9]+$/.test(String(uid))) return next();

    const payload = JSON.stringify({ uid: String(uid), ts: Date.now() });
    const code = 'c_' + Buffer.from(payload, 'utf8').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sep = redirect_uri.includes('?') ? '&' : '?';
    const url = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
    try { console.log('[oauth][302]', url); } catch {}
    return res.redirect(302, url);
  } catch (error) {
    if (error && error.status) {
      console.error('[oauth][authorize][config_error]', error.message || error);
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }

    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/oauth/callback', (req, res) => {
  const q = req.query || {};
  const stateRecord = readSignedState(q.state);
  if (!stateRecord) {
    return res.status(400).json({ error: 'invalid_state' });
  }

  const source = stateRecord.source === 'claude' ? 'claude' : 'gpt';
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
  });

  console.log('[oauth][callback]', JSON.stringify({
    source,
    redirectUri,
    effectiveClientId: stateRecord.effectiveClientId || null,
  }));

  return res.redirect(302, appendParams(redirectUri, {
    code: bridgeCode,
    state: trimToString(stateRecord.originalState),
  }));
});

router.post('/oauth/token', async (req, res) => {
  try {
    const b = Object.assign({}, req.body || {});
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

      if (bridgeRecord && requestedRedirectUri && requestedRedirectUri !== bridgeRecord.redirectUri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
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

      console.log('[oauth][token][request]', JSON.stringify(upstreamPayload));

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
        console.error('[oauth][token][intervals_error]', upstream.status, text);
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
          console.error('[oauth][token][user_sync_failed]', error?.status || 502, error?.message || error);
          return res.status(error?.status || 502).json({ error: 'user_sync_failed' });
        }
      }

      return res.json(response);
    }

    let uid = null;
    try {
      const json = Buffer.from(code.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const obj = JSON.parse(json);
      uid = obj && obj.uid ? String(obj.uid) : null;
    } catch {}
    if (!uid || !/^[0-9]+$/.test(uid)) return res.status(400).json({ error: 'invalid_uid' });

    const now = Math.floor(Date.now() / 1000);
    const acc = JSON.stringify({ uid, ts: now });
    const tok = 't_' + Buffer.from(acc, 'utf8').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return res.json({ access_token: tok, token_type: 'Bearer', expires_in: 2592000, scope: String(b.scope || '') });
  } catch (error) {
    if (error && error.status) {
      console.error('[oauth][token][config_error]', error.message || error);
      return res.status(error.status).json({ error: error.message || 'server_error' });
    }

    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
