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
  MCP_DCR_CONFIDENTIAL_REDIRECT_URIS: process.env.MCP_DCR_CONFIDENTIAL_REDIRECT_URIS,
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
delete process.env.MCP_DCR_CONFIDENTIAL_REDIRECT_URIS;

const oauthPage = require('../middleware/oauth_page');
const oauth = require('../routes/oauth');
const { buildOAuthAuthorizationServerMetadata } = require('../lib/oauth-metadata');
const { __testing: registrationTesting } = require('../lib/mcp-client-registration');
const {
  isAllowedChatGptRedirectUri,
  isAllowedClaudeRedirectUri,
  normalizeSource,
  resolveOauthSource,
} = require('../lib/request-source');

const INTERVALS_SCOPE = 'ACTIVITY:WRITE,WELLNESS:WRITE,CALENDAR:WRITE,CHATS:WRITE,LIBRARY:WRITE,SETTINGS:WRITE';
const CHATGPT_CALLBACK = 'https://chat.openai.com/aip/g-0e683685e67e111ebd51aa7d6b2be34f380bb37f/oauth/callback';
const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const PERPLEXITY_CALLBACK = 'https://www.perplexity.ai/rest/connections/oauth_callback';
const INTERVALS_CALLBACK = 'https://intervals.stas.run/gw/oauth/callback';
const AUTHORIZATION_ISSUER = 'https://intervals.stas.run';
const MCP_RESOURCE = 'https://stas.run/api/mcp';
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
    response_type: params.responseType ?? 'code',
    client_id: params.clientId ?? '',
    redirect_uri: params.redirectUri ?? CHATGPT_CALLBACK,
    state: params.state ?? 'test-state',
    scope: params.scope ?? INTERVALS_SCOPE,
  });

  if (Array.isArray(params.resources)) {
    for (const resource of params.resources) search.append('resource', resource);
  } else if (params.resource !== null && (params.resource || String(params.clientId || '').startsWith('stas_mcp_'))) {
    search.set('resource', params.resource || MCP_RESOURCE);
  }

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

function validateAuthorizationIssuer(location, expected = AUTHORIZATION_ISSUER) {
  const response = new URL(location);
  const issuers = response.searchParams.getAll('iss');
  if (issuers.length !== 1 || issuers[0] !== expected) {
    throw new Error('authorization_response_issuer_mismatch');
  }
  return response;
}

function assertAuthorizationError(response, expectedError, expectedState = 'test-state') {
  assert.equal(response.status, 302);
  const location = validateAuthorizationIssuer(response.location);
  assert.equal(location.searchParams.get('error'), expectedError);
  assert.equal(location.searchParams.get('state'), expectedState);
  assert.equal(location.searchParams.has('code'), false);
  return location;
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
    wwwAuthenticate: response.headers.get('www-authenticate') || '',
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
    assert.match(form.get('code'), /^intervals-code/);
    if (form.get('code') === 'intervals-code-no-pkce') {
      assert.equal(form.has('code_verifier'), false);
    } else {
      assert.equal(form.get('code_verifier'), DEFAULT_PKCE_VERIFIER);
    }
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

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/disconnect-app') {
    upstreamHits.push({
      url: parsed.toString(),
      method: options.method || 'GET',
      headers: options.headers || {},
    });
    assert.equal(options.method, 'DELETE');
    assert.equal(options.headers.Authorization, `Bearer ${RAW_INTERVALS_TOKEN}`);
    return jsonResponse({}, 204);
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
    assert.ok(['gpt', 'claude', 'mcp'].includes(body.source));
    return jsonResponse({ ok: true, athleteId: 417, created: false });
  }

  return originalFetch(url, options);
};

function tokenExchangeHitCount() {
  return upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/oauth/token').length;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeSignedMcpClientId(clientId) {
  const signed = String(clientId).replace(/^stas_mcp_/, '');
  return JSON.parse(Buffer.from(signed.slice(0, signed.lastIndexOf('.')), 'base64url').toString('utf8'));
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
  validateAuthorizationIssuer(callback.location);
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

async function registerMcpClient(baseUrl, options = {}) {
  const response = await request(baseUrl, '/gw/oauth/register', {
    method: 'POST',
    json: {
      client_name: options.clientName || 'Perplexity Computer',
      redirect_uris: options.redirectUris || [PERPLEXITY_CALLBACK],
      grant_types: options.grantTypes || ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: options.tokenEndpointAuthMethod || 'none',
      application_type: options.applicationType || 'web',
    },
  });
  assert.equal(response.status, 201);
  return JSON.parse(response.body);
}

async function issueMcpBridgeCode(baseUrl, options = {}) {
  const registration = options.registration || await registerMcpClient(baseUrl, options);
  const redirectUri = options.redirectUri || registration.redirect_uris[0];
  const authorize = await request(baseUrl, buildAuthorizePath({
    clientId: registration.client_id,
    redirectUri,
    state: options.state,
    scope: options.scope,
    codeVerifier: options.codeVerifier,
    codeChallenge: options.codeChallenge,
    codeChallengeMethod: options.codeChallengeMethod ?? 'S256',
    pkce: options.pkce,
    resource: options.resource,
    resources: options.resources,
  }));
  assert.equal(authorize.status, 302);
  assert.doesNotMatch(authorize.body, /mcp_consent_token|<form|Secure connection/);
  const authorizeLocation = new URL(authorize.location);
  assert.equal(authorizeLocation.origin, 'https://intervals.icu');
  assert.equal(authorizeLocation.pathname, '/oauth/authorize');
  assert.equal(authorizeLocation.searchParams.get('client_id'), 'test-intervals-client');
  assert.equal(authorizeLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);
  assert.equal(authorizeLocation.searchParams.get('response_type'), 'code');
  assert.equal(authorizeLocation.searchParams.get('scope'), INTERVALS_SCOPE);
  assert.equal(
    authorizeLocation.searchParams.get('code_challenge'),
    options.codeChallenge ?? makeS256Challenge(options.codeVerifier ?? DEFAULT_PKCE_VERIFIER),
  );
  assert.equal(authorizeLocation.searchParams.get('code_challenge_method'), 'S256');
  const bridgeState = authorizeLocation.searchParams.get('state');
  assert.ok(bridgeState);

  const callback = await request(
    baseUrl,
    `/gw/oauth/callback?code=${encodeURIComponent(options.upstreamCode || 'intervals-code-mcp')}&state=${encodeURIComponent(bridgeState)}`,
  );
  assert.equal(callback.status, 302);
  const callbackLocation = new URL(callback.location);
  validateAuthorizationIssuer(callback.location);
  assert.equal(callbackLocation.toString().split('?')[0], redirectUri.split('?')[0]);
  assert.equal(callbackLocation.searchParams.get('state'), options.state ?? 'test-state');
  const bridgeCode = callbackLocation.searchParams.get('code');
  assert.match(bridgeCode, /^gpt_/);

  return {
    authorize,
    authorizeLocation,
    bridgeCode,
    bridgeState,
    callbackLocation,
    registration,
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
    assert.equal(metadata.client_id_metadata_document_supported, true);
    assert.equal(metadata.authorization_response_iss_parameter_supported, true);
    assert.ok(metadata.grant_types_supported.includes('refresh_token'));
    assert.throws(
      () => validateAuthorizationIssuer('https://client.example/callback?code=missing-issuer'),
      /authorization_response_issuer_mismatch/,
    );
    assert.throws(
      () => validateAuthorizationIssuer('https://client.example/callback?code=wrong-issuer&iss=https%3A%2F%2Fwrong.example'),
      /authorization_response_issuer_mismatch/,
    );

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

    const universalRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: {
        client_name: 'Perplexity Computer',
        redirect_uris: [PERPLEXITY_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    assert.equal(universalRegister.status, 201);
    const universalRegisterBody = JSON.parse(universalRegister.body);
    assert.match(universalRegisterBody.client_id, /^stas_mcp_/);
    assert.equal(universalRegisterBody.client_name, 'Perplexity Computer');
    assert.deepEqual(universalRegisterBody.redirect_uris, [PERPLEXITY_CALLBACK]);
    assert.equal(universalRegisterBody.token_endpoint_auth_method, 'none');
    assert.deepEqual(universalRegisterBody.grant_types, ['authorization_code', 'refresh_token']);
    assert.ok(universalRegisterBody.client_id.length < 4096);
    assert.equal(decodeSignedMcpClientId(universalRegisterBody.client_id).v, 1, 'public DCR clients must remain legacy-v1 compatible');

    process.env.MCP_DCR_CONFIDENTIAL_REDIRECT_URIS = PERPLEXITY_CALLBACK;
    const compatibilityRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: {
        client_name: 'Any hosted MCP client',
        redirect_uris: [PERPLEXITY_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
    delete process.env.MCP_DCR_CONFIDENTIAL_REDIRECT_URIS;
    assert.equal(compatibilityRegister.status, 201, compatibilityRegister.body);
    const compatibilityRegisterBody = JSON.parse(compatibilityRegister.body);
    assert.equal(compatibilityRegisterBody.token_endpoint_auth_method, 'client_secret_post');
    assert.match(compatibilityRegisterBody.client_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(decodeSignedMcpClientId(compatibilityRegisterBody.client_id).v, 2);

    const nativeHttpsRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: {
        client_name: 'Native HTTPS',
        redirect_uris: ['https://native.example/oauth/callback'],
        application_type: 'native',
      },
    });
    assert.equal(nativeHttpsRegister.status, 201);

    const tooManyRedirectsRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: { redirect_uris: Array.from({ length: 4 }, (_, index) => `https://client.example/callback/${index}`) },
    });
    assert.equal(tooManyRedirectsRegister.status, 400);

    for (const invalidRedirectUri of [
      'http://www.perplexity.ai/rest/connections/oauth_callback',
      'https://user:password@example.com/oauth/callback',
      'https://example.com/oauth/callback#fragment',
      'https://localhost/oauth/callback',
      'https://localhost./oauth/callback',
      'https://foo.local./oauth/callback',
      'https://127.0.0.1/oauth/callback',
      'https://10.0.0.8/oauth/callback',
      'https://[::1]/oauth/callback',
    ]) {
      const invalidRegister = await request(baseUrl, '/gw/oauth/register', {
        method: 'POST',
        json: { redirect_uris: [invalidRedirectUri] },
      });
      assert.equal(invalidRegister.status, 400);
      assert.match(invalidRegister.body, /invalid_(client_metadata|redirect_uri)/);
    }

    const duplicateRedirectRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: { redirect_uris: [PERPLEXITY_CALLBACK, PERPLEXITY_CALLBACK] },
    });
    assert.equal(duplicateRedirectRegister.status, 400);

    const confidentialPostRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: {
        client_name: 'Hosted MCP client',
        redirect_uris: [PERPLEXITY_CALLBACK],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    assert.equal(confidentialPostRegister.status, 201, confidentialPostRegister.body);
    const confidentialPostRegisterBody = JSON.parse(confidentialPostRegister.body);
    assert.match(confidentialPostRegisterBody.client_id, /^stas_mcp_/);
    assert.match(confidentialPostRegisterBody.client_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(confidentialPostRegisterBody.client_secret_expires_at, 0);
    assert.equal(confidentialPostRegisterBody.token_endpoint_auth_method, 'client_secret_post');
    assert.doesNotMatch(confidentialPostRegisterBody.client_id, new RegExp(escapeRegExp(confidentialPostRegisterBody.client_secret)));

    const confidentialBasicRegisterBody = await registerMcpClient(baseUrl, {
      clientName: 'Hosted Basic MCP client',
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    assert.match(confidentialBasicRegisterBody.client_secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(confidentialBasicRegisterBody.token_endpoint_auth_method, 'client_secret_basic');

    const confidentialNativeRegister = await request(baseUrl, '/gw/oauth/register', {
      method: 'POST',
      json: {
        redirect_uris: ['http://127.0.0.1:3030/callback'],
        application_type: 'native',
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    assert.equal(confidentialNativeRegister.status, 400);
    assert.match(confidentialNativeRegister.body, /confidential_native_client_not_allowed/);

    const tamperedClientId = `${universalRegisterBody.client_id.slice(0, -1)}x`;
    const tamperedAuthorize = await request(baseUrl, buildAuthorizePath({
      clientId: tamperedClientId,
      redirectUri: PERPLEXITY_CALLBACK,
    }));
    assert.equal(tamperedAuthorize.status, 400);
    assert.match(tamperedAuthorize.body, /invalid_client/);

    const redirectMismatch = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: 'https://example.com/oauth/callback',
    }));
    assert.equal(redirectMismatch.status, 400);
    assert.equal(redirectMismatch.location, '');
    assert.match(redirectMismatch.body, /invalid_request/);

    const existingIssuerCallback = [
      'https://client.example/oauth/callback',
      '?keep=1',
      '&iss=https%3A%2F%2Fattacker.example',
      '&iss=https%3A%2F%2Fsecond-attacker.example',
      '&state=attacker-state',
      '&code=attacker-code',
    ].join('');
    const existingIssuerClient = await registerMcpClient(baseUrl, {
      clientName: 'Issuer collision client',
      redirectUris: [existingIssuerCallback],
    });
    const issuerCollisionBridge = await issueMcpBridgeCode(baseUrl, {
      registration: existingIssuerClient,
      redirectUri: existingIssuerCallback,
      state: 'bound-state',
    });
    assert.deepEqual(issuerCollisionBridge.callbackLocation.searchParams.getAll('iss'), [AUTHORIZATION_ISSUER]);
    assert.deepEqual(issuerCollisionBridge.callbackLocation.searchParams.getAll('state'), ['bound-state']);
    assert.equal(issuerCollisionBridge.callbackLocation.searchParams.getAll('code').length, 1);
    assert.equal(issuerCollisionBridge.callbackLocation.searchParams.get('keep'), '1');

    const deniedAuthorize = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      state: 'denied-state',
    }));
    const deniedBridgeState = new URL(deniedAuthorize.location).searchParams.get('state');
    const deniedCallback = await request(
      baseUrl,
      `/gw/oauth/callback?error=access_denied&error_description=cancelled&state=${encodeURIComponent(deniedBridgeState)}`,
    );
    const deniedLocation = assertAuthorizationError(deniedCallback, 'access_denied', 'denied-state');
    assert.equal(deniedLocation.searchParams.get('error_description'), 'cancelled');

    const missingCodeAuthorize = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      state: 'missing-code-state',
    }));
    const missingCodeBridgeState = new URL(missingCodeAuthorize.location).searchParams.get('state');
    const missingCodeCallback = await request(
      baseUrl,
      `/gw/oauth/callback?state=${encodeURIComponent(missingCodeBridgeState)}`,
    );
    assertAuthorizationError(missingCodeCallback, 'invalid_request', 'missing-code-state');

    const missingPkceMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      pkce: false,
    }));
    assertAuthorizationError(missingPkceMcp, 'invalid_request');

    const invalidScopeMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      scope: 'ACTIVITY:READ secret:scope',
    }));
    assertAuthorizationError(invalidScopeMcp, 'invalid_scope');

    const missingResourceMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      resource: null,
    }));
    assertAuthorizationError(missingResourceMcp, 'invalid_target');

    const wrongResourceMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      resource: 'https://other.example/mcp',
    }));
    assertAuthorizationError(wrongResourceMcp, 'invalid_target');

    const multipleDifferentResourcesMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      resources: [MCP_RESOURCE, 'https://other.example/mcp'],
    }));
    assertAuthorizationError(multipleDifferentResourcesMcp, 'invalid_target');

    const unsupportedResponseTypeMcp = await request(baseUrl, buildAuthorizePath({
      clientId: universalRegisterBody.client_id,
      redirectUri: PERPLEXITY_CALLBACK,
      responseType: 'token',
    }));
    assertAuthorizationError(unsupportedResponseTypeMcp, 'unsupported_response_type');

    const authorizePost = await request(baseUrl, '/gw/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'mcp_consent_token=obsolete',
    });
    assert.equal(authorizePost.status, 404);
    assert.match(authorizePost.body, /not_found/);

    const repeatedResourceBridge = await issueMcpBridgeCode(baseUrl, {
      registration: universalRegisterBody,
      resources: [MCP_RESOURCE, MCP_RESOURCE],
      scope: 'ACTIVITY:READ',
      upstreamCode: 'intervals-code-mcp-repeated-resource',
    });
    const repeatedResourceTokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: repeatedResourceBridge.bridgeCode,
      client_id: universalRegisterBody.client_id,
      redirect_uri: PERPLEXITY_CALLBACK,
      code_verifier: DEFAULT_PKCE_VERIFIER,
    });
    repeatedResourceTokenBody.append('resource', MCP_RESOURCE);
    repeatedResourceTokenBody.append('resource', MCP_RESOURCE);
    const repeatedResourceExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: repeatedResourceTokenBody.toString(),
    });
    assert.equal(repeatedResourceExchange.status, 200, repeatedResourceExchange.body);
    assert.equal(JSON.parse(repeatedResourceExchange.body).scope, 'ACTIVITY:READ');

    const limitedMcpBridge = await issueMcpBridgeCode(baseUrl, {
      registration: universalRegisterBody,
      scope: 'ACTIVITY:READ',
      upstreamCode: 'intervals-code-mcp-limited',
    });
    assert.equal(limitedMcpBridge.authorizeLocation.searchParams.get('scope'), INTERVALS_SCOPE);
    const limitedMcpExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: limitedMcpBridge.bridgeCode,
        client_id: universalRegisterBody.client_id,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: 'https://stas.run/api/mcp',
      },
    });
    assert.equal(limitedMcpExchange.status, 200, limitedMcpExchange.body);
    assert.equal(JSON.parse(limitedMcpExchange.body).scope, 'ACTIVITY:READ');

    const mcpBridge = await issueMcpBridgeCode(baseUrl, { registration: universalRegisterBody });
    assert.equal(mcpBridge.authorizeLocation.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(mcpBridge.authorizeLocation.searchParams.get('redirect_uri'), INTERVALS_CALLBACK);
    const mcpExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: mcpBridge.bridgeCode,
        client_id: universalRegisterBody.client_id,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: 'https://stas.run/api/mcp',
      },
    });
    assert.equal(mcpExchange.status, 200, mcpExchange.body);
    const mcpExchangeBody = JSON.parse(mcpExchange.body);
    assert.match(mcpExchangeBody.access_token, /^stas_mcp_at_/);
    assert.match(mcpExchangeBody.refresh_token, /^stas_mcp_rt_/);
    assert.notEqual(mcpExchangeBody.access_token, RAW_INTERVALS_TOKEN);
    assert.doesNotMatch(mcpExchange.body, new RegExp(escapeRegExp(RAW_INTERVALS_TOKEN)));
    const lastEnsureHit = upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/db/ensure-intervals-user').at(-1);
    assert.equal(JSON.parse(lastEnsureHit.body).source, 'mcp');

    const mcpRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: mcpExchangeBody.refresh_token,
        client_id: universalRegisterBody.client_id,
        resource: 'https://stas.run/api/mcp',
      },
    });
    assert.equal(mcpRefresh.status, 200);
    const mcpRefreshBody = JSON.parse(mcpRefresh.body);
    assert.match(mcpRefreshBody.access_token, /^stas_mcp_at_/);
    assert.match(mcpRefreshBody.refresh_token, /^stas_mcp_rt_/);
    assert.notEqual(mcpRefreshBody.refresh_token, mcpExchangeBody.refresh_token);

    const repeatedRefreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: mcpRefreshBody.refresh_token,
      client_id: universalRegisterBody.client_id,
    });
    repeatedRefreshBody.append('resource', MCP_RESOURCE);
    repeatedRefreshBody.append('resource', MCP_RESOURCE);
    const repeatedResourceRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: repeatedRefreshBody.toString(),
    });
    assert.equal(repeatedResourceRefresh.status, 200, repeatedResourceRefresh.body);
    const repeatedResourceRefreshBody = JSON.parse(repeatedResourceRefresh.body);

    const invalidTargetRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: repeatedResourceRefreshBody.refresh_token,
        client_id: universalRegisterBody.client_id,
        resource: 'https://other.example/mcp',
      },
    });
    assert.equal(invalidTargetRefresh.status, 400);
    assert.match(invalidTargetRefresh.body, /invalid_target/);

    const replayedRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: mcpExchangeBody.refresh_token,
        client_id: universalRegisterBody.client_id,
        resource: 'https://stas.run/api/mcp',
      },
    });
    assert.equal(replayedRefresh.status, 400);
    assert.match(replayedRefresh.body, /invalid_grant/);

    const mcpRevoke = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: { token: mcpRefreshBody.access_token, token_type_hint: 'access_token' },
    });
    assert.equal(mcpRevoke.status, 200);
    assert.equal(
      upstreamHits.filter((hit) => new URL(hit.url).pathname === '/api/v1/disconnect-app').length,
      0,
    );

    const missingSecretBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialPostRegisterBody,
      upstreamCode: 'intervals-code-confidential-missing-secret',
    });
    const beforeMissingSecretHits = tokenExchangeHitCount();
    const missingSecretExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: missingSecretBridge.bridgeCode,
        client_id: confidentialPostRegisterBody.client_id,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(missingSecretExchange.status, 401);
    assert.match(missingSecretExchange.body, /invalid_client/);
    assert.equal(tokenExchangeHitCount(), beforeMissingSecretHits);

    const wrongSecretBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialPostRegisterBody,
      upstreamCode: 'intervals-code-confidential-wrong-secret',
    });
    const wrongSecretExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: wrongSecretBridge.bridgeCode,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: 'wrong-confidential-secret',
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(wrongSecretExchange.status, 401);
    assert.match(wrongSecretExchange.body, /invalid_client/);

    const basicMissingBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialBasicRegisterBody,
      upstreamCode: 'intervals-code-confidential-basic-missing',
    });
    const basicMissingExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: basicMissingBridge.bridgeCode,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(basicMissingExchange.status, 401);
    assert.match(basicMissingExchange.wwwAuthenticate, /^Basic /);

    const basicWrongClientBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialBasicRegisterBody,
      upstreamCode: 'intervals-code-confidential-basic-wrong-client',
    });
    const basicWrongClientAuthorization = `Basic ${Buffer.from(`wrong-client-id:${confidentialBasicRegisterBody.client_secret}`).toString('base64')}`;
    const basicWrongClientExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: basicWrongClientAuthorization },
      json: {
        grant_type: 'authorization_code',
        code: basicWrongClientBridge.bridgeCode,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(basicWrongClientExchange.status, 401);
    assert.match(basicWrongClientExchange.wwwAuthenticate, /^Basic /);

    const basicWrongSecretBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialBasicRegisterBody,
      upstreamCode: 'intervals-code-confidential-basic-wrong-secret',
    });
    const basicWrongSecretAuthorization = `Basic ${Buffer.from(`${confidentialBasicRegisterBody.client_id}:wrong-basic-secret`).toString('base64')}`;
    const basicWrongSecretExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: basicWrongSecretAuthorization },
      json: {
        grant_type: 'authorization_code',
        code: basicWrongSecretBridge.bridgeCode,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(basicWrongSecretExchange.status, 401);
    assert.match(basicWrongSecretExchange.wwwAuthenticate, /^Basic /);

    const mixedSecretBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialBasicRegisterBody,
      upstreamCode: 'intervals-code-confidential-mixed-secret',
    });
    const mixedSecretExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${confidentialBasicRegisterBody.client_id}:${confidentialBasicRegisterBody.client_secret}`).toString('base64')}`,
      },
      json: {
        grant_type: 'authorization_code',
        code: mixedSecretBridge.bridgeCode,
        client_id: confidentialBasicRegisterBody.client_id,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(mixedSecretExchange.status, 401);
    assert.match(mixedSecretExchange.body, /invalid_client/);
    assert.match(mixedSecretExchange.wwwAuthenticate, /^Basic /);

    const confidentialPostBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialPostRegisterBody,
      upstreamCode: 'intervals-code-confidential-post',
    });
    const confidentialPostExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: confidentialPostBridge.bridgeCode,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: confidentialPostRegisterBody.client_secret,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialPostExchange.status, 200, confidentialPostExchange.body);
    const confidentialPostTokens = JSON.parse(confidentialPostExchange.body);

    const missingRefreshSecret = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialPostTokens.refresh_token,
        client_id: confidentialPostRegisterBody.client_id,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(missingRefreshSecret.status, 401);
    assert.match(missingRefreshSecret.body, /invalid_client/);

    const wrongRefreshSecret = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialPostTokens.refresh_token,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: 'wrong-refresh-secret',
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(wrongRefreshSecret.status, 401);
    assert.match(wrongRefreshSecret.body, /invalid_client/);

    const confidentialPostRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialPostTokens.refresh_token,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: confidentialPostRegisterBody.client_secret,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialPostRefresh.status, 200, confidentialPostRefresh.body);
    const confidentialPostRefreshedTokens = JSON.parse(confidentialPostRefresh.body);

    const missingRevokeSecret = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: { token: confidentialPostRefreshedTokens.access_token },
    });
    assert.equal(missingRevokeSecret.status, 401);
    assert.match(missingRevokeSecret.body, /invalid_client/);
    const wrongRevokeSecret = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: {
        token: confidentialPostRefreshedTokens.access_token,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: 'wrong-revoke-secret',
      },
    });
    assert.equal(wrongRevokeSecret.status, 401);
    assert.match(wrongRevokeSecret.body, /invalid_client/);
    const confidentialPostRevoke = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: {
        token: confidentialPostRefreshedTokens.access_token,
        client_id: confidentialPostRegisterBody.client_id,
        client_secret: confidentialPostRegisterBody.client_secret,
      },
    });
    assert.equal(confidentialPostRevoke.status, 200);

    const confidentialBasicBridge = await issueMcpBridgeCode(baseUrl, {
      registration: confidentialBasicRegisterBody,
      upstreamCode: 'intervals-code-confidential-basic',
    });
    const confidentialBasicAuthorization = `Basic ${Buffer.from(`${confidentialBasicRegisterBody.client_id}:${confidentialBasicRegisterBody.client_secret}`).toString('base64')}`;
    const confidentialBasicExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: confidentialBasicAuthorization },
      json: {
        grant_type: 'authorization_code',
        code: confidentialBasicBridge.bridgeCode,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicExchange.status, 200, confidentialBasicExchange.body);
    const confidentialBasicTokens = JSON.parse(confidentialBasicExchange.body);

    const confidentialBasicMissingRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialBasicTokens.refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicMissingRefresh.status, 401);
    assert.match(confidentialBasicMissingRefresh.wwwAuthenticate, /^Basic /);

    const confidentialBasicWrongClientRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: basicWrongClientAuthorization },
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialBasicTokens.refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicWrongClientRefresh.status, 401);
    assert.match(confidentialBasicWrongClientRefresh.wwwAuthenticate, /^Basic /);

    const confidentialBasicWrongSecretRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: basicWrongSecretAuthorization },
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialBasicTokens.refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicWrongSecretRefresh.status, 401);
    assert.match(confidentialBasicWrongSecretRefresh.wwwAuthenticate, /^Basic /);

    const confidentialBasicMixedRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: confidentialBasicAuthorization },
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialBasicTokens.refresh_token,
        client_id: confidentialBasicRegisterBody.client_id,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicMixedRefresh.status, 401);
    assert.match(confidentialBasicMixedRefresh.wwwAuthenticate, /^Basic /);

    const confidentialBasicRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { authorization: confidentialBasicAuthorization },
      json: {
        grant_type: 'refresh_token',
        refresh_token: confidentialBasicTokens.refresh_token,
        resource: MCP_RESOURCE,
      },
    });
    assert.equal(confidentialBasicRefresh.status, 200, confidentialBasicRefresh.body);
    const confidentialBasicRefreshedTokens = JSON.parse(confidentialBasicRefresh.body);
    const confidentialBasicRevoke = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      headers: { authorization: confidentialBasicAuthorization },
      json: { token: confidentialBasicRefreshedTokens.access_token },
    });
    assert.equal(confidentialBasicRevoke.status, 200);

    const wrongClientBridge = await issueMcpBridgeCode(baseUrl, { registration: universalRegisterBody });
    const wrongClientExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: wrongClientBridge.bridgeCode,
        client_id: `${universalRegisterBody.client_id}wrong`,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: 'https://stas.run/api/mcp',
      },
    });
    assert.equal(wrongClientExchange.status, 400);
    assert.match(wrongClientExchange.body, /invalid_client/);

    const wrongResourceBridge = await issueMcpBridgeCode(baseUrl, { registration: universalRegisterBody });
    const wrongResourceExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: wrongResourceBridge.bridgeCode,
        client_id: universalRegisterBody.client_id,
        redirect_uri: PERPLEXITY_CALLBACK,
        code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: 'https://other.example/mcp',
      },
    });
    assert.equal(wrongResourceExchange.status, 400);
    assert.match(wrongResourceExchange.body, /invalid_target/);

    const claudeRegisterBody = await registerMcpClient(baseUrl, {
      clientName: 'Claude',
      redirectUris: [CLAUDE_CALLBACK, 'https://claude.com/api/mcp/auth_callback'],
    });
    assert.match(claudeRegisterBody.client_id, /^stas_mcp_/);

    const nativeRegisterBody = await registerMcpClient(baseUrl, {
      clientName: 'Claude Code',
      redirectUris: ['http://127.0.0.1:3030/oauth/callback'],
      applicationType: 'native',
    });
    assert.equal(nativeRegisterBody.application_type, 'native');
    const nativeBridge = await issueMcpBridgeCode(baseUrl, {
      registration: nativeRegisterBody,
      redirectUri: 'http://127.0.0.1:49152/oauth/callback',
    });
    assert.equal(nativeBridge.callbackLocation.origin, 'http://127.0.0.1:49152');

    const nativeLocalhostRegisterBody = await registerMcpClient(baseUrl, {
      clientName: 'Native localhost client',
      redirectUris: ['http://localhost/callback'],
      applicationType: 'native',
    });
    const nativeLocalhostBridge = await issueMcpBridgeCode(baseUrl, {
      registration: nativeLocalhostRegisterBody,
      redirectUri: 'http://localhost:49153/callback',
    });
    assert.equal(nativeLocalhostBridge.callbackLocation.origin, 'http://localhost:49153');

    const unregisteredDcrLocalhost = await request(baseUrl, buildAuthorizePath({
      clientId: nativeRegisterBody.client_id,
      redirectUri: 'http://localhost:49153/oauth/callback',
    }));
    assert.equal(unregisteredDcrLocalhost.status, 400);
    assert.match(unregisteredDcrLocalhost.body, /invalid_request/);

    // Regression fixture captured from Codex CLI 0.144.1. The production path
    // remains client-neutral; this exercises its native loopback URI and the
    // repeated RFC 8707 resource parameters that exposed the bug.
    const codexRegisterBody = await registerMcpClient(baseUrl, {
      clientName: 'Codex',
      redirectUris: ['http://127.0.0.1:36787/callback/iYlg0iQkackB'],
      applicationType: 'native',
    });
    const codexBridge = await issueMcpBridgeCode(baseUrl, {
      registration: codexRegisterBody,
      resources: [MCP_RESOURCE, MCP_RESOURCE],
      scope: 'ACTIVITY:READ',
      upstreamCode: 'intervals-code-codex-repeated-resource',
    });
    assert.equal(codexBridge.callbackLocation.origin, 'http://127.0.0.1:36787');
    assert.equal(codexBridge.callbackLocation.pathname, '/callback/iYlg0iQkackB');
    const codexTokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: codexBridge.bridgeCode,
      client_id: codexRegisterBody.client_id,
      redirect_uri: 'http://127.0.0.1:36787/callback/iYlg0iQkackB',
      code_verifier: DEFAULT_PKCE_VERIFIER,
    });
    codexTokenBody.append('resource', MCP_RESOURCE);
    codexTokenBody.append('resource', MCP_RESOURCE);
    const codexExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: codexTokenBody.toString(),
    });
    assert.equal(codexExchange.status, 200, codexExchange.body);
    assert.equal(JSON.parse(codexExchange.body).scope, 'ACTIVITY:READ');

    const cimdClientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
    // A real-shaped ChatGPT CIMD fixture with local ephemeral keys exercises
    // the complete bridge and every client-authenticated MCP endpoint.
    const fixture = require('./fixtures/private-key-jwt');
    const replayStore = require('../lib/mcp-oauth-tokens').__testing.resetTokenStore();
    const signingKey = fixture.makeKey();
    let signingMetadata = fixture.metadata();
    let signingFetches = 0;
    const signingOptions = {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (url) => {
        signingFetches += 1;
        return new Response(JSON.stringify(url === fixture.JWKS_URI
          ? { keys: [signingKey.jwk] } : signingMetadata), { headers: { 'content-type': 'application/json' } });
      },
    };
    registrationTesting.setCimdOptions(signingOptions);
    const privateBridge = () => issueMcpBridgeCode(baseUrl, {
      registration: fixture.metadata(), resources: [MCP_RESOURCE],
    });
    const exchangePrivate = async (bodyPatch = {}, includeAssertion = true) => {
      const bridge = await privateBridge();
      return request(baseUrl, '/gw/oauth/token', {
        method: 'POST', json: {
          grant_type: 'authorization_code', code: bridge.bridgeCode,
          client_id: fixture.CLIENT_ID, redirect_uri: fixture.CALLBACK,
          code_verifier: DEFAULT_PKCE_VERIFIER, resource: MCP_RESOURCE,
          ...(includeAssertion ? fixture.assertionRequest(signingKey).body : {}), ...bodyPatch,
        },
      });
    };
    const missingPrivateAssertion = await exchangePrivate({}, false);
    assert.equal(missingPrivateAssertion.status, 401);
    assert.deepEqual(JSON.parse(missingPrivateAssertion.body), { error: 'invalid_client' });
    for (const patch of [{ code_verifier: WRONG_PKCE_VERIFIER }, { redirect_uri: 'https://other.example/callback' }, { resource: 'https://other.example/mcp' }]) {
      const invalid = await exchangePrivate(patch);
      assert.equal(invalid.status, 400);
    }
    let signedExchange;
    const assertionForLogs = fixture.assertionRequest(signingKey).body;
    const privateLogs = await captureConsole(async () => { signedExchange = await exchangePrivate(assertionForLogs); });
    assert.equal(privateLogs.includes(assertionForLogs.client_assertion), false);
    assert.equal(privateLogs.includes(signingKey.jwk.n), false);
    assert.equal(signedExchange.status, 200, signedExchange.body);
    const signedTokens = JSON.parse(signedExchange.body);
    assert.ok(signedTokens.refresh_token);
    const signedRefreshBody = {
      grant_type: 'refresh_token', refresh_token: signedTokens.refresh_token,
      resource: MCP_RESOURCE, client_id: fixture.CLIENT_ID,
    };
    const unsignedRefresh = await request(baseUrl, '/gw/oauth/token', { method: 'POST', json: signedRefreshBody });
    assert.equal(unsignedRefresh.status, 401);
    const refreshAssertion = fixture.assertionRequest(signingKey).body;
    const signedRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST', json: { ...signedRefreshBody, ...refreshAssertion },
    });
    assert.equal(signedRefresh.status, 200, signedRefresh.body);
    const rotatedTokens = JSON.parse(signedRefresh.body);
    const unsignedRevocation = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST', json: { token: rotatedTokens.access_token },
    });
    assert.equal(unsignedRevocation.status, 401);
    const replayRevocation = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST', json: { token: rotatedTokens.access_token, ...refreshAssertion },
    });
    assert.equal(replayRevocation.status, 401);
    const signedRevocation = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST', json: { token: rotatedTokens.refresh_token, ...fixture.assertionRequest(signingKey).body },
    });
    assert.equal(signedRevocation.status, 200);
    assert.equal((await require('../lib/mcp-oauth-tokens').resolveMcpAccessToken(rotatedTokens.access_token)).auth, null);
    const revokedRefresh = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST', json: { ...signedRefreshBody, refresh_token: rotatedTokens.refresh_token, ...fixture.assertionRequest(signingKey).body },
    });
    assert.equal(revokedRefresh.status, 400);
    assert.match(revokedRefresh.body, /invalid_grant/);
    const downgradeTokens = JSON.parse((await exchangePrivate()).body);
    signingMetadata = fixture.metadata({ token_endpoint_auth_method: 'none' });
    registrationTesting.setCimdOptions(signingOptions);
    const downgraded = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST', json: { ...signedRefreshBody, refresh_token: downgradeTokens.refresh_token },
    });
    assert.equal(downgraded.status, 400);
    assert.match(downgraded.body, /invalid_client/);
    assert.equal(signingFetches, 3, 'one CIMD + one JWKS + one explicit CIMD invalidation');

    signingMetadata = fixture.metadata();
    registrationTesting.setCimdOptions(signingOptions);
    const privateGrant = async () => {
      const bridge = await privateBridge();
      return {
        grant_type: 'authorization_code', code: bridge.bridgeCode,
        redirect_uri: fixture.CALLBACK, code_verifier: DEFAULT_PKCE_VERIFIER,
        resource: MCP_RESOURCE, ...fixture.assertionRequest(signingKey).body,
      };
    };
    const postPrivate = (json) => request(baseUrl, '/gw/oauth/token', { method: 'POST', json });
    const retriableGrant = await privateGrant();
    const beforeInvalidBindings = replayStore.assertions.size;
    const beforeInvalidUpstream = upstreamHits.length;
    for (const patch of [
      { code_verifier: WRONG_PKCE_VERIFIER }, { resource: 'https://other.example/mcp' },
      { client_id: 'wrong-client' }, { redirect_uri: 'https://other.example/callback' },
      { grant_type: 'unsupported' },
    ]) {
      const rejected = await postPrivate({ ...retriableGrant, ...patch });
      assert.equal(rejected.status, patch.client_id ? 401 : 400);
      assert.equal(replayStore.assertions.size, beforeInvalidBindings, 'Invalid bindings must not consume JTI');
      assert.equal(upstreamHits.length, beforeInvalidUpstream, 'Invalid bindings must not exchange upstream');
    }
    assert.equal((await postPrivate(retriableGrant)).status, 200, 'Same code and assertion survive binding errors');

    const storeFailureGrant = await privateGrant();
    const consumeAssertion = replayStore.consumeClientAssertion.bind(replayStore);
    replayStore.consumeClientAssertion = async () => { throw new Error('temporary DB outage before insertion'); };
    const beforeStoreFailure = replayStore.assertions.size;
    const beforeStoreFailureUpstream = upstreamHits.length;
    try {
      assert.equal((await postPrivate(storeFailureGrant)).status, 401);
      assert.equal(replayStore.assertions.size, beforeStoreFailure);
      assert.equal(upstreamHits.length, beforeStoreFailureUpstream);
    } finally {
      replayStore.consumeClientAssertion = consumeAssertion;
    }
    assert.equal((await postPrivate(storeFailureGrant)).status, 200, 'Same pair survives certain replay-store outage');

    const concurrentGrant = await privateGrant();
    const beforeConcurrent = upstreamHits.filter((hit) => hit.url === 'https://intervals.icu/api/oauth/token').length;
    const beforeConcurrentAssertions = replayStore.assertions.size;
    const concurrentResponses = await Promise.all(Array.from({ length: 8 }, () => postPrivate(concurrentGrant)));
    assert.equal(concurrentResponses.filter((response) => response.status === 200).length, 1);
    assert.equal(concurrentResponses.filter((response) => response.status === 400).length, 7);
    assert.equal(upstreamHits.filter((hit) => hit.url === 'https://intervals.icu/api/oauth/token').length - beforeConcurrent, 1);
    assert.equal(replayStore.assertions.size - beforeConcurrentAssertions, 1);

    const recoveringJwksUri = 'https://chatgpt.com/oauth/recovering-jwks.json';
    signingMetadata = fixture.metadata({ jwks_uri: recoveringJwksUri });
    let jwksAvailable = false;
    let recoveringKeyFetches = 0;
    registrationTesting.setCimdOptions({
      ...signingOptions,
      fetchImpl: async (url) => {
        if (url !== recoveringJwksUri) return signingOptions.fetchImpl(url);
        recoveringKeyFetches += 1;
        if (!jwksAvailable) throw new Error('temporary JWKS outage');
        return new Response(JSON.stringify({ keys: [signingKey.jwk] }), { headers: { 'content-type': 'application/json' } });
      },
    });
    const keyFailureGrant = await privateGrant();
    const beforeKeyFailure = replayStore.assertions.size;
    const beforeKeyFailureUpstream = upstreamHits.length;
    assert.equal((await postPrivate(keyFailureGrant)).status, 401);
    assert.equal(replayStore.assertions.size, beforeKeyFailure);
    assert.equal(upstreamHits.length, beforeKeyFailureUpstream);
    jwksAvailable = true;
    const realNow = Date.now;
    const recoveredAt = realNow() + 61_000;
    Date.now = () => recoveredAt;
    try {
      assert.equal((await postPrivate(keyFailureGrant)).status, 200, 'Same pair survives JWKS outage and cooldown');
      assert.equal(recoveringKeyFetches, 2);
    } finally {
      Date.now = realNow;
    }

    registrationTesting.setCimdOptions({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(JSON.stringify({
        client_id: cimdClientId,
        client_name: 'Claude',
        client_uri: 'https://claude.ai',
        redirect_uris: [CLAUDE_CALLBACK],
        grant_types: [
          'authorization_code',
          'refresh_token',
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        ],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }), { headers: { 'content-type': 'application/json' } }),
    });
    const cimdBridge = await issueMcpBridgeCode(baseUrl, {
      registration: {
        client_id: cimdClientId,
        redirect_uris: [CLAUDE_CALLBACK],
      },
      resources: [MCP_RESOURCE, MCP_RESOURCE],
    });
    assert.equal(cimdBridge.authorize.status, 302);
    assert.equal(cimdBridge.authorizeLocation.origin, 'https://intervals.icu');
    assert.doesNotMatch(cimdBridge.authorize.body, /consent|<form/i);

    const codexCimdClientId = 'https://chatgpt.com/oauth/codex/client.json';
    registrationTesting.setCimdOptions({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(JSON.stringify({
        client_id: codexCimdClientId,
        client_name: 'Codex',
        client_uri: 'https://chatgpt.com/codex',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
        token_endpoint_auth_method: 'none',
        token_endpoint_auth_methods_supported: ['none'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }), { headers: { 'content-type': 'application/json' } }),
    });
    const codexCimdIpv4Bridge = await issueMcpBridgeCode(baseUrl, {
      registration: {
        client_id: codexCimdClientId,
        redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      },
      redirectUri: 'http://127.0.0.1:63277/callback',
      resources: [MCP_RESOURCE],
    });
    assert.equal(codexCimdIpv4Bridge.callbackLocation.origin, 'http://127.0.0.1:63277');
    const codexCimdLocalhostBridge = await issueMcpBridgeCode(baseUrl, {
      registration: {
        client_id: codexCimdClientId,
        redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
      },
      redirectUri: 'http://localhost:63278/callback',
      resources: [MCP_RESOURCE],
    });
    assert.equal(codexCimdLocalhostBridge.callbackLocation.origin, 'http://localhost:63278');

    registrationTesting.setCimdOptions({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () => new Response(JSON.stringify({
        client_id: codexCimdClientId,
        client_name: 'Native loopback client',
        application_type: 'native',
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }), { headers: { 'content-type': 'application/json' } }),
    });
    const unregisteredLocalhost = await request(baseUrl, buildAuthorizePath({
      clientId: codexCimdClientId,
      redirectUri: 'http://localhost:63278/callback',
    }));
    assert.equal(unregisteredLocalhost.status, 400);
    assert.match(unregisteredLocalhost.body, /invalid_request/);
    registrationTesting.setCimdOptions(null);

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

    const noPkceBridge = await issueBridgeCode(baseUrl, {
      pkce: false,
      upstreamCode: 'intervals-code-no-pkce',
    });
    assert.equal(noPkceBridge.authorizeLocation.searchParams.has('code_challenge'), false);
    assert.equal(noPkceBridge.authorizeLocation.searchParams.has('code_challenge_method'), false);
    const noPkceExchange = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: {
        grant_type: 'authorization_code',
        code: noPkceBridge.bridgeCode,
        redirect_uri: CHATGPT_CALLBACK,
      },
    });
    assert.equal(noPkceExchange.status, 200);
    assert.equal(JSON.parse(noPkceExchange.body).access_token, RAW_INTERVALS_TOKEN);

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
    assertAuthorizationError(plainPkceAuthorize, 'invalid_request');

    const missingPkceAuthorize = await request(baseUrl, buildAuthorizePath({ pkce: false }));
    assert.equal(missingPkceAuthorize.status, 302);
    const missingPkceLocation = new URL(missingPkceAuthorize.location);
    assert.equal(missingPkceLocation.searchParams.has('code_challenge'), false);
    assert.equal(missingPkceLocation.searchParams.has('code_challenge_method'), false);

    const missingPkceClaudeAuthorize = await request(baseUrl, buildAuthorizePath({
      clientId: 'claude-public-client',
      redirectUri: CLAUDE_CALLBACK,
      pkce: false,
    }));
    assertAuthorizationError(missingPkceClaudeAuthorize, 'invalid_request');

    const savedNodeEnv = process.env.NODE_ENV;
    const savedOauthStateSecret = process.env.OAUTH_STATE_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'stas-oauth-state-dev-secret';

      const productionPlaceholderStateSecret = await request(baseUrl, buildAuthorizePath({ clientId: '' }));
      assertAuthorizationError(productionPlaceholderStateSecret, 'server_error');
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
    const claudeCallback = await request(
      baseUrl,
      `/gw/oauth/callback?code=intervals-code-claude&state=${encodeURIComponent(claudeAuthorizeLocation.searchParams.get('state'))}`,
    );
    assert.equal(claudeCallback.status, 302);
    const claudeCallbackLocation = validateAuthorizationIssuer(claudeCallback.location);
    assert.equal(`${claudeCallbackLocation.origin}${claudeCallbackLocation.pathname}`, CLAUDE_CALLBACK);
    assert.equal(claudeCallbackLocation.searchParams.get('state'), 'test-state');
    assert.match(claudeCallbackLocation.searchParams.get('code'), /^gpt_/);

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

    let generatedSecretForLogTest = '';
    const leakLogs = await captureConsole(async () => {
      const confidentialRegistrationForLog = await request(baseUrl, '/gw/oauth/register', {
        method: 'POST',
        json: {
          client_name: 'Confidential log test',
          redirect_uris: [PERPLEXITY_CALLBACK],
          token_endpoint_auth_method: 'client_secret_post',
        },
      });
      assert.equal(confidentialRegistrationForLog.status, 201);
      generatedSecretForLogTest = JSON.parse(confidentialRegistrationForLog.body).client_secret;

      const rejectedRegistration = await request(baseUrl, '/gw/oauth/register', {
        method: 'POST',
        json: {
          redirect_uris: ['https://client.example/oauth/callback?token=registration-query-secret#invalid'],
          application_type: 'native',
          access_token: 'registration-body-secret',
        },
      });
      assert.equal(rejectedRegistration.status, 400);

      const rejectedMetadataSecrets = await request(baseUrl, '/gw/oauth/register', {
        method: 'POST',
        json: {
          redirect_uris: [PERPLEXITY_CALLBACK],
          client_name: 'client-name-secret-should-not-log'.repeat(4),
          grant_types: ['authorization_code', 'grant-secret-should-not-log'],
          'unknown-key-secret-should-not-log': true,
        },
      });
      assert.equal(rejectedMetadataSecrets.status, 400);

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
      'registration-query-secret',
      'registration-body-secret',
      'client-name-secret-should-not-log',
      'grant-secret-should-not-log',
      'unknown-key-secret-should-not-log',
      'https://client.example/oauth/callback',
      CHATGPT_CALLBACK,
      'code=',
      generatedSecretForLogTest,
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
    validateAuthorizationIssuer(legacyAuthorizeEnabled.location);
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
