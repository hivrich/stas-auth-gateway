const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

process.env.NODE_ENV = 'test';
process.env.INTERVALS_CLIENT_ID = 'diagnostic-secret-client';
process.env.INTERVALS_CLIENT_SECRET = 'diagnostic-secret-password';
process.env.STAS_BASE = 'http://stas.local.test';
process.env.STAS_KEY = 'diagnostic-secret-key';
process.env.OAUTH_RATE_LIMIT_MAX = '1000';
delete process.env.OAUTH_STATE_SECRET;
delete process.env.AGENT_AUTH_ENABLED;
delete process.env.ENABLE_LEGACY_STAS_ID_TOKEN_EXCHANGE;
delete process.env.LEGACY_STAS_ID_TOKEN_EXCHANGE_ENABLED;
const { createApp } = require('../server');
const { tokenIngress, markToken, tokenContext, REASONS } = require('../lib/oauth-token-diagnostics');
const { __testing: registration } = require('../lib/mcp-client-registration');
const { __testing: tokens } = require('../lib/mcp-oauth-tokens');
const { createPrivateKeyJwtVerifier } = require('../lib/mcp-private-key-jwt');
const fixture = require('./fixtures/private-key-jwt');
const originalFetch = global.fetch;
const signingKey = fixture.makeKey('diagnostic-secret-kid');
const wrongKey = fixture.makeKey('diagnostic-secret-wrong-kid');
const store = tokens.resetTokenStore();
const consume = store.consumeClientAssertion.bind(store);
const verifier = 'diagnostic-secret-verifier-012345678901234567890123';
const resource = 'https://stas.run/api/mcp';
const rawToken = 'diagnostic-secret-upstream-token';
const captured = [];
let upstreamMode = 'success';
let upstreamExchanges = 0;
let base;

global.fetch = async (url, options) => {
  const parsed = new URL(url);
  if (parsed.pathname === '/api/oauth/token' && parsed.hostname === 'intervals.icu') {
    upstreamExchanges++;
    if (upstreamMode === 'network') throw new Error('diagnostic-secret-network-message');
    return upstreamMode === 'reject'
      ? new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'diagnostic-secret-upstream-error' }), { status: 400 })
      : new Response(JSON.stringify({ access_token: rawToken }));
  }
  if (parsed.hostname === 'intervals.icu' && parsed.pathname === '/api/v1/athlete/0') {
    return new Response(JSON.stringify({ id: '15487', name: 'diagnostic-secret-user' }));
  }
  if (parsed.hostname === 'stas.local.test') return new Response(JSON.stringify({ ok: true, athleteId: 417 }));
  assert.equal(parsed.origin, base, 'tests must never make external requests');
  return originalFetch(url, options);
};

function configureMetadata(patch = {}, unavailable = false) {
  registration.setCimdOptions({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url) => {
      if (url !== fixture.CLIENT_ID && unavailable) throw new Error('diagnostic-secret-jwks-network');
      return new Response(JSON.stringify(url === fixture.CLIENT_ID ? fixture.metadata(patch) : { keys: [signingKey.jwk] }), { headers: { 'content-type': 'application/json' } });
    },
  });
}

async function capture(fn) {
  const originals = { log: console.log, error: console.error, warn: console.warn };
  const entries = [];
  for (const key of Object.keys(originals)) console[key] = (...args) => entries.push(args);
  try { return { result: await fn(), entries }; }
  finally { Object.assign(console, originals); captured.push(...entries); }
}

function assertEvents(entries, count = 1) {
  const ingress = entries.filter(([event]) => event === '[oauth][token][ingress]');
  const outcomes = entries.filter(([event]) => event === '[oauth][token][outcome]').map(([, text]) => JSON.parse(text));
  assert.equal(ingress.length, count);
  assert.equal(outcomes.length, count, 'exactly one terminal outcome per request');
  assert.equal(new Set(outcomes.map((item) => item.request_id)).size, count);
  for (const item of outcomes) {
    assert.equal(ingress.filter(([, text]) => JSON.parse(text).request_id === item.request_id).length, 1);
    assert.match(item.request_id, /^[a-f0-9-]{36}$/);
    assert.equal(item.path, '/gw/oauth/token');
    assert.equal(item.method, 'POST');
    assert.equal(item.stage, REASONS[item.reason]);
    assert.ok(['lt_100ms', 'lt_1s', 'lt_10s', 'gte_10s'].includes(item.duration));
    assert.deepEqual(Object.keys(item).sort(), ['request_id','method','path','content_type','stage','reason','grant','client_method','status','completion','duration'].sort());
  }
  return outcomes;
}

async function post(body, options = {}) {
  const result = await fetch(`${base}/gw/oauth/token?diagnostic-secret-query=value`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'diagnostic-secret-agent',
      'x-request-id': 'diagnostic-secret-injected-id', ...options.headers },
    body: options.raw ?? JSON.stringify(body),
  });
  return { status: result.status, body: await result.json() };
}

async function expect(body, reason, status = 400, options) {
  const { result, entries } = await capture(() => post(body, options));
  const [outcome] = assertEvents(entries);
  assert.equal(outcome.reason, reason);
  assert.equal(outcome.status, status);
  assert.equal(result.status, status);
  if (status === 401) assert.deepEqual(result.body, { error: 'invalid_client' });
  return result;
}

async function grant() {
  const query = new URLSearchParams({ response_type: 'code', client_id: fixture.CLIENT_ID,
    redirect_uri: fixture.CALLBACK, resource, scope: 'ACTIVITY:READ', state: 'diagnostic-secret-state',
    code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
  const start = await fetch(`${base}/gw/oauth/authorize?${query}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const { result: callback, entries } = await capture(() => fetch(`${base}/gw/oauth/callback?${new URLSearchParams({ state, code: 'diagnostic-secret-upstream-code' })}`, { redirect: 'manual' }));
  assert.equal(callback.status, 302);
  assert.deepEqual(JSON.parse(entries.find(([event]) => event === '[oauth][callback][complete]')[1]),
    { has_code: true, has_state: true, has_iss: true, destination: 'registered_client' });
  return { grant_type: 'authorization_code', code: new URL(callback.headers.get('location')).searchParams.get('code'),
    redirect_uri: fixture.CALLBACK, code_verifier: verifier, resource, ...fixture.assertionRequest(signingKey).body };
}

async function main() {
  configureMetadata();
  const server = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await expect({}, 'code_missing');
    await expect({ grant_type: 'diagnostic-secret-grant' }, 'code_missing');
    await expect({ grant_type: 'authorization_code', code: 'gpt_diagnostic-secret-missing' }, 'code_not_found');
    await expect({ code: 'diagnostic-secret-code', redirect_uri: 'https://diagnostic-secret.example/callback' }, 'source_unknown');
    await expect({ grant_type: 'refresh_token' }, 'refresh_missing');
    await expect({ grant_type: 'refresh_token', refresh_token: 'diagnostic-secret-refresh', resource: 'https://bad.example/mcp' }, 'resource_binding');
    await expect({ grant_type: 'refresh_token', refresh_token: 'diagnostic-secret-refresh', resource }, 'refresh_invalid');
    await expect({ code: 'c_diagnostic-secret-code' }, 'legacy_disabled');
    const malformed = await expect(null, 'body_rejected', 500, { raw: '{"diagnostic-secret-json":' });
    assert.deepEqual(malformed.body, { error: 'internal_error' }, 'parser HTTP behavior is unchanged');
    await expect(null, 'body_rejected', 500, { raw: JSON.stringify({ value: 'diagnostic-secret-large'.repeat(15000) }) });
    await expect({}, 'code_missing', 400, { headers: { 'content-type': 'text/diagnostic-secret-content-type' }, raw: 'diagnostic-secret-body' });
    await expect({}, 'code_missing', 400, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: 'grant_type=authorization_code' });
    const body = await grant();
    for (const [patch, reason, status = 400] of [
      [{ grant_type: 'diagnostic-secret-grant' }, 'grant_unsupported'],
      [{ redirect_uri: 'https://bad.example/callback' }, 'redirect_binding'],
      [{ client_id: 'diagnostic-secret-client-id' }, 'client_binding', 401],
      [{ resource: 'https://bad.example/mcp' }, 'resource_binding'],
      [{ code_verifier: 'wrong-verifier-012345678901234567890123456789' }, 'pkce_binding'],
      [{ client_assertion: undefined }, 'assertion_missing', 401],
      [{ client_assertion_type: 'diagnostic-secret-type' }, 'assertion_type', 401],
      [{ client_assertion: 'diagnostic-secret-assertion' }, 'assertion_malformed', 401],
      [{ client_secret: 'diagnostic-secret-password' }, 'client_mixed', 401],
    ]) await expect({ ...body, ...patch }, reason, status);
    const now = Math.floor(Date.now() / 1000);
    for (const [claims, reason] of [[{ iss: 'diagnostic-secret-iss' }, 'assertion_iss'], [{ sub: 'diagnostic-secret-sub' }, 'assertion_sub'],
      [{ aud: 'diagnostic-secret-aud' }, 'assertion_aud'], [{ exp: now - 40 }, 'assertion_time'], [{ iat: now + 60 }, 'assertion_time'],
      [{ nbf: now + 60 }, 'assertion_time'], [{ exp: now + 500 }, 'assertion_time'], [{ jti: undefined }, 'assertion_jti']]) {
      await expect({ ...body, ...fixture.assertionRequest(signingKey, claims).body }, reason, 401);
    }
    for (const [header, reason] of [[{ kid: '' }, 'assertion_kid'], [{ kid: 'diagnostic-secret-other' }, 'key_selection'],
      [{ typ: 'diagnostic-secret-type' }, 'assertion_header'], [{ jku: 'https://bad.example/key' }, 'assertion_header']]) {
      await expect({ ...body, ...fixture.assertionRequest(signingKey, {}, { header }).body }, reason, 401);
    }
    const unsigned = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${body.client_assertion.split('.')[1]}.`;
    await expect({ ...body, client_assertion: unsigned }, 'assertion_alg', 401);
    await expect({ ...body, ...fixture.assertionRequest(wrongKey, {}, { header: { kid: signingKey.jwk.kid } }).body }, 'signature_invalid', 401);
    assert.equal(store.assertions.size, 0);
    const successful = await expect(body, 'success', 200);
    // An omitted grant remains accepted on this existing bridge path.
    await expect({ ...await grant(), grant_type: undefined }, 'success', 200);
    await expect(body, 'code_not_found');
    const duplicate = await grant();
    await expect({ ...duplicate, client_assertion: body.client_assertion }, 'replay_duplicate', 401);
    store.consumeClientAssertion = async () => { throw new Error('diagnostic-secret-dsn-password'); };
    await expect(duplicate, 'replay_unavailable', 401);
    store.consumeClientAssertion = consume;
    await expect(duplicate, 'success', 200);
    const refresh = { grant_type: 'refresh_token', refresh_token: successful.body.refresh_token, resource, ...fixture.assertionRequest(signingKey).body };
    await expect(refresh, 'success', 200);
    const concurrent = await grant();
    store.consumeClientAssertion = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 50)); return consume(...args); };
    const before = upstreamExchanges;
    const batch = await capture(() => Promise.all(Array.from({ length: 6 }, () => post(concurrent))));
    const outcomes = assertEvents(batch.entries, 6);
    assert.equal(outcomes.filter((item) => item.reason === 'success').length, 1);
    assert.equal(outcomes.filter((item) => item.reason === 'code_reserved').length, 5);
    assert.equal(upstreamExchanges - before, 1);
    store.consumeClientAssertion = consume;
    for (const [mode, reason, status] of [['reject', 'upstream_rejected', 400], ['network', 'upstream_unavailable', 500]]) {
      upstreamMode = mode;
      await expect(await grant(), reason, status);
    }
    upstreamMode = 'success';
    const expiredReservation = await grant();
    const realNow = Date.now;
    store.consumeClientAssertion = async (...args) => { const result = await consume(...args); const later = realNow() + 11000; Date.now = () => later; return result; };
    try { await expect(expiredReservation, 'code_finalization'); }
    finally { Date.now = realNow; store.consumeClientAssertion = consume; }
    configureMetadata({ jwks_uri: 'https://keys.example/diagnostic-secret-unavailable' }, true);
    await expect(await grant(), 'jwks_unavailable', 401);
    configureMetadata({ token_endpoint_auth_method: 'none', jwks_uri: undefined });
    await expect({ ...refresh, ...fixture.assertionRequest(signingKey).body }, 'client_unresolved');

    // No duplicate outcome on finish+close, no caller-controlled correlation,
    // no log on non-token paths; diagnostic sink failures never block auth.
    const events = await capture(async () => {
      const req = { method: 'POST', originalUrl: '/gw/oauth/token?diagnostic-secret-query', headers: {} };
      const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
      tokenIngress(req, res, () => {}); tokenIngress(req, res, () => {});
      tokenContext(req, 'diagnostic-secret-grant', 'diagnostic-secret-method');
      markToken(req, 'diagnostic-secret-reason'); res.emit('finish'); res.emit('close');
    });
    assert.equal(assertEvents(events.entries)[0].reason, 'unexpected_error');
    const close = await capture(async () => {
      const res = Object.assign(new EventEmitter(), { statusCode: 200 });
      tokenIngress({ method: 'POST', url: '/gw/oauth/token', headers: {} }, res, () => {});
      res.emit('close'); res.emit('finish');
    });
    assert.equal(assertEvents(close.entries)[0].status, 0);
    const skipped = await capture(async () => {
      for (const [method, url] of [['GET', '/gw/oauth/token'], ['POST', '/gw/oauth/token-other'], ['POST', '/gw/oauth/revoke']]) {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        tokenIngress({ method, url, headers: {} }, res, () => {}); res.emit('finish');
      }
    });
    assert.equal(skipped.entries.length, 0);
    process.env.OAUTH_RATE_LIMIT_MAX = '1';
    const limited = await new Promise((resolve) => { const s = createApp().listen(0, '127.0.0.1', () => resolve(s)); });
    const normalBase = base;
    base = `http://127.0.0.1:${limited.address().port}`;
    try { await expect({}, 'code_missing'); await expect({}, 'rate_limited', 429); }
    finally { base = normalBase; await new Promise((resolve) => limited.close(resolve)); }
    const booleanVerifier = createPrivateKeyJwtVerifier({ consume: async () => true });
    assert.equal(await booleanVerifier(fixture.assertionRequest(signingKey), {
      clientId: fixture.CLIENT_ID, tokenEndpointAuthSigningAlg: 'RS256', jwks: { keys: [signingKey.jwk] },
    }, () => { throw new Error('diagnostic sink must not affect auth'); }), true);
    assert.equal(await booleanVerifier({ body: {} }, {
      clientId: fixture.CLIENT_ID,
    }, () => { throw new Error('diagnostic sink must not affect auth'); }), false);
    const log = console.log;
    console.log = () => { throw new Error('unavailable log sink'); };
    try {
      let continued = false;
      const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: true });
      tokenIngress({ method: 'POST', url: '/gw/oauth/token', headers: {} }, res, () => { continued = true; });
      res.emit('finish');
      assert.equal(continued, true);
    } finally { console.log = log; }
    const logText = JSON.stringify(captured);
    for (const secret of ['diagnostic-secret', 'https://', 'http://', 'client_assertion', 'code_verifier', signingKey.jwk.n,
      body.code, body.client_assertion, successful.body.access_token, successful.body.refresh_token]) assert.equal(logText.includes(secret), false, 'logs contain only enums and independent request IDs');
    console.log('OAuth token diagnostics: ingress, one terminal outcome, stage coverage, privacy and unchanged responses PASS');
  } finally {
    global.fetch = originalFetch;
    registration.setCimdOptions(null);
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
