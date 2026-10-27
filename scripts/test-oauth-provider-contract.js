// Independent provider model for the Kevin connection investigation.
// No live APIs or database: every non-loopback request is intercepted or denied.
// Intervals contract: https://forum.intervals.icu/t/intervals-icu-oauth-support/2759
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.NODE_ENV = 'test';
process.env.INTERVALS_CLIENT_ID = 'provider-contract-client';
process.env.INTERVALS_CLIENT_SECRET = 'provider-contract-secret';
process.env.STAS_BASE = 'http://stas.local.test';
process.env.STAS_KEY = 'provider-contract-key';
delete process.env.OAUTH_STATE_SECRET;
const oauth = require('../routes/oauth');
const { __testing: registration } = require('../lib/mcp-client-registration');
const { __testing: tokens } = require('../lib/mcp-oauth-tokens');
const fixture = require('./fixtures/private-key-jwt');
const signingKey = fixture.makeKey('provider-contract-key');
tokens.resetTokenStore();
registration.setCimdOptions({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  fetchImpl: async (url) => {
    assert.ok([fixture.CLIENT_ID, fixture.metadata().jwks_uri].includes(url));
    return Response.json(url === fixture.CLIENT_ID ? fixture.metadata() : { keys: [signingKey.jwk] });
  },
});

const originalFetch = global.fetch;
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const logs = [];
console.log = console.warn = console.error = (...args) => logs.push(args);
const codes = new Map();
const RESOURCE = 'https://stas.run/api/mcp';
const CALLBACK = 'https://intervals.stas.run/gw/oauth/callback';
let base;
let exchanges = 0;
let providerNow = 0;
const hash = (v) => crypto.createHash('sha256').update(v).digest('base64url');

global.fetch = async (url, options = {}) => {
  const target = new URL(url);
  if (target.origin === base) return originalFetch(url, options);
  if (target.origin === 'https://intervals.icu' && target.pathname === '/api/oauth/token') {
    exchanges++;
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(options.body);
    const record = codes.get(form.get('code'));
    let reason;
    if (!record || record.used) reason = 'unknown_or_used_code';
    else if (providerNow - record.issuedAt >= 120_000) reason = 'expired_code';
    else if (form.get('client_id') !== record.clientId || form.get('client_secret') !== 'provider-contract-secret') reason = 'client_mismatch';
    else if (form.get('redirect_uri') !== record.redirectUri) reason = 'redirect_mismatch';
    else if (record.challenge ? hash(form.get('code_verifier') || '') !== record.challenge : form.has('code_verifier')) reason = 'pkce_mismatch';
    if (reason) return Response.json({ error: 'invalid_grant', error_description: reason }, { status: 400 });
    record.used = true;
    return Response.json({ access_token: `test-provider-token-${record.id}`, token_type: 'Bearer' });
  }
  if (target.origin === 'https://intervals.icu' && target.pathname === '/api/v1/athlete/0') {
    return Response.json({ id: '731537', name: 'Synthetic OAuth athlete' });
  }
  if (target.origin === 'http://stas.local.test' && target.pathname === '/api/db/ensure-intervals-user') {
    return Response.json({ ok: true, athleteId: 2284, created: false });
  }
  if (target.origin === 'http://stas.local.test' && target.pathname === '/api/db/intervals-attempts') {
    return Response.json({ ok: true });
  }
  throw new Error('External request forbidden in provider contract test');
};

async function request(path, body) {
  const response = await fetch(base + path, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : { redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), body: await response.text() };
}

async function grant(client, verifier, options = {}) {
  const isChatGpt = client === 'chatgpt';
  let clientId = fixture.CLIENT_ID;
  let redirect = fixture.CALLBACK;
  if (!isChatGpt) {
    redirect = 'https://claude.ai/api/mcp/auth_callback';
    const registration = await request('/gw/oauth/register', {
      client_name: 'Claude contract test', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    assert.equal(registration.status, 201);
    clientId = JSON.parse(registration.body).client_id;
  }
  const state = crypto.randomUUID();
  const start = await request('/gw/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirect, state,
    resource: RESOURCE, scope: 'ACTIVITY:READ', code_challenge: hash(verifier), code_challenge_method: 'S256',
  }));
  assert.equal(start.status, 302);
  const upstream = new URL(start.location);
  assert.equal(upstream.origin, 'https://intervals.icu');
  assert.equal(upstream.pathname, '/oauth/authorize');
  assert.equal(upstream.searchParams.get('client_id'), 'provider-contract-client');
  assert.equal(upstream.searchParams.get('redirect_uri'), CALLBACK);
  assert.equal(upstream.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(upstream.searchParams.get('code_challenge'), hash(verifier));
  const code = crypto.randomUUID();
  codes.set(code, {
    id: code, clientId: upstream.searchParams.get('client_id'),
    redirectUri: upstream.searchParams.get('redirect_uri'),
    challenge: options.dropProviderChallenge ? null : upstream.searchParams.get('code_challenge'),
    issuedAt: providerNow, used: false,
  });
  const callback = await request('/gw/oauth/callback?' + new URLSearchParams({
    state: upstream.searchParams.get('state'), code,
  }));
  assert.equal(callback.status, 302);
  const result = new URL(callback.location);
  assert.equal(result.searchParams.get('state'), state);
  assert.equal(result.searchParams.get('iss'), 'https://intervals.stas.run');
  const common = { grant_type: 'authorization_code', client_id: clientId,
    redirect_uri: redirect, code: result.searchParams.get('code'), code_verifier: verifier, resource: RESOURCE };
  return () => ({ ...common, ...(isChatGpt ? fixture.assertionRequest(signingKey).body : {}) });
}

function lastOutcome() {
  return JSON.parse(logs.filter(([event]) => event === '[oauth][token][outcome]').at(-1)[1]);
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/gw', oauth);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const passed = [];
  try {
    for (const client of ['chatgpt', 'claude']) {
      for (const length of [43, 64, 96, 128]) {
        const verifier = ('Az09-._~' + crypto.randomBytes(96).toString('base64url')).slice(0, length);
        assert.equal(verifier.length, length);
        const body = await grant(client, verifier);
        const response = await request('/gw/oauth/token', body());
        assert.equal(response.status, 200);
        assert.match(JSON.parse(response.body).access_token, /^stas_mcp_at_/);
        assert.equal(lastOutcome().reason, 'success');
        passed.push(`${client}: valid PKCE length ${length}`);
      }
      const independent = await Promise.all(Array.from({ length: 2 }, () =>
        grant(client, crypto.randomBytes(32).toString('base64url'))));
      const independentResults = await Promise.all(independent.reverse().map((body) => request('/gw/oauth/token', body())));
      assert.deepEqual(independentResults.map((r) => r.status), [200, 200]);
      assert.notEqual(JSON.parse(independentResults[0].body).access_token, JSON.parse(independentResults[1].body).access_token);
      passed.push(`${client}: independent overlapping sessions keep separate code/verifier bindings`);
      const verifier = crypto.randomBytes(32).toString('base64url');
      const corrected = await grant(client, verifier);
      let before = exchanges;
      assert.equal((await request('/gw/oauth/token', { ...corrected(), code_verifier: 'x'.repeat(43) })).status, 400);
      assert.equal(lastOutcome().reason, 'pkce_binding');
      assert.equal(exchanges, before);
      assert.equal((await request('/gw/oauth/token', corrected())).status, 200);
      passed.push(`${client}: wrong verifier rejected locally; correct retry succeeds`);

      const concurrent = await grant(client, verifier);
      before = exchanges;
      const results = await Promise.all([request('/gw/oauth/token', concurrent()), request('/gw/oauth/token', concurrent())]);
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
      assert.equal(exchanges - before, 1);
      passed.push(`${client}: concurrent exchange sends exactly one upstream request`);

      const expired = await grant(client, verifier);
      providerNow += 121_000; // Only provider clock moves; no sleeping or global Date patch.
      const expiredResult = await request('/gw/oauth/token', expired());
      assert.equal(expiredResult.status, 400);
      assert.equal(JSON.parse(expiredResult.body).error_description, 'expired_code');
      assert.equal(lastOutcome().reason, 'upstream_rejected');
      before = exchanges;
      assert.equal((await request('/gw/oauth/token', expired())).status, 400);
      assert.equal(lastOutcome().reason, 'code_not_found');
      assert.equal(exchanges, before);
      passed.push(`${client}: provider code expires after 120s while bridge still accepts it`);

      const lostChallenge = await grant(client, verifier, { dropProviderChallenge: true });
      const lostResult = await request('/gw/oauth/token', lostChallenge());
      assert.equal(lostResult.status, 400);
      assert.equal(JSON.parse(lostResult.body).error_description, 'pkce_mismatch');
      assert.equal(lastOutcome().reason, 'upstream_rejected');
      passed.push(`${client}: provider losing challenge produces the same generic logged failure`);
    }
    originalLog(JSON.stringify({ passed: passed.length, scenarios: passed, upstreamExchanges: exchanges }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

main().catch((error) => { originalError(error); process.exitCode = 1; });
