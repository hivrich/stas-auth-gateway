const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CATALOG_QUERY, runReadiness } = require('./check-oauth-replay-readiness');
const { matchesSigningMetadata, checkDiscovery } = require('./check-private-key-jwt-discovery');

const ready = Object.fromEntries(['present', 'plain_table', 'schema_usage', 'can_select', 'can_insert', 'can_delete', 'can_lock',
  'expected_columns', 'hash_column', 'expiry_column', 'hash_primary_key', 'expiry_index'].map((key) => [key, true]));

test('readiness is catalog-only and checks runtime role permissions and schema essentials', async () => {
  for (const missing of [null, ...Object.keys(ready)]) {
    const queries = [];
    const lines = [];
    const status = await runReadiness({ connectionString: 'postgresql://runtime:SECRET@db/stas', log: (line) => lines.push(line),
      clientFactory: (config) => {
        assert.match(config.options, /default_transaction_read_only=on/);
        return { connect: async () => {}, end: async () => {}, query: async (query) => {
          queries.push(query); return { rows: [{ ...ready, ...(missing ? { [missing]: false } : {}) }] };
        } };
      },
    });
    assert.equal(status, missing ? 1 : 0, missing || 'ready');
    assert.deepEqual(queries, ['BEGIN READ ONLY', CATALOG_QUERY, 'ROLLBACK']);
    assert.equal(lines.join('').includes('SECRET'), false);
    assert.equal(lines.join('').includes('postgresql:'), false);
  }
});

test('missing configuration and DB errors fail safely without DSN/server error output', async () => {
  const lines = [];
  assert.equal(await runReadiness({ connectionString: '', log: (line) => lines.push(line) }), 1);
  assert.equal(await runReadiness({ connectionString: 'postgresql://runtime:SECRET@db/stas', log: (line) => lines.push(line),
    clientFactory: () => ({ connect: async () => { throw new Error('postgresql://runtime:SECRET@db/stas unsafe server detail'); }, end: async () => {} }),
  }), 1);
  assert.deepEqual(lines, ['[oauth-readiness] database_config_missing', '[oauth-readiness] database_unavailable']);
});

const issuer = 'https://intervals.stas.run';
const resource = 'https://stas.run/api/mcp';
const metadata = { issuer, token_endpoint: `${issuer}/gw/oauth/token`, token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] };
const protectedMetadata = { resource, authorization_servers: [issuer] };

test('metadata parser requires real structured signing capability, exact issuer/token URL and RS256', () => {
  assert.equal(matchesSigningMetadata(metadata, issuer), true);
  for (const invalid of [null, 'private_key_jwt RS256', {},
    { ...metadata, issuer: 'https://wrong.example' }, { ...metadata, token_endpoint: `${issuer}/other` },
    { ...metadata, token_endpoint_auth_methods_supported: 'private_key_jwt' },
    { ...metadata, token_endpoint_auth_methods_supported: ['none'] },
    { ...metadata, token_endpoint_auth_signing_alg_values_supported: 'RS256' },
    { ...metadata, token_endpoint_auth_signing_alg_values_supported: ['HS256'] },
    { ...metadata, token_endpoint_auth_signing_alg_values_supported: ['RS256', 'HS256'] },
  ]) assert.equal(Boolean(matchesSigningMetadata(invalid, issuer)), false);
});

test('postcheck checks both public AS endpoints and protected-resource linkage; malformed/missing fails', async () => {
  const urls = [`${issuer}/.well-known/oauth-authorization-server`, 'https://stas.run/.well-known/oauth-authorization-server',
    'https://stas.run/.well-known/oauth-protected-resource/api/mcp'];
  for (const badIndex of [-1, 0, 1, 2]) {
    const seen = [];
    const result = await checkDiscovery({ issuer, resource, fetcher: async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, 'error');
      const index = urls.indexOf(url);
      assert.notEqual(index, -1);
      return new Response(JSON.stringify(index === badIndex ? {} : index === 2 ? protectedMetadata : metadata), { headers: { 'content-type': 'application/json' } });
    } });
    assert.equal(Boolean(result), badIndex === -1);
    assert.deepEqual(seen, urls);
  }
  for (const body of ['not json', JSON.stringify('private_key_jwt RS256'), 'x'.repeat(65537)]) {
    assert.equal(await checkDiscovery({ issuer, resource, fetcher: async () => new Response(body, { headers: { 'content-type': 'application/json' } }) }), false);
  }
});

test('executable workflow gates the pinned candidate before replacement and checks metadata after health', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-release-test-'));
  const bin = path.join(directory, 'bin');
  const eventsFile = path.join(directory, 'events');
  fs.mkdirSync(bin);
  const stub = `#!/usr/bin/env -S node --
const fs = require('node:fs'); const path = require('node:path');
const name = path.basename(process.argv[1]); const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_EVENTS, JSON.stringify([name, ...args]) + '\\n');
const id = 'sha256:' + 'a'.repeat(64);
if (name === 'curl') process.exit(process.env.TEST_FAILURE === 'health' ? 1 : 0);
if (args.includes('--format') && args.includes('json')) console.log(JSON.stringify({name:'stas',services:{'bridge-api':{}}}));
else if (args.includes('--hash')) console.log('bridge-api fixed-config-hash');
else if (args.includes('inspect')) console.log(id);
else if (args.includes('ps')) console.log('test-container');
if (args.some(x => x.endsWith('/check-oauth-replay-readiness.js')) && process.env.TEST_FAILURE === 'database') process.exit(1);
if (args.some(x => x.endsWith('/check-private-key-jwt-discovery.js')) && process.env.TEST_FAILURE === 'metadata') process.exit(1);
`;
  try {
    for (const name of ['docker', 'curl']) fs.writeFileSync(path.join(bin, name), stub, { mode: 0o700 });
    for (const failure of ['', 'database', 'health', 'metadata']) {
      fs.writeFileSync(eventsFile, '');
      const result = spawnSync('bash', [path.join(__dirname, 'deploy-prod-gateway.sh'), '--apply'], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STAS_APP_DIR: directory,
          STAS_DEPLOY_LOCK_FILE: path.join(directory, 'lock'), TEST_EVENTS: eventsFile, TEST_FAILURE: failure },
      });
      assert.equal(result.status, failure ? 1 : 0, result.stderr);
      const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse);
      const readiness = events.findIndex((entry) => entry.some((arg) => arg.endsWith('/check-oauth-replay-readiness.js')));
      const replacement = events.findIndex((entry) => entry.includes('up'));
      const health = events.findIndex((entry) => entry[0] === 'curl');
      const postcheck = events.findIndex((entry) => entry.some((arg) => arg.endsWith('/check-private-key-jwt-discovery.js')));
      assert.ok(readiness >= 0);
      const gate = events[readiness];
      assert.ok(gate.includes('run') && gate.includes('--no-deps') && gate.includes('--entrypoint'));
      assert.equal(gate.at(-2), 'bridge-api');
      if (failure === 'database') { assert.equal(replacement, -1); assert.equal(health, -1); }
      else {
        assert.ok(replacement > readiness);
        assert.ok(events[replacement].includes('--no-build'));
        assert.ok(events[replacement].includes(gate[gate.lastIndexOf('--file') + 1]), 'same pinned override');
        assert.ok(health > replacement);
        if (failure === 'health') assert.equal(postcheck, -1);
        else assert.ok(postcheck > health);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
