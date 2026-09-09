// Run only against a disposable local database named oauth_replay_test.
// Pass the app's additive replay migration as argv[2]. Never use STAS_PGURL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Pool } = require('pg');
const { __testing: tokenTesting } = require('../lib/mcp-oauth-tokens');
const { createPrivateKeyJwtVerifier } = require('../lib/mcp-private-key-jwt');
const { readClientMetadata } = require('../lib/mcp-client-registration');
const { CLIENT_ID, metadata, makeKey, assertionRequest } = require('./fixtures/private-key-jwt');
const { runReadiness } = require('./check-oauth-replay-readiness');

async function main() {
  const url = new URL(process.env.OAUTH_REPLAY_TEST_DATABASE_URL || '');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/oauth_replay_test');
  assert.equal(url.search, '');
  assert.ok(process.argv[2], 'Pass the app replay-table migration.sql');
  const pool = new Pool({ connectionString: url.toString(), max: 12 });
  try {
    const existing = await pool.query("SELECT to_regclass('public.gw_oauth_client_assertions') AS present");
    assert.equal(existing.rows[0].present, null, 'Use a new disposable database');
    const readinessLogs = [];
    const readinessOptions = { connectionString: url.toString(), log: (line) => readinessLogs.push(line) };
    assert.equal(await runReadiness(readinessOptions), 1, 'Missing real table fails readiness');
    await pool.query(fs.readFileSync(process.argv[2], 'utf8'));
    assert.equal(await runReadiness(readinessOptions), 0);
    await pool.query('CREATE ROLE oauth_replay_runtime LOGIN');
    const runtimeUrl = new URL(url);
    runtimeUrl.username = 'oauth_replay_runtime';
    const runtimeReadiness = { ...readinessOptions, connectionString: runtimeUrl.toString() };
    assert.equal(await runReadiness(runtimeReadiness), 1, 'Actual non-owner without privileges fails');
    await pool.query('GRANT SELECT, INSERT, DELETE, UPDATE ON gw_oauth_client_assertions TO oauth_replay_runtime');
    assert.equal(await runReadiness(runtimeReadiness), 0, 'Actual non-owner with runtime privileges passes');
    await pool.query('REVOKE DELETE ON gw_oauth_client_assertions FROM oauth_replay_runtime');
    assert.equal(await runReadiness(runtimeReadiness), 1, 'Actual privilege revocation fails');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM gw_oauth_client_assertions')).rows[0].count, 0, 'Readiness never creates or deletes rows');
    assert.equal(readinessLogs.join('').includes('postgresql:'), false);
    const key = makeKey();
    const client = readClientMetadata(metadata({ jwks_uri: undefined, jwks: { keys: [key.jwk] } }), { expectedClientId: CLIENT_ID }).metadata;
    const makeVerifier = () => {
      const store = new tokenTesting.PgTokenStore(pool);
      return createPrivateKeyJwtVerifier({ consume: store.consumeClientAssertion.bind(store) });
    };
    const same = assertionRequest(key);
    const results = await Promise.all(Array.from({ length: 12 }, () => makeVerifier()(same, client)));
    assert.equal(results.filter(Boolean).length, 1, 'Atomic one winner across independent validators');
    assert.equal(await makeVerifier()(same, client), false, 'Replay survives verifier/store recreation');
    const records = await pool.query('SELECT * FROM gw_oauth_client_assertions');
    assert.equal(records.rowCount, 1);
    assert.match(records.rows[0].assertion_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(records.rows[0]).sort(), ['assertion_hash', 'expires_at']);
    await pool.query(`INSERT INTO gw_oauth_client_assertions SELECT lpad(i::text,64,'0'), NOW() - INTERVAL '1 hour' FROM generate_series(1,250) i`);
    assert.equal(await makeVerifier()(assertionRequest(key), client), true);
    const afterCleanup = await pool.query('SELECT COUNT(*)::int AS count FROM gw_oauth_client_assertions WHERE expires_at < NOW()');
    assert.equal(afterCleanup.rows[0].count, 150, 'Cleanup limited to 100 expired rows per attempt');
    assert.equal(await makeVerifier()(same, client), false, 'Live replay protection survives cleanup');
    await pool.end();
    assert.equal(await makeVerifier()(assertionRequest(key), client), false, 'DB unavailable fails closed');
    console.log('PostgreSQL replay integration passed: read-only readiness and non-owner privileges, real migration, concurrency, restart, hash-only storage, bounded cleanup, DB failure');
  } finally {
    if (!pool.ended) await pool.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
