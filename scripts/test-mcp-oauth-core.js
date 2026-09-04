const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  __testing: registrationTesting,
  readClientMetadata,
  redirectUriMatches,
} = require('../lib/mcp-client-registration');
const {
  __testing: tokenTesting,
  issueMcpTokens,
  refreshMcpTokens,
  resolveMcpAccessToken,
  revokeMcpToken,
} = require('../lib/mcp-oauth-tokens');

process.env.NODE_ENV = 'test';
process.env.OAUTH_STATE_SECRET = '0123456789abcdef0123456789abcdef';
process.env.GATEWAY_BASE_URL = 'https://intervals.stas.run';
process.env.MCP_RESOURCE_URL = 'https://stas.run/api/mcp';

const CIMD_URL = 'https://client.example/oauth/client.json';
const HOSTED_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const NATIVE_REGISTERED_CALLBACK = 'http://127.0.0.1:3030/oauth/callback?flow=mcp';
const NATIVE_RUNTIME_CALLBACK = 'http://127.0.0.1:49152/oauth/callback?flow=mcp';

function jsonResponse(body, options = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: options.status === undefined || (options.status >= 200 && options.status < 300),
    status: options.status || 200,
    headers: {
      get(name) {
        const normalized = String(name).toLowerCase();
        if (normalized === 'content-type') return options.contentType || 'application/json';
        if (normalized === 'content-length') return options.contentLength == null ? null : String(options.contentLength);
        return null;
      },
    },
    arrayBuffer: async () => Buffer.from(text),
  };
}

function cimdBody(overrides = {}) {
  return {
    client_id: CIMD_URL,
    client_name: 'Claude Desktop',
    redirect_uris: [HOSTED_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    ...overrides,
  };
}

async function testRegistration() {
  const modern = readClientMetadata({
    client_name: 'Claude',
    redirect_uris: [HOSTED_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    software_statement: 'unknown metadata must be ignored',
  });
  assert.equal(modern.ok, true);
  assert.deepEqual(modern.metadata.grantTypes, ['authorization_code', 'refresh_token']);

  const native = readClientMetadata({
    client_name: 'Claude Code',
    redirect_uris: [NATIVE_REGISTERED_CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  });
  assert.equal(native.ok, true);
  assert.equal(redirectUriMatches(NATIVE_REGISTERED_CALLBACK, NATIVE_RUNTIME_CALLBACK, 'native'), true);
  assert.equal(redirectUriMatches(NATIVE_REGISTERED_CALLBACK, 'http://127.0.0.1:49152/other', 'native'), false);
  assert.equal(redirectUriMatches(NATIVE_REGISTERED_CALLBACK, 'http://127.0.0.2:49152/oauth/callback?flow=mcp', 'native'), false);

  const nativeClaimedHttps = readClientMetadata({
    client_name: 'Native claimed HTTPS client',
    redirect_uris: ['https://native.example/oauth/callback'],
    application_type: 'native',
  });
  assert.equal(nativeClaimedHttps.ok, true);
  assert.equal(redirectUriMatches(
    'https://native.example/oauth/callback',
    'https://native.example/oauth/callback',
    'native',
  ), true);

  const tooManyRedirects = readClientMetadata({
    redirect_uris: Array.from({ length: 4 }, (_, index) => `https://client.example/callback/${index}`),
  });
  assert.equal(tooManyRedirects.ok, false);
  assert.equal(tooManyRedirects.reason, 'redirect_uris_too_many');

  for (const redirect of [
    'http://localhost:3030/oauth/callback',
    'http://10.0.0.4:3030/oauth/callback',
    'https://127.0.0.1/oauth/callback',
    'https://client.example/oauth/callback#fragment',
  ]) {
    const result = readClientMetadata({ redirect_uris: [redirect], application_type: 'native' });
    assert.equal(result.ok, false, redirect);
  }
}

async function testCimd() {
  for (const address of [
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::1',
    '2001:0000:4136:e378:8000:63bf:3fff:fdd2',
  ]) {
    assert.equal(registrationTesting.isPrivateAddress(address), true, address);
  }
  assert.equal(registrationTesting.isPrivateAddress('2606:2800:220:1:248:1893:25c8:1946'), false);

  registrationTesting.clearCimdCache();
  let fetchCount = 0;
  let pinnedAddress = null;
  const fetchImpl = async (_url, options) => {
    fetchCount += 1;
    options.agent.options.lookup('client.example', {}, (_error, address) => { pinnedAddress = address; });
    return jsonResponse(cimdBody());
  };
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const first = await registrationTesting.loadCimdClientMetadata(CIMD_URL, { lookup, fetchImpl });
  const second = await registrationTesting.loadCimdClientMetadata(CIMD_URL, { lookup, fetchImpl });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.source, 'cimd');
  assert.equal(fetchCount, 1, 'successful CIMD metadata should be cached');
  assert.equal(pinnedAddress, '93.184.216.34', 'fetch must be pinned to the DNS address already checked');

  const privateDns = await registrationTesting.loadCimdClientMetadata('https://private.example/client.json', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('must not fetch private address'); },
  });
  assert.equal(privateDns.ok, false);
  assert.equal(privateDns.reason, 'cimd_host_not_public');

  const mismatch = await registrationTesting.loadCimdClientMetadata('https://mismatch.example/client.json', {
    lookup,
    fetchImpl: async () => jsonResponse(cimdBody({ client_id: 'https://other.example/client.json' })),
  });
  assert.equal(mismatch.reason, 'client_id_self_reference_mismatch');

  const redirect = await registrationTesting.loadCimdClientMetadata('https://redirect.example/client.json', {
    lookup,
    fetchImpl: async () => jsonResponse('', { status: 302 }),
  });
  assert.equal(redirect.reason, 'cimd_fetch_failed');

  const wrongType = await registrationTesting.loadCimdClientMetadata('https://text.example/client.json', {
    lookup,
    fetchImpl: async () => jsonResponse(cimdBody(), { contentType: 'text/plain' }),
  });
  assert.equal(wrongType.reason, 'cimd_content_type_invalid');

  const tooLarge = await registrationTesting.loadCimdClientMetadata('https://large.example/client.json', {
    lookup,
    fetchImpl: async () => jsonResponse('{}', { contentLength: 70 * 1024 }),
  });
  assert.equal(tooLarge.reason, 'cimd_body_too_large');

  let producedChunks = 0;
  let streamDestroyed = false;
  const chunkedBody = new Readable({
    read() {
      producedChunks += 1;
      if (producedChunks <= 1000) this.push(Buffer.alloc(4096, 'x'));
      else this.push(null);
    },
    destroy(error, callback) {
      streamDestroyed = true;
      callback(error);
    },
  });
  const chunkedTooLarge = await registrationTesting.loadCimdClientMetadata('https://chunked-large.example/client.json', {
    lookup,
    fetchImpl: async () => ({
      ok: true,
      headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : null },
      body: chunkedBody,
      arrayBuffer: async () => { throw new Error('streaming body must not use arrayBuffer'); },
    }),
  });
  assert.equal(chunkedTooLarge.reason, 'cimd_body_too_large');
  assert.equal(streamDestroyed, true, 'oversized stream must be destroyed immediately');
  assert.ok(producedChunks < 1000, 'oversized stream must stop before the full chunked body is read');

  const timeout = await registrationTesting.loadCimdClientMetadata('https://timeout.example/client.json', {
    lookup,
    fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  });
  assert.equal(timeout.reason, 'cimd_fetch_failed');
}

async function testTokens() {
  tokenTesting.resetTokenStore();
  await assert.rejects(() => issueMcpTokens({
    subject: '15487', userId: 417, clientId: 'client-1',
    resource: 'https://stas.run/api/mcp', scopes: 'arbitrary:scope', allowRefresh: false,
  }), /invalid_mcp_token_scope/);
  const issued = await issueMcpTokens({
    subject: '15487',
    userId: 417,
    clientId: 'client-1',
    resource: 'https://stas.run/api/mcp',
    scopes: 'ACTIVITY:READ WELLNESS:READ',
    allowRefresh: true,
    clientName: 'Claude',
    clientHost: 'claude.ai',
  });
  assert.match(issued.access_token, /^stas_mcp_at_/);
  assert.match(issued.refresh_token, /^stas_mcp_rt_/);

  const valid = await resolveMcpAccessToken(issued.access_token);
  assert.equal(valid.matched, true);
  assert.equal(valid.auth.userId, '15487');
  assert.equal(valid.auth.athleteId, 417);
  assert.equal(valid.auth.source, 'mcp');
  assert.equal(valid.auth.clientHost, 'claude.ai');

  const wrongAudience = await resolveMcpAccessToken(issued.access_token, { resource: 'https://stas.run/api/other' });
  assert.equal(wrongAudience.matched, true);
  assert.equal(wrongAudience.auth, null);

  const malformed = await resolveMcpAccessToken('stas_mcp_at_not-a-jwt');
  assert.equal(malformed.matched, true);
  assert.equal(malformed.auth, null);

  const refreshed = await refreshMcpTokens(issued.refresh_token, {
    clientId: 'client-1',
    resource: 'https://stas.run/api/mcp',
  });
  assert.ok(refreshed);
  assert.equal(await refreshMcpTokens(issued.refresh_token, {
    clientId: 'client-1',
    resource: 'https://stas.run/api/mcp',
  }), null, 'refresh token replay must not mint a sibling token');
  assert.equal(await refreshMcpTokens(refreshed.refreshToken, {
    clientId: 'client-2',
    resource: 'https://stas.run/api/mcp',
  }), null, 'refresh token must stay bound to its client');

  await revokeMcpToken(refreshed.accessToken);
  const revoked = await resolveMcpAccessToken(refreshed.accessToken);
  assert.equal(revoked.matched, true);
  assert.equal(revoked.auth, null);
}

async function testProductionSecretFallback() {
  const before = {
    NODE_ENV: process.env.NODE_ENV,
    MCP_OAUTH_TOKEN_SECRET: process.env.MCP_OAUTH_TOKEN_SECRET,
    OAUTH_STATE_SECRET: process.env.OAUTH_STATE_SECRET,
    INTERVALS_CLIENT_SECRET: process.env.INTERVALS_CLIENT_SECRET,
  };
  process.env.NODE_ENV = 'production';
  delete process.env.MCP_OAUTH_TOKEN_SECRET;
  delete process.env.OAUTH_STATE_SECRET;
  process.env.INTERVALS_CLIENT_SECRET = 'production-compatible-intervals-secret-0123456789';
  tokenTesting.resetTokenStore();
  try {
    const issued = await issueMcpTokens({
      subject: 'prod-user', userId: 901, clientId: 'prod-client',
      resource: 'https://stas.run/api/mcp', scopes: ['ACTIVITY:READ'], allowRefresh: false,
    });
    assert.equal((await resolveMcpAccessToken(issued.access_token)).auth.userId, 'prod-user');
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testPgStoreContract() {
  const queries = [];
  const client = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (String(sql).startsWith('SELECT')) return { rows: [{
        access_token: 'sha256:old-access', refresh_token_hash: 'sha256:old-refresh', user_id: 7,
        scopes: ['ACTIVITY:READ'], access_jti: '00000000-0000-4000-8000-000000000001',
        client_id: 'client-7', access_expires_at: new Date(Date.now() + 1000),
        refresh_expires_at: new Date(Date.now() + 60_000), revoked_at: null,
      }] };
      if (String(sql).startsWith('UPDATE')) return { rowCount: 1, rows: [{ access_token: 'sha256:old-access' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const fakePool = { query: client.query, connect: async () => client };
  const store = new tokenTesting.PgTokenStore(fakePool);
  const nextDb = {
    accessTokenHash: 'sha256:new-access', refreshTokenHash: 'sha256:new-refresh', userId: 7,
    scopes: ['ACTIVITY:READ'], accessJti: '00000000-0000-4000-8000-000000000002', clientId: 'client-7',
    accessExpiresAt: new Date(Date.now() + 1000), refreshExpiresAt: new Date(Date.now() + 60_000),
  };
  await store.insert(nextDb);
  assert.match(queries[0].sql, /INSERT INTO gw_oauth_tokens/);
  assert.equal(queries[0].values[0], 'sha256:new-access');
  queries.length = 0;
  const rotated = await store.rotateRefresh('sha256:old-refresh', 'client-7', () => ({ db: nextDb, response: {} }));
  assert.ok(rotated);
  assert.deepEqual(queries.map(({ sql }) => String(sql).trim().split(/\s+/)[0]), ['BEGIN', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT']);
}

async function main() {
  await testRegistration();
  await testCimd();
  await testTokens();
  await testProductionSecretFallback();
  await testPgStoreContract();
  console.log('MCP OAuth core tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
