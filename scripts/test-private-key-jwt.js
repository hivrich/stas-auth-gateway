const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createPrivateKeyJwtVerifier } = require('../lib/mcp-private-key-jwt');
const { readClientMetadata, normalizePublicJwks, fetchPublicJson } = require('../lib/mcp-client-registration');
const { __testing: tokenTesting } = require('../lib/mcp-oauth-tokens');
const { CLIENT_ID, JWKS_URI, makeKey, metadata, assertionRequest } = require('./fixtures/private-key-jwt');

process.env.NODE_ENV = 'test';
process.env.GATEWAY_BASE_URL = 'https://intervals.stas.run';
const key = makeKey();
const rotated = makeKey('rotated-key');
const client = readClientMetadata(metadata(), { expectedClientId: CLIENT_ID }).metadata;
const inlineClient = { ...client, jwksUri: undefined, jwks: { keys: [key.jwk] } };
const fixedNow = 2_000_000_000_000;

function verifier(options = {}) {
  const store = new tokenTesting.MemoryTokenStore();
  return createPrivateKeyJwtVerifier({ now: () => fixedNow, consume: store.consumeClientAssertion.bind(store), ...options });
}
function request(claims = {}, options = {}) {
  return assertionRequest(key, claims, { now: fixedNow, ...options });
}

test('ChatGPT-shaped CIMD retains key auth and sanitized key source; DCR does not issue a secret', () => {
  assert.equal(client.tokenEndpointAuthMethod, 'private_key_jwt');
  assert.equal(client.tokenEndpointAuthSigningAlg, 'RS256');
  assert.equal(client.jwksUri, JWKS_URI);
  assert.equal(readClientMetadata(metadata()).ok, false);
  assert.equal(readClientMetadata(metadata({ jwks_uri: undefined, jwks: { keys: [key.jwk] } }), { expectedClientId: CLIENT_ID }).ok, true);
  for (const overrides of [
    { jwks_uri: undefined }, { jwks: { keys: [key.jwk] } },
    { jwks_uri: 'http://keys.example/jwks' }, { jwks_uri: 'https://127.0.0.1/keys' },
    { jwks_uri: 'https://user:password@keys.example/jwks' }, { jwks_uri: 'https://keys.example/jwks#part' },
    { jwks_uri: ['https://keys.example/jwks'] }, { token_endpoint_auth_signing_alg: 'HS256' },
    { token_endpoint_auth_method: 'client_secret_post' },
  ]) assert.equal(readClientMetadata(metadata(overrides), { expectedClientId: CLIENT_ID }).ok, false);
});

test('JWKS accepts only bounded, unambiguous, strong public RSA verification keys', () => {
  const weak = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  for (const bad of [
    null, { keys: [] }, { keys: Array(9).fill(key.jwk) }, { keys: [key.jwk, key.jwk] },
    ...[{ d: 'private' }, { p: 'private' }, { k: 'secret' }, { kty: 'oct' }, { use: 'enc' },
      { alg: 'HS256' }, { key_ops: ['sign'] }, { key_ops: ['verify', 'sign'] },
      { n: 'invalid' }, { e: 'Aw' }, { kid: '' }, { kid: [] }, weak]
      .map((patch) => ({ keys: [{ ...key.jwk, ...patch }] })),
    { keys: [key.jwk, { ...rotated.jwk, kid: undefined }] },
  ]) assert.equal(normalizePublicJwks(bad), null);
  assert.equal(normalizePublicJwks({ keys: [{ ...key.jwk, x5u: 'https://ignored.example/key' }] }).keys[0].x5u, undefined);
});

test('valid signature succeeds, same verified JTI fails across verifier recreation and concurrent requests', async () => {
  const store = new tokenTesting.MemoryTokenStore();
  const options = { consume: store.consumeClientAssertion.bind(store) };
  const req = request();
  assert.equal(await verifier(options)(req, inlineClient), true);
  assert.equal(await verifier(options)(req, inlineClient), false);
  const concurrent = request();
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => verifier(options)(concurrent, inlineClient)));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal([...store.assertions.keys()].every((hash) => /^[a-f0-9]{64}$/.test(hash)), true);
});

test('replay storage failure is fail closed and expired records are cleaned', async () => {
  assert.equal(await verifier({ consume: async () => { throw new Error('database unavailable'); } })(request(), inlineClient), false);
  const store = new tokenTesting.MemoryTokenStore();
  await store.consumeClientAssertion('old', new Date(fixedNow - 1), new Date(fixedNow - 10));
  await store.consumeClientAssertion('new', new Date(fixedNow + 1000), new Date(fixedNow));
  assert.equal(store.assertions.has('old'), false);
});

test('signature preparation does not consume JTI; consumption can retry after a certain store failure', async () => {
  let attempts = 0;
  const store = new tokenTesting.MemoryTokenStore();
  const verify = verifier({ consume: async (...args) => {
    attempts += 1;
    if (attempts === 1) throw new Error('store temporarily unavailable before insert');
    return store.consumeClientAssertion(...args);
  } });
  const req = request();
  const prepared = await verify.prepare(req, inlineClient);
  assert.equal(typeof prepared, 'function');
  assert.equal(attempts, 0);
  assert.equal(await prepared(), false);
  assert.equal(await verify(req, inlineClient), true);
  assert.equal(await verify(req, inlineClient), false);
});

test('signature, key ID, critical headers, and algorithm confusion fail', async () => {
  const verify = verifier();
  for (const req of [
    assertionRequest(rotated, {}, { now: fixedNow, header: { kid: key.jwk.kid } }),
    request({}, { header: { kid: 'wrong' } }), request({}, { header: { jku: 'https://evil.example/jwks' } }),
    request({}, { header: { crit: ['extension'] } }), request({}, { header: { typ: 'other' } }),
  ]) assert.equal(await verify(req, inlineClient), false);
  const unsigned = request();
  unsigned.body.client_assertion = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${unsigned.body.client_assertion.split('.')[1]}.`;
  assert.equal(await verify(unsigned, inlineClient), false);
  assert.equal(await verify(request({}, { header: { kid: undefined } }), inlineClient), true);
  assert.equal(await verify(request({}, { header: { kid: undefined } }), { ...inlineClient, jwks: { keys: [key.jwk, rotated.jwk] } }), false);
});

test('issuer, subject, exact audience, expiry, not-before, issued-at and mandatory JTI checked before network', async () => {
  let fetches = 0;
  const verify = verifier({ fetchJson: async () => { fetches += 1; return { ok: true, body: { keys: [key.jwk] } }; } });
  const now = fixedNow / 1000;
  for (const claims of [
    { iss: 'https://other.example/client' }, { sub: 'other' }, { iss: undefined }, { sub: undefined },
    { aud: 'https://intervals.stas.run/gw/oauth/token/extra' }, { aud: 'https://intervals.stas.run' }, { aud: undefined },
    { exp: now - 31 }, { exp: undefined }, { exp: now + 301 }, { exp: now },
    { iat: now + 31 }, { iat: undefined }, { iat: now - 400, exp: now - 200 },
    { nbf: now + 31 }, { nbf: now + 120 }, { jti: undefined }, { jti: '' }, { jti: 123 }, { jti: 'a'.repeat(257) },
  ]) assert.equal(await verify(request(claims), client), false, JSON.stringify(claims));
  assert.equal(fetches, 0);
});

test('client ID and assertion type are exact, mixed authentication and malformed assertions fail', async () => {
  for (const patch of [
    { client_id: 'other' }, { client_id: undefined }, { client_id: [CLIENT_ID] },
    { client_assertion_type: undefined }, { client_assertion_type: 'jwt-bearer' },
    { client_assertion: undefined }, { client_assertion: 'invalid' }, { client_assertion: [] },
    { client_assertion: 'x'.repeat(17000) }, { client_secret: '' },
  ]) {
    const req = request();
    Object.assign(req.body, patch);
    assert.equal(await verifier()(req, inlineClient), false);
  }
  const req = request();
  req.headers.authorization = 'Basic dGVzdDp0ZXN0';
  assert.equal(await verifier()(req, inlineClient), false);
});

test('key cache single-flight, bounded rotation refresh, TTL, and negative caching', async () => {
  let now = fixedNow;
  let fetches = 0;
  let keys = [key.jwk];
  const verify = verifier({ now: () => now, fetchJson: async () => { fetches += 1; return { ok: true, body: { keys } }; } });
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => verify(request(), client))), Array(10).fill(true));
  assert.equal(fetches, 1);
  keys = [rotated.jwk];
  const next = () => assertionRequest(rotated, {}, { now });
  assert.equal(await verify(next(), client), false);
  assert.equal(fetches, 1);
  now += 61_000;
  assert.equal(await verify(next(), client), true);
  assert.equal(fetches, 2);
  for (let i = 0; i < 20; i += 1) assert.equal(await verify(request({}, { now, header: { kid: `random-${i}` } }), client), false);
  assert.equal(fetches, 2);
  now += 301_000;
  assert.equal(await verify(next(), client), true);
  assert.equal(fetches, 3);
  now += 301_000;
  keys = [];
  assert.equal(await verify(next(), client), false);
  assert.equal(await verify(next(), client), false);
  assert.equal(fetches, 4);
});

test('same kid key rotation is refreshed once after cooldown', async () => {
  let now = fixedNow;
  let keys = [key.jwk];
  let fetches = 0;
  const verify = verifier({ now: () => now, fetchJson: async () => { fetches += 1; return { ok: true, body: { keys } }; } });
  assert.equal(await verify(request(), client), true);
  now += 61_000;
  keys = [{ ...rotated.jwk, kid: key.jwk.kid }];
  assert.equal(await verify(assertionRequest(rotated, {}, { now, header: { kid: key.jwk.kid } }), client), true);
  assert.equal(fetches, 2);
});

test('in-flight and cache capacity stay bounded without evicting live cooldowns', async () => {
  let finish;
  let fetches = 0;
  const hold = new Promise((resolve) => { finish = resolve; });
  const verify = verifier({ fetchJson: async () => { fetches += 1; await hold; return { ok: true, body: { keys: [key.jwk] } }; } });
  const pending = Array.from({ length: 16 }, (_, i) => verify(request(), { ...client, jwksUri: `https://keys.example/${i}` }));
  assert.equal(await verify(request(), { ...client, jwksUri: 'https://keys.example/overflow' }), false);
  assert.equal(fetches, 16);
  finish();
  assert.equal((await Promise.all(pending)).every(Boolean), true);
  for (let i = 16; i < 256; i += 1) assert.equal(await verify(request(), { ...client, jwksUri: `https://keys.example/${i}` }), true);
  assert.equal(await verify(request(), { ...client, jwksUri: 'https://keys.example/overflow' }), false);
  assert.equal(fetches, 256);
  assert.equal(await verify(request({}, { header: { kid: 'random' } }), { ...client, jwksUri: 'https://keys.example/0' }), false);
  assert.equal(fetches, 256);
});

test('JWKS network failures, unsafe DNS, redirects, MIME, bounded body, pinned lookup', async () => {
  const url = new URL(JWKS_URI);
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  let requests = 0;
  const fetchImpl = async (_url, options) => {
    requests += 1;
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal instanceof AbortSignal, true);
    await new Promise((resolve, reject) => options.agent.options.lookup(url.hostname, {}, (error, address) => {
      if (error) return reject(error);
      assert.equal(address, '93.184.216.34'); resolve();
    }));
    return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { 'content-type': 'application/json' } });
  };
  assert.equal((await fetchPublicJson(url, { lookup, fetchImpl })).ok, true);
  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await fetchPublicJson(url, { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], fetchImpl })).ok, false);
  }
  assert.equal(requests, 1);
  for (const response of [
    new Response('', { status: 302, headers: { location: 'https://127.0.0.1/keys' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'application/jsonx' } }),
    new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } }),
    { ok: true, headers: { get: (name) => name === 'content-type' ? 'application/json' : null }, body: Readable.from([Buffer.alloc(65537)]) },
  ]) assert.equal((await fetchPublicJson(url, { lookup, fetchImpl: async () => response })).ok, false);
  assert.equal((await fetchPublicJson(url, { lookup, fetchImpl: async () => { throw new Error('network'); } })).ok, false);
});
