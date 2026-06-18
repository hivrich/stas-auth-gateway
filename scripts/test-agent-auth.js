#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const express = require('express');

const OLD_ENV = {
  AGENT_AUTH_ENABLED: process.env.AGENT_AUTH_ENABLED,
  AGENT_AUTH_TOKEN_SECRET: process.env.AGENT_AUTH_TOKEN_SECRET,
  AGENT_AUTH_POLL_INTERVAL_SECONDS: process.env.AGENT_AUTH_POLL_INTERVAL_SECONDS,
  AGENT_AUTH_TOKEN_TTL_SECONDS: process.env.AGENT_AUTH_TOKEN_TTL_SECONDS,
  AGENT_AUTH_CLAIM_TTL_MS: process.env.AGENT_AUTH_CLAIM_TTL_MS,
  AGENT_AUTH_CODE_ATTEMPT_LIMIT: process.env.AGENT_AUTH_CODE_ATTEMPT_LIMIT,
  INTERVALS_CLIENT_ID: process.env.INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET: process.env.INTERVALS_CLIENT_SECRET,
  STAS_BASE: process.env.STAS_BASE,
  STAS_KEY: process.env.STAS_KEY,
};

process.env.STAS_KEY = 'test-stas-key';
process.env.STAS_BASE = 'http://stas.local.test';
process.env.INTERVALS_CLIENT_ID = 'test-intervals-client';
process.env.INTERVALS_CLIENT_SECRET = 'test-intervals-secret';
process.env.AGENT_AUTH_POLL_INTERVAL_SECONDS = '5';
process.env.AGENT_AUTH_TOKEN_TTL_SECONDS = '3600';
process.env.AGENT_AUTH_CLAIM_TTL_MS = '600000';
process.env.AGENT_AUTH_CODE_ATTEMPT_LIMIT = '3';

const { buildOAuthAuthorizationServerMetadata } = require('../lib/oauth-metadata');
const {
  AGENT_AUTH_GRANT_TYPE,
  AGENT_AUTH_SCOPE,
  AGENT_INTERVALS_READ_SCOPE,
  AGENT_TOKEN_PREFIX,
  __testing,
} = require('../lib/agent-auth');
const agentRouter = require('../routes/agent');
const oauthRouter = require('../routes/oauth');
const bearerUid = require('../routes/_bearer_uid');
const agentReadOnlyGuard = require('../middleware/agent_read_only');
const trainingsRouter = require('../routes/trainings');
const uidInjectDb = require('../routes/_uid_inject_db');
const dbProxy = require('../routes/db_proxy');
const icu = require('../routes/icu');

const originalFetch = global.fetch;
const upstreamHits = [];
const RAW_INTERVALS_TOKEN = 'raw-intervals-agent-token';

function restoreEnv() {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

function textResponse(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      },
    },
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

global.fetch = async (url, options = {}) => {
  const parsed = new URL(url.toString());
  upstreamHits.push({
    url: parsed.toString(),
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
  });

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/oauth/token') {
    const form = new URLSearchParams(options.body.toString());
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('client_id'), 'test-intervals-client');
    assert.equal(form.get('client_secret'), 'test-intervals-secret');
    assert.equal(form.get('code'), 'mock-intervals-code');
    return jsonResponse({ access_token: RAW_INTERVALS_TOKEN, token_type: 'Bearer', expires_in: 3600 });
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    assert.notEqual(options.headers.Authorization, `Bearer ${AGENT_TOKEN_PREFIX}should-not-fallback`);
    assert.equal(options.headers.Authorization, `Bearer ${RAW_INTERVALS_TOKEN}`);
    return jsonResponse({ id: '15487', name: 'Agent Runner' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/ensure-intervals-user') {
    const body = JSON.parse(options.body);
    assert.equal(body.intervalsAthleteId, '15487');
    assert.equal(body.intervalsAccessToken, RAW_INTERVALS_TOKEN);
    return jsonResponse({ ok: true, user_id: '15487' });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/trainings') {
    assert.equal(parsed.searchParams.get('user_id'), '15487');
    return jsonResponse({ trainings: [{ id: 'training-1' }] });
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/user_summary') {
    assert.equal(parsed.searchParams.get('user_id'), '15487');
    return textResponse(JSON.stringify({ ok: true, summary: 'read-only' }), 200, 'application/json; charset=utf-8');
  }

  if (parsed.origin === 'http://stas.local.test' && parsed.pathname === '/api/db/activity_detail') {
    assert.equal(parsed.searchParams.get('user_id'), '15487');
    return textResponse(JSON.stringify({ ok: true, activity: 'detail' }), 200, 'application/json; charset=utf-8');
  }

  if (parsed.origin === 'https://intervals.icu' && parsed.pathname === '/api/v1/athlete/0/events') {
    assert.equal(options.headers.Authorization, `Bearer ${RAW_INTERVALS_TOKEN}`);
    return jsonResponse([]);
  }

  return jsonResponse({ error: 'unexpected_upstream', url: parsed.toString() }, 500);
};

function makeApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json(buildOAuthAuthorizationServerMetadata(`${req.protocol}://${req.get('host')}`));
  });

  app.use('/gw', agentRouter);
  app.use('/gw', bearerUid());
  app.use('/gw', agentReadOnlyGuard());

  app.get('/gw/api/me', (req, res) => {
    res.json({ ok: true, user_id: String(req.user_id), auth_mode: req.auth?.authMode || null });
  });

  app.post('/gw/strategy', (_req, res) => {
    res.json({ ok: true, write_would_have_happened: true });
  });

  app.use('/gw', trainingsRouter);
  app.use('/gw', oauthRouter);
  app.use('/gw/api/db', uidInjectDb);
  app.use('/gw/api/db', dbProxy);
  app.use('/gw/icu', icu);
  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));
  app.use((err, _req, res, _next) => {
    res.status(err?.status || 500).json({ error: err?.code || err?.message || 'internal_error' });
  });
  return app;
}

async function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function request(baseUrl, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;

  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  if (options.form !== undefined) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }

  const response = await originalFetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    location: response.headers.get('location') || '',
    contentType: response.headers.get('content-type') || '',
    text,
    body: parsed,
  };
}

async function main() {
  process.env.AGENT_AUTH_ENABLED = 'false';
  delete process.env.AGENT_AUTH_TOKEN_SECRET;
  let metadata = buildOAuthAuthorizationServerMetadata('https://intervals.stas.run');
  assert.deepEqual(metadata.grant_types_supported, ['authorization_code']);
  assert.equal(metadata.agent_auth, undefined);
  assert.equal(metadata.revocation_endpoint, undefined);

  process.env.AGENT_AUTH_ENABLED = 'true';
  process.env.AGENT_AUTH_TOKEN_SECRET = 'test-agent-auth-secret-not-for-production-32chars';
  __testing.reset();

  metadata = buildOAuthAuthorizationServerMetadata('https://intervals.stas.run');
  assert.ok(metadata.agent_auth);
  assert.equal(metadata.revocation_endpoint, 'https://intervals.stas.run/gw/oauth/revoke');
  assert.ok(metadata.grant_types_supported.includes(AGENT_AUTH_GRANT_TYPE));
  assert.equal(metadata.agent_auth.identity_endpoint, 'https://intervals.stas.run/gw/agent/identity');
  assert.equal(metadata.agent_auth.register_uri, metadata.agent_auth.identity_endpoint);
  assert.deepEqual(metadata.agent_auth.scopes_supported, ['stas.mcp.read']);
  assert.equal(AGENT_AUTH_SCOPE, 'stas.mcp.read');

  const server = await startServer(makeApp());
  const address = server.address();
  const baseUrl = `http://${address.address}:${address.port}`;

  try {
    let response = await request(baseUrl, '/gw/agent/identity', {
      method: 'POST',
      json: { type: 'anonymous', email: 'not-allowed@example.test' },
    });
    assert.equal(response.status, 400);

    response = await request(baseUrl, '/gw/agent/identity', {
      method: 'POST',
      json: { type: 'anonymous' },
    });
    assert.equal(response.status, 200);
    assert.match(response.body.registration_id, /^areg_/);
    assert.match(response.body.claim_token, /^claim_/);
    assert.match(response.body.claim.user_code, /^\d{6}$/);
    assert.equal(response.body.claim.verification_uri, `${baseUrl}/gw/agent/claim`);
    assert.equal(response.body.interval, 5);
    assert.doesNotMatch(response.text, new RegExp(RAW_INTERVALS_TOKEN));

    const claimToken = response.body.claim_token;
    let userCode = response.body.claim.user_code;
    let registrationSnapshot = __testing.getRegistrationSnapshotByClaimToken(claimToken);
    assert.equal(registrationSnapshot.hasPlaintextUserCode, false);
    assert.match(registrationSnapshot.userCodeHash, /^[a-f0-9]{64}$/);

    response = await request(baseUrl, '/gw/agent/identity/claim', {
      method: 'POST',
      json: { claim_token: claimToken },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.claim_token, claimToken);
    assert.match(response.body.claim.user_code, /^\d{6}$/);
    assert.notEqual(response.body.claim.user_code, userCode);

    const rotatedUserCode = response.body.claim.user_code;
    registrationSnapshot = __testing.getRegistrationSnapshotByClaimToken(claimToken);
    assert.equal(registrationSnapshot.hasPlaintextUserCode, false);
    assert.match(registrationSnapshot.userCodeHash, /^[a-f0-9]{64}$/);
    assert.equal(registrationSnapshot.retiredUserCodeHashCount, 1);

    response = await request(baseUrl, '/gw/agent/claim', {
      method: 'POST',
      form: { user_code: userCode },
    });
    assert.equal(response.status, 400);
    assert.match(response.contentType, /text\/html/);
    registrationSnapshot = __testing.getRegistrationSnapshotByClaimToken(claimToken);
    assert.equal(registrationSnapshot.status, 'pending');
    assert.equal(registrationSnapshot.invalidUserCodeAttempts, 1);
    userCode = rotatedUserCode;

    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: claimToken },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'authorization_pending');

    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: claimToken },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'slow_down');

    response = await request(baseUrl, '/gw/agent/claim');
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);

    response = await request(baseUrl, '/gw/agent/claim', {
      method: 'POST',
      form: { user_code: userCode },
    });
    assert.equal(response.status, 302);
    const authorizeUrl = new URL(response.location);
    assert.equal(authorizeUrl.origin, 'https://intervals.icu');
    assert.equal(authorizeUrl.pathname, '/oauth/authorize');
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'test-intervals-client');
    assert.equal(authorizeUrl.searchParams.get('scope'), AGENT_INTERVALS_READ_SCOPE);
    assert.doesNotMatch(authorizeUrl.searchParams.get('scope'), /WRITE/);

    const agentState = authorizeUrl.searchParams.get('state');
    response = await request(
      baseUrl,
      `/gw/agent/callback?code=mock-intervals-code&state=${encodeURIComponent(agentState)}`,
    );
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    assert.doesNotMatch(response.text, new RegExp(RAW_INTERVALS_TOKEN));

    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: claimToken },
    });
    assert.equal(response.status, 200);
    assert.match(response.body.access_token, new RegExp(`^${AGENT_TOKEN_PREFIX}`));
    assert.notEqual(response.body.access_token, RAW_INTERVALS_TOKEN);
    assert.equal(response.body.token_type, 'Bearer');
    assert.equal(response.body.scope, AGENT_AUTH_SCOPE);
    assert.equal(response.body.expires_in, 3600);
    assert.doesNotMatch(response.text, new RegExp(RAW_INTERVALS_TOKEN));

    const agentToken = response.body.access_token;

    response = await request(baseUrl, '/gw/api/me', { token: agentToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.user_id, '15487');
    assert.equal(response.body.auth_mode, 'agent');

    response = await request(baseUrl, '/gw/trainings?days=7', { token: agentToken });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, [{ id: 'training-1' }]);

    response = await request(baseUrl, '/gw/api/db/user_summary', { token: agentToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.summary, 'read-only');

    response = await request(baseUrl, '/gw/api/db/activity_detail?training_id=train-1', { token: agentToken });
    assert.equal(response.status, 200);
    assert.equal(response.body.activity, 'detail');

    response = await request(baseUrl, '/gw/icu/events?days=7', { token: agentToken });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, []);

    response = await request(baseUrl, '/gw/strategy', {
      method: 'POST',
      json: { save: true },
      token: agentToken,
    });
    assert.equal(response.status, 403);
    assert.equal(response.body.reason, 'agent_auth_read_only');

    response = await request(baseUrl, '/gw/api/db/profile_sections/preview', {
      method: 'POST',
      json: { section: 'rules' },
      token: agentToken,
    });
    assert.equal(response.status, 403);

    response = await request(baseUrl, '/gw/icu/events/test-event', {
      method: 'DELETE',
      token: agentToken,
    });
    assert.equal(response.status, 403);

    const rawFallbackHit = upstreamHits.find((hit) => {
      const authorization = hit.headers.Authorization || hit.headers.authorization || '';
      return authorization === `Bearer ${agentToken}`;
    });
    assert.equal(rawFallbackHit, undefined, 'agent token must not be sent to Intervals or STAS as raw bearer');

    response = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: { token: agentToken },
      token: agentToken,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);

    response = await request(baseUrl, '/gw/api/me', { token: agentToken });
    assert.equal(response.status, 401);

    response = await request(baseUrl, '/gw/oauth/revoke', {
      method: 'POST',
      json: { token: agentToken },
    });
    assert.equal(response.status, 200);

    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: claimToken },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_grant');

    response = await request(baseUrl, '/gw/agent/identity', {
      method: 'POST',
      json: { type: 'anonymous' },
    });
    assert.equal(response.status, 200);
    assert.equal(__testing.expireRegistrationByClaimToken(response.body.claim_token), true);

    const expiredClaimToken = response.body.claim_token;
    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: expiredClaimToken },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_grant');

    response = await request(baseUrl, '/gw/agent/identity', {
      method: 'POST',
      json: { type: 'anonymous' },
    });
    assert.equal(response.status, 200);
    const blockedClaimToken = response.body.claim_token;
    const retiredCode = response.body.claim.user_code;
    response = await request(baseUrl, '/gw/agent/identity/claim', {
      method: 'POST',
      json: { claim_token: blockedClaimToken },
    });
    assert.equal(response.status, 200);
    const activeCodeAfterRotation = response.body.claim.user_code;
    assert.notEqual(activeCodeAfterRotation, retiredCode);

    for (let i = 0; i < 3; i += 1) {
      response = await request(baseUrl, '/gw/agent/claim', {
        method: 'POST',
        form: { user_code: retiredCode },
      });
      assert.equal(response.status, 400);
      assert.match(response.contentType, /text\/html/);
    }
    registrationSnapshot = __testing.getRegistrationSnapshotByClaimToken(blockedClaimToken);
    assert.equal(registrationSnapshot.status, 'blocked');

    response = await request(baseUrl, '/gw/agent/claim', {
      method: 'POST',
      form: { user_code: activeCodeAfterRotation },
    });
    assert.equal(response.status, 400);

    response = await request(baseUrl, '/gw/oauth/token', {
      method: 'POST',
      json: { grant_type: AGENT_AUTH_GRANT_TYPE, claim_token: blockedClaimToken },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_grant');

    const tokenExchangeHit = upstreamHits.find((hit) => new URL(hit.url).pathname === '/api/oauth/token');
    assert.ok(tokenExchangeHit, 'expected mocked Intervals OAuth callback token exchange');

    const ensureHit = upstreamHits.find((hit) => new URL(hit.url).pathname === '/api/db/ensure-intervals-user');
    assert.ok(ensureHit, 'expected server-side STAS user resolution');

    const agentEventsHit = upstreamHits.find((hit) => new URL(hit.url).pathname === '/api/v1/athlete/0/events');
    assert.equal(agentEventsHit?.headers.Authorization, `Bearer ${RAW_INTERVALS_TOKEN}`);

    console.log('ok - agent auth flow, read-only guard, revoke, metadata, and raw-token safety');
  } finally {
    server.close();
    __testing.reset();
    global.fetch = originalFetch;
    restoreEnv();
  }
}

main().catch((error) => {
  global.fetch = originalFetch;
  restoreEnv();
  console.error(error);
  process.exit(1);
});
