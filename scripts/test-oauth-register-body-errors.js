const assert = require('node:assert/strict');
const util = require('node:util');

const OLD_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  INTERVALS_CLIENT_ID: process.env.INTERVALS_CLIENT_ID,
  INTERVALS_CLIENT_SECRET: process.env.INTERVALS_CLIENT_SECRET,
  OAUTH_RATE_LIMIT_MAX: process.env.OAUTH_RATE_LIMIT_MAX,
  STAS_BASE: process.env.STAS_BASE,
  STAS_KEY: process.env.STAS_KEY,
};

process.env.NODE_ENV = 'test';
process.env.INTERVALS_CLIENT_ID = 'test-intervals-client';
process.env.INTERVALS_CLIENT_SECRET = 'test-intervals-secret';
process.env.OAUTH_RATE_LIMIT_MAX = '1000';
process.env.STAS_BASE = 'http://stas.local.test';
process.env.STAS_KEY = 'test-stas-key';

const { createApp } = require('../server');

function restoreEnv() {
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  for (const [key, value] of Object.entries(original)) {
    console[key] = (...args) => lines.push(args);
  }
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, original);
  }
}

async function post(base, path, body, contentType = 'application/json') {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function main() {
  const server = await new Promise((resolve) => {
    const instance = createApp().listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const validMetadata = { redirect_uris: ['https://client.example/callback'] };
  const LEAK_MARKER = 'LEAKMARK7Q3Z';

  try {
    const cases = [
      {
        name: 'broken json',
        body: `{"redirect_uris":"${LEAK_MARKER}`,
        marker: LEAK_MARKER,
        expectedType: 'entity.parse.failed',
      },
      {
        name: 'json string',
        body: JSON.stringify(LEAK_MARKER),
        marker: LEAK_MARKER,
        expectedType: 'entity.parse.failed',
      },
      // A bare `null` body cannot carry a marker without becoming another case.
      { name: 'json null', body: 'null', marker: null, expectedType: 'entity.parse.failed' },
      {
        name: 'utf-16 malformed json',
        body: Buffer.from(`{"redirect_uris":"${LEAK_MARKER}`, 'utf16le'),
        marker: LEAK_MARKER,
        contentType: 'application/json; charset=utf-16',
        expectedType: 'entity.parse.failed',
        expectedStatus: 400,
      },
      {
        name: 'too large',
        body: Buffer.concat([Buffer.from(LEAK_MARKER), Buffer.alloc(300000, 0x20)]),
        marker: LEAK_MARKER,
        expectedType: 'entity.too.large',
        expectedStatus: 413,
      },
    ];

    for (const item of cases) {
      const captured = await captureConsole(async () => post(
        base,
        '/gw/oauth/register?query=ignored',
        item.body,
        item.contentType,
      ));
      const { lines } = captured;
      const response = captured.result;
      assert.equal(response.status, item.expectedStatus || 400, item.name);
      assert.deepEqual(response.body, {
        error: 'invalid_client_metadata',
        error_description: item.expectedType,
      }, item.name);

      const log = lines
        .filter(([event]) => event === '[http][unhandled_error]')
        .map(([, text]) => JSON.parse(text))
        .at(-1);
      assert.equal(log.status, item.expectedStatus || 400, item.name);
      assert.equal(log.category, 'body_rejected', item.name);
      assert.equal(log.body_error_type, item.expectedType, item.name);
      assert.equal(log.path, '/gw/oauth/register', item.name);
      // Search the raw log text: JSON.stringify would escape what the server
      // printed, and NUL bytes are dropped so a UTF-16LE body still matches.
      const rawLog = lines.map((args) => util.format(...args)).join('\n').replace(/\u0000/g, '');
      if (item.marker) {
        assert.equal(rawLog.includes(item.marker), false, `${item.name}: body is not logged`);
      }
    }

    const registered = await post(base, '/gw/oauth/register', JSON.stringify(validMetadata));
    assert.equal(registered.status, 201);
    assert.match(registered.body.client_id, /^stas_mcp_/);
    assert.deepEqual(registered.body.redirect_uris, validMetadata.redirect_uris);

    const pathMatching = await post(base, '/GW/OAuth/Register/?query=ignored', '{"redirect_uris":');
    assert.equal(pathMatching.status, 400);
    assert.equal(pathMatching.body.error_description, 'entity.parse.failed');

    const token = await post(base, '/gw/oauth/token', '{"grant_type":');
    assert.equal(token.status, 500);
    assert.deepEqual(token.body, { error: 'internal_error' });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    restoreEnv();
  }

  console.log('OAuth register body error tests passed');
}

main().catch((error) => {
  console.error(error);
  restoreEnv();
  process.exitCode = 1;
});
