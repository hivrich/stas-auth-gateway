const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const OLD_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  INTERVALS_CLIENT_ID: process.env.INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET: process.env.INTERVALS_CLIENT_SECRET,
  OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
  CLAUDE_OAUTH_CLIENT_ID: process.env.CLAUDE_OAUTH_CLIENT_ID,
  ENABLE_LEGACY_STAS_ID_OAUTH: process.env.ENABLE_LEGACY_STAS_ID_OAUTH,
  LEGACY_STAS_ID_OAUTH_ENABLED: process.env.LEGACY_STAS_ID_OAUTH_ENABLED,
  ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE: process.env.ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE,
  LEGACY_STAS_ID_TOKEN_EXCHANGE_ENABLED: process.env.LEGACY_STAS_ID_TOKEN_EXCHANGE_ENABLED,
  STAS_BASE: process.env.STAS_BASE,
  STAS_KEY: process.env.STAS_KEY,
};

process.env.NODE_ENV = 'test';
process.env.INTERVALS_CLIENT_ID = 'test-intervals-client';
process.env.INTERVALS_CLIENT_SECRET = 'test-intervals-secret';
delete process.env.OAUTH_STATE_SECRET;
process.env.CLAUDE_OAUTH_CLIENT_ID = 'claude-public-client';
process.env.STAS_BASE = 'http://stas.local.test';
process.env.STAS_KEY = 'test-stas-key';
delete process.env.ENABLE_LEGACY_STAS_ID_OAUTH;
delete process.env.LEGACY_STAS_ID_OAUTH_ENABLED;
delete process.env.ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE;
delete process.env.LEGACY_STAS_ID_TOKEN_EXCHANGE_ENABLED;

const oauthPage = require('../middleware/oauth_page');
const oauth = require('../routes/oauth');
const { buildOAuthAuthorizationServerMetadata } = require('../lib/oauth-metadata');
const {
  isAllowedChatGptRedirectUri,
  isAllowedClaudeRedirectUri,
  normalizeSource,
  resolveOauthSource,
} = require('../lib/request-source');

const INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const CHATGPT_CALLBACK = 'https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const INTERVALS_CALLBACK = 'https://intervals.stas.run/gw/oauth/callback';
const DEFAULT_PKCE_VERIFIER = 'test-pkce-verifier-012345678901234567890123';
const WRONG_PKCE_VERIFIER = 'wrong-pkce-verifier-012345678901234567890123';
const RAW_INTERVALS_TOKEN = 'raw-oauth-flow-intervals-token';
const LEAKED_UPSTREAM_ACCESS_TOKEN = 'access-secret-should-not-log';
const LEAKED_UPSTREAM_REFRESH_TOKEN = 'refresh-secret-should-not-log';
const originalFetch = global.fetch;
const upstreamHits = [];

function restoreEnv() {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeS256Challenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function buildAuthorizePath(params = {}) {
  const search = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId ?? '',
    redirect_uri: params.redirectUri ?? CHATGPT_CALLBACK,
    state: params.state ?? 'test-state',
    scope: params.scope ?? INTERVALS_SCOPE,
  });

  if (params.pkce !== false) {
    search.set('code_challenge', params.codeChallenge ?? makeS256Challenge(params.codeVerifier ?? DEFAULT_PKCE_VERIFIER));
    if (Object.prototype.hasOwnProperty.call(params, 'codeChallengeMethod')) {
      if (params.codeChallengeMethod !== null) search.set('code_challenge_method', params.codeChallengeMethod);
    } else {
      search.set('code_challenge_method', 'S256');
    }
  }

  return `/gw/oauth/authorize?${search.toString()}`;
}

function makeLegacyCode(uid) {
  return `c_${Buffer.from(JSON.stringify({ uid: String(uid), ts: Date.now() })).toString('base64url')}`;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/gw/oauth', oauthPage());
  app.use('/gw', oauth);
  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const fetchOptions = {
    method: options.method || 'GET',
    headers,
    redirect: 'manual',
  };

  if (Object.prototype.hasOwnProperty.call(options, 'json')) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    fetchOptions.body = JSON.stringify(options.json);
  } else if (Object.prototype.hasOwnProperty.call(options, 'body')) {
    fetchOptions.body = options.body;
  }

  const response = await fetch(`${baseUrl}${path}`, fetchOptions);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    location: response.headers.get('location') || '',
    body: await response.text(),
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null;
      },
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/oauth/token') {
    const form = new URLSearchParams(options.body.toString());
    upstreamHits.push({
      url: parsed.toString(),
      method: options.method || 'GET',
      body: form,
    });
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('client_id'), 'test-intervals-client');
    assert.equal(form.get('client_secret'), 'test-intervals-secret');
    assert.equal(form.get('redirect_uri'), INTERVALS_CALLBACK);
    assert.equal(form.get('code_verifier'), DEFAULT_PKCE_VERIFIER);
    assert.match(form.get('code'), /^intervals-code/);
    if (form.get('code') === 'intervals-code-secret-leak') {
      return jsonResponse({
        error: 'invalid_grant',
        error_description: `do not log ${DEFAULT_PKCE_VERIFIER} test-intervals-secret client-secret-should-not-log`,
        access_token: LEAKED_UPSTREAM_ACCESS_TOKEN,
        refresh_token: LEAKED_UPSTREAM_REFRESH_TOKEN,
      }, 400);
    }
    return jsonResponse({ access_token: RAW_INTERVALS_TOKEN, token_type: 'Bearer', expires_in: 3600 });
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    upstreamHits.push({
      url: parsed.toString(),
      method: options.method || 'GET',
      headers: options.headers || {},
    });
    assert.equal(options.headers.Authorization, `Bearer ${RAW_INTERVALS_TOKEN}`);
    return jsonResponse({ id: '15487', name: 'OAuth Runner' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    upstreamHits.push({
      url: parsed.toString(),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
    });
    const body = JSON.parse(options.body);
    assert.equal(options.headers['X-API-Key'], 'test-stas-key');
    assert.equal(body.intervalsAthleteId, '15487');
    assert.equal(body.intervalsAccessToken, RAW_INTERVALS_TOKEN);
    assert.equal(body.source, 'gpt');
    return jsonResponse({ ok: true, user_id: '15487' });
  }

  return originalFetch(url, options);
};

function tokenExchangeHitCount() {
  return upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/oauth/token').length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function captureConsole(fn) {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines = [];
  const capture = (...args) => {
    lines.push(args.map((arg) => (
      typeof arg === 'string' ? arg : JSON.stringify(arg)
    )).join(' '));
  };

  console.log = capture;
  console.error = capture;
  console.warn = capture;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  return lines.join('\n');
}

async function issueBridgeCode(baseUrl, options = {}) {
  const authorize = await request(baseUrl, buildAuthorizePath(options));
  assert.equal(authorize.status, 302);
  const authorizeLocation = new URL(authorize.location);
  const bridgeState = authorizeLocation.searchParams.get('state');
  assert.ok(bridgeState);

  const upstreamCode = options.upstreamCode || 'intervals-code';
  const callback = await request(
    baseUrl,
    `/gw/oauth/callback?code=${encodeURIComponent(upstreamCode)}&state=${encodeURIComponent(bridgeState)}`,
  );
  assert.equal(callback.status, 302);
  const callbackLocation = new URL(callback.location);
  assert.equal(`${callbackLocation.origin}${callbackLocation.pathname}`, options.redirectUri || CHATGPT_CALLBACK);
  assert.equal(callbackLocation.searchParams.get('state'), options.state ?? 'test-state');
  const bridgeCode = callbackLocation.searchParams.get('code');
  assert.match(bridgeCode, /^gpt_/);

  return {
    authorizeLocation,
    bridgeCode,
    bridgeState,
    callbackLocation,
  };
}

async function main() {
  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;
  const realDateNow = Date.now;

  try {
    const metadata = buildOAuthAuthorizationServerMetadata('https://intervals.stas.run');
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);

    assert.equal(normalizeSource('claude'), 'claude');
    assert.equal(normalizeSource('gpt'), 'gpt');
    assert.equal(normalizeSource('claude-preview', null), null);
    assert.equal(resolveOauthSource({ clientId: 'claude-public-client' }), 'claude');
    assert.equal(resolveOauthSource({ clientId: 'not-claude-public-client' }), null);
    assert.equal(resolveOauthSource({ redirectUri: CLAUDE_CALLBACK }), 'claude');
    assert.equal(resolveOauthSource({ redirectUri: CHATGPT_CALLBACK }), 'gpt');
    assert.equal(resolveOauthSource({ redirectUri: 'https://example.com/claude/oauth/callback' }), null);
    assert.equal(resolveOauthSource({ redirectUri: 'https://chat.openai.com.evil.example/aip/g-test/oauth/callback' }), null);
    assert.equal(isAllowedClaudeRedirectUri(CLAUDE_CALLBACK), true);
    assert.equal(isAllowedClaudeRedirectUri(`${CLAUDE_CALLBACK}?next=evil`), false);
    assert.equal(isAllowedChatGptRedirectUri(CHATGPT_CALLBACK), true);
    assert.equal(isAllowedChatGptRedirectUri(`${CHATGPT_CALLBACK}#frag`), false);

    const claudeRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: { redirect_uris: [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback'] },
    });
    assert.equal(claudeRegister.status, 201);
    const claudeRegisterBody = JSON.parse(claudeRegister.body);
    assert.equal(claudeRegisterBody.client_id, 'claude-public-client');

    const claudeRegisterLookalike = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: { redirect_uris: ['https://claude.ai.evil.example/api/mcp/auth_callback'] },
    });
    assert.equal(claudeRegisterLookalike.status, 400);
    assert.match(claudeRegisterLookalike.body, /invalid_client_metadata/);

    const claudeRegisterQueryTrick = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: { redirect_uris: [`${CLAUDE_CALLBACK}?next=evil`] },
    });
    assert.equal(claudeRegisterQueryTrick.status, 400);
    assert.match(claudeRegisterQueryTrick.body, /invalid_client_metadata/);

    const emptyClientId = await request(baseUrl, buildAuthorizePath({ clientId: '' }));
    assert.equal(emptyClientId.status, 302);
    assert.match(emptyClientId.location, /^https:\/\/intervals\.icu\/oauth\/authorize\?/);
    const emptyLocation = new URL(emptyClientId.location);
    assert.equal(emptyLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(emptyLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);
    assert.equal(emptyLocation.searchParams.get('code_challenge'), makeS256Challenge(DEFAULT_PKCE_VERIFIER));
    assert.equal(emptyLocation.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(emptyLocation.searchParams.get('state'), 'test-state');
    assert.doesNotMatch(emptyClientId.body, /ВВЕДИТЕ ВАШ STAS ID/);

    const chatGptCallback = await request(
      baseUrl,
      `/gw/oauth/callback?code=intervals-code&state=${encodeURIComponent(emptyLocation.searchParams.get('state'))}`,
    );
    assert.equal(chatGptCallback.status, 302);
    const chatGptCallbackLocation = new URL(chatGptCallback.location);
    assert.equal(`${chatGptCallbackLocation.origin}${chatGptCallbackLocation.pathname}`, CHATGPT_CALLBACK);
    assert.equal(chatGptCallbackLocation.searchParams.get('state'), 'test-state');
    assert.match(chatGptCallbackLocation.searchParams.get('code'), /^gpt_/);
    const bridgeCode = chatGptCallbackLocation.searchParams.get('code');

    const callbackReplay = await request(
      baseUrl,
      `/gw/oauth/callback?code=intervals-code-replay&state=${encodeURIComponent(emptyLocation.searchParams.get('state'))}`,
    );
    assert.equal(callbackReplay.status, 400);
    assert.match(callbackReplay.body, /invalid_state/);

    const validBridgeExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
      },
    });
    assert.equal(validBridgeExchange.status, 200);
    const validBridgeExchangeBody = JSON.parse(validBridgeExchange.body);
    assert.equal(validBridgeExchangeBody.access_token, RAW_INTERVALS_TOKEN);

    const bridgeCodeReplay = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
      },
    });
    assert.equal(bridgeCodeReplay.status, 400);
    assert.match(bridgeCodeReplay.body, /invalid_grant/);

    const missingVerifier = await issueBridgeCode(baseUrl, { upstreamCode: 'intervals-code-missing-verifier' });
    const beforeMissingVerifierHits = tokenExchangeHitCount();
    const missingVerifierExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: missingVerifier.bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
      },
    });
    assert.equal(missingVerifierExchange.status, 400);
    assert.match(missingVerifierExchange.body, /invalid_request/);
    assert.equal(tokenExchangeHitCount(), beforeMissingVerifierHits);

    const wrongVerifier = await issueBridgeCode(baseUrl, { upstreamCode: 'intervals-code-wrong-verifier' });
    const beforeWrongVerifierHits = tokenExchangeHitCount();
    const wrongVerifierExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: wrongVerifier.bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: WRONG_PKCE_VERIFIER,
      },
    });
    assert.equal(wrongVerifierExchange.status, 400);
    assert.match(wrongVerifierExchange.body, /invalid_grant/);
    assert.equal(tokenExchangeHitCount(), beforeWrongVerifierHits);

    const expiredBridge = await issueBridgeCode(baseUrl, { upstreamCode: 'intervals-code-expired' });
    Date.now = () => realDateNow() + (11 * 60 * 1000);
    const expiredExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: expiredBridge.bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
      },
    });
    Date.now = realDateNow;
    assert.equal(expiredExchange.status, 400);
    assert.match(expiredExchange.body, /invalid_grant/);

    const plainPkceAuthorize = await request(
      baseUrl,
      buildAuthorizePath({
        codeChallenge: makeS256Challenge(DEFAULT_PKCE_VERIFIER),
        codeChallengeMethod: 'plain',
      }),
    );
    assert.equal(plainPkceAuthorize.status, 400);
    assert.match(plainPkceAuthorize.body, /invalid_request/);

    const missingPkceAuthorize = await request(baseUrl, buildAuthorizePath({ pkce: false }));
    assert.equal(missingPkceAuthorize.status, 400);
    assert.match(missingPkceAuthorize.body, /invalid_request/);

    const savedNodeEnv = process.env.NODE_ENV;
    const savedOauthStateSecret = process.env.OAUTH_STATE_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'stas-oauth-state-dev-secret';

      const productionPlaceholderStateSecret = await request(baseUrl, buildAuthorizePath({ clientId: '' }));
      assert.equal(productionPlaceholderStateSecret.status, 500);
      assert.match(productionPlaceholderStateSecret.body, /oauth_state_secret_not_configured/);
      assert.equal(productionPlaceholderStateSecret.location, '');
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
      if (savedOauthStateSecret === undefined) delete process.env.OAUTH_STATE_SECRET;
      else process.env.OAUTH_STATE_SECRET = savedOauthStateSecret;
    }

    const explicitClientId = await request(baseUrl, buildAuthorizePath({ clientId: 'explicit-client' }));
    assert.equal(explicitClientId.status, 302);
    const explicitLocation = new URL(explicitClientId.location);
    assert.equal(explicitLocation.searchParams.get('client_id'), 'explicit-client');
    assert.equal(explicitLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);

    const chatgptComCallback = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: '',
        redirectUri: 'https://chatgpt.com/aip/g-test/oauth/callback',
      }),
    );
    assert.equal(chatgptComCallback.status, 302);
    const chatgptComLocation = new URL(chatgptComCallback.location);
    assert.equal(chatgptComLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(chatgptComLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);

    const claudeAuthorize = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: 'claude-public-client',
        redirectUri: CLAUDE_CALLBACK,
      }),
    );
    assert.equal(claudeAuthorize.status, 302);
    const claudeAuthorizeLocation = new URL(claudeAuthorize.location);
    assert.equal(claudeAuthorizeLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(claudeAuthorizeLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);

    const invalidRedirect = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: '',
        redirectUri: 'https://evil.example/oauth/callback',
      }),
    );
    assert.equal(invalidRedirect.status, 400);
    assert.match(invalidRedirect.body, /invalid_request/);

    const rejectedRedirects = [
      'https://chat.openai.com.evil.example/aip/g-test/oauth/callback',
      'https://chatgpt.com.evil.example/aip/g-test/oauth/callback',
      'https://chat.openai.com/aip/g-test/oauth/callback/extra',
      'https://chat.openai.com/aip/g-test/oauth/%63allback',
      'https://chat.openai.com/aip/g-test/oauth/callback?next=evil',
      'https://chat.openai.com/aip/g-test/oauth/callback#frag',
      'https://claude.ai.evil.example/api/mcp/auth_callback',
      `${CLAUDE_CALLBACK}?next=evil`,
    ];

    for (const redirectUri of rejectedRedirects) {
      const rejected = await request(baseUrl, buildAuthorizePath({ clientId: '', redirectUri }));
      assert.equal(rejected.status, 400, `expected ${redirectUri} to be rejected`);
      assert.match(rejected.body, /invalid_request/);
    }

    const claudeClientRedirectMismatch = await request(
      baseUrl,
      buildAuthorizePath({
        clientId: 'claude-public-client',
        redirectUri: `${CLAUDE_CALLBACK}#frag`,
      }),
    );
    assert.equal(claudeClientRedirectMismatch.status, 400);
    assert.match(claudeClientRedirectMismatch.body, /invalid_request/);

    const unsupportedTokenSource = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: 'intervals-code',
        client_id: 'not-claude-public-client',
        client_secret: 'secret',
        redirect_uri: 'https://example.com/claude/oauth/callback',
      },
    });
    assert.equal(unsupportedTokenSource.status, 400);
    assert.match(unsupportedTokenSource.body, /invalid_request/);

    const leakLogs = await captureConsole(async () => {
      const secretState = 'state-secret-should-not-log';
      const secretBridge = await issueBridgeCode(baseUrl, {
        state: secretState,
        upstreamCode: 'intervals-code-secret-leak',
      });

      const failingExchange = await request(baseUrl, '/gw/oauth/token', {
        method: 'POST',
        json: {
          grant_type: 'authorization_code',
          code: secretBridge.bridgeCode,
          redirect_uri: CHATGPT_CALLBACK,
          code_verifier: DEFAULT_PKCE_VERIFIER,
          client_secret: 'client-secret-should-not-log',
        },
      });
      assert.equal(failingExchange.status, 400);

      process.env.ENABLE_LEGACY_STAS_ID_OAUTH = '1';
      const legacyForLog = buildAuthorizePath({
        clientId: 'legacy-client',
        redirectUri: 'https://chat.openai.com/aip/g-legacy/oauth/callback',
        scope: 'read:me icu workouts:write',
        state: 'legacy-state-should-not-log',
      });
      const legacyRedirect = await request(baseUrl, `${legacyForLog}&uid=108`);
      assert.equal(legacyRedirect.status, 302);
      delete process.env.ENABLE_LEGACY_STAS_ID_OAUTH;
    });

    for (const forbidden of [
      DEFAULT_PKCE_VERIFIER,
      'test-intervals-secret',
      'client-secret-should-not-log',
      'state-secret-should-not-log',
      'legacy-state-should-not-log',
      LEAKED_UPSTREAM_ACCESS_TOKEN,
      LEAKED_UPSTREAM_REFRESH_TOKEN,
      CHATGPT_CALLBACK,
      'code=',
    ]) {
      assert.doesNotMatch(leakLogs, new RegExp(escapeRegExp(forbidden)), `log leaked ${forbidden}`);
    }

    const legacyAuthorizePath = buildAuthorizePath({
      clientId: 'legacy-client',
      redirectUri: 'https://chat.openai.com/aip/g-legacy/oauth/callback',
      scope: 'read:me icu workouts:write',
    });
    const legacyStasIdPageDefault = await request(baseUrl, legacyAuthorizePath);
    assert.equal(legacyStasIdPageDefault.status, 404);
    assert.doesNotMatch(legacyStasIdPageDefault.body, /ВВЕДИТЕ ВАШ STAS ID/);

    const legacyAuthorizeDefault = await request(baseUrl, `${legacyAuthorizePath}&uid=108`);
    assert.equal(legacyAuthorizeDefault.status, 400);
    assert.match(legacyAuthorizeDefault.body, /legacy_stas_id_oauth_disabled/);

    const legacyTokenDefault = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: makeLegacyCode('108'),
      },
    });
    assert.equal(legacyTokenDefault.status, 400);
    assert.match(legacyTokenDefault.body, /legacy_token_exchange_disabled/);

    process.env.ENABLE_LEGACY_STAS_ID_OAUTH = '1';
    const legacyStasIdPageEnabled = await request(baseUrl, legacyAuthorizePath);
    assert.equal(legacyStasIdPageEnabled.status, 200);
    assert.match(legacyStasIdPageEnabled.contentType, /text\/html/);
    assert.match(legacyStasIdPageEnabled.body, /ВВЕДИТЕ ВАШ STAS ID/);
    assert.doesNotMatch(legacyStasIdPageEnabled.body, /cdn\.tailwindcss\.com/);
    assert.doesNotMatch(legacyStasIdPageEnabled.body, /public\.blob\.vercel-storage\.com/);

    const legacyAuthorizeEnabled = await request(baseUrl, `${legacyAuthorizePath}&uid=108`);
    assert.equal(legacyAuthorizeEnabled.status, 302);
    const legacyAuthorizeLocation = new URL(legacyAuthorizeEnabled.location);
    assert.equal(`${legacyAuthorizeLocation.origin}${legacyAuthorizeLocation.pathname}`, 'https://chat.openai.com/aip/g-legacy/oauth/callback');
    assert.match(legacyAuthorizeLocation.searchParams.get('code'), /^c_/);
    delete process.env.ENABLE_LEGACY_STAS_ID_OAUTH;

    process.env.ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE = '1';
    const legacyTokenEnabled = await request(
      baseUrl,
      '/gw/oauth/token',
      {
        method: 'POST',
        json: {
          grant_type: 'authorization_code',
          code: makeLegacyCode('108'),
          scope: 'read:me',
        },
      },
    );
    assert.equal(legacyTokenEnabled.status, 400);
    const legacyTokenBody = JSON.parse(legacyTokenEnabled.body);
    assert.equal(legacyTokenBody.error, 'legacy_token_exchange_removed');
    assert.equal(legacyTokenBody.access_token, undefined);
    assert.doesNotMatch(legacyTokenEnabled.body, /"access_token"/);
    delete process.env.ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE;

    console.log('oauth flow tests passed');
  } finally {
    Date.now = realDateNow;
    global.fetch = originalFetch;
    server.close();
    restoreEnv();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
