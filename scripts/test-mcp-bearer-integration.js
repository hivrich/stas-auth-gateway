const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.STAS_BASE = 'https://stas-backend.test';
process.env.STAS_KEY = 'test-stas-key';
process.env.GATEWAY_BASE_URL = 'https://intervals.stas.run';
process.env.MCP_RESOURCE_URL = 'https://stas.run/api/mcp';

const { createApp } = require('../server');
const { getMcpResource, issueMcpTokens, revokeMcpToken, __testing } = require('../lib/mcp-oauth-tokens');

async function main() {
  __testing.resetTokenStore();
  const upstreamCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('https://stas-backend.test/')) return originalFetch(url, init);
    upstreamCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      url: String(url),
      source: init.headers?.['x-stas-source'],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const issue = (scopes, resource = getMcpResource()) => issueMcpTokens({
    subject: 'i12345',
    userId: 42,
    clientId: 'integration-client',
    resource,
    scopes,
    allowRefresh: true,
  });

  try {
    const readToken = await issue(['ACTIVITY:READ']);
    const valid = await fetch(`${base}/gw/api/db/activity_detail?user_id=spoofed`, {
      headers: {
        authorization: `Bearer ${readToken.access_token}`,
        'x-stas-source': 'gpt',
      },
    });
    assert.equal(valid.status, 200);
    const validBody = await valid.json();
    assert.match(validBody.url, /user_id=i12345/);
    assert.doesNotMatch(validBody.url, /spoofed/);
    assert.equal(validBody.source, 'mcp');
    assert.equal(upstreamCalls.length, 1, 'one request reaches only the STAS DB proxy');
    assert.ok(!upstreamCalls.some((call) => call.url.includes('intervals.icu')), 'own bearer never calls Intervals');

    const forbidden = await fetch(`${base}/gw/api/db/calendar`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readToken.access_token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error, 'insufficient_scope');
    assert.equal(upstreamCalls.length, 1);

    const writeToken = await issue(['CALENDAR:WRITE']);
    const allowedWrite = await fetch(`${base}/gw/api/db/calendar`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writeToken.access_token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(allowedWrite.status, 200);
    assert.equal(upstreamCalls.length, 2);

    await revokeMcpToken(readToken.access_token);
    const revoked = await fetch(`${base}/gw/api/db/activity_detail`, {
      headers: { authorization: `Bearer ${readToken.access_token}` },
    });
    assert.equal(revoked.status, 401);

    const wrongAudience = await issue(['ACTIVITY:READ'], 'https://other.example/mcp');
    const wrongAud = await fetch(`${base}/gw/api/db/activity_detail`, {
      headers: { authorization: `Bearer ${wrongAudience.access_token}` },
    });
    assert.equal(wrongAud.status, 401);

    const malformed = await fetch(`${base}/gw/api/db/activity_detail`, {
      headers: { authorization: 'Bearer stas_mcp_at_not-a-jwt' },
    });
    assert.equal(malformed.status, 401);
    assert.equal(upstreamCalls.length, 2);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  console.log('MCP bearer integration tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
