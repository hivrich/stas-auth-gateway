#!/usr/bin/env node
const { Client } = require('pg');

const CATALOG_QUERY = `
SELECT c.oid IS NOT NULL AS present,
       c.relkind = 'r' AND n.nspname = 'public' AND NOT c.relrowsecurity AS plain_table,
       has_schema_privilege(n.oid, 'USAGE') AS schema_usage,
       has_table_privilege(c.oid, 'SELECT') AS can_select,
       has_table_privilege(c.oid, 'INSERT') AS can_insert,
       has_table_privilege(c.oid, 'DELETE') AS can_delete,
       has_table_privilege(c.oid, 'UPDATE') AS can_lock,
       NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname NOT IN ('assertion_hash', 'expires_at')) AS expected_columns,
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
         AND a.attname = 'assertion_hash' AND a.attnotnull AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) = 'character varying(64)') AS hash_column,
       EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
         AND a.attname = 'expires_at' AND a.attnotnull AND NOT a.attisdropped
         AND format_type(a.atttypid, a.atttypmod) = 'timestamp(3) with time zone') AS expiry_column,
       EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = c.oid
         AND a.attname = 'assertion_hash' WHERE i.indrelid = c.oid AND i.indisprimary
         AND i.indisvalid AND i.indisready AND i.indnkeyatts = 1
         AND i.indkey[0] = a.attnum) AS hash_primary_key,
       EXISTS (SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_am am ON am.oid = idx.relam JOIN pg_attribute a ON a.attrelid = c.oid
         AND a.attname = 'expires_at' WHERE i.indrelid = c.oid AND i.indisvalid
         AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
         AND am.amname = 'btree' AND i.indkey[0] = a.attnum) AS expiry_index
FROM (SELECT to_regclass('gw_oauth_client_assertions') AS oid) target
LEFT JOIN pg_class c ON c.oid = target.oid
LEFT JOIN pg_namespace n ON n.oid = c.relnamespace`;

async function checkReplayReadiness(client) {
  await client.query('BEGIN READ ONLY');
  try {
    const { rows } = await client.query(CATALOG_QUERY);
    const state = rows[0];
    if (!state?.present) return 'replay_table_missing';
    if (!['plain_table', 'expected_columns', 'hash_column', 'expiry_column', 'hash_primary_key', 'expiry_index'].every((name) => state[name] === true)) {
      return 'replay_schema_incompatible';
    }
    // UPDATE is needed by the runtime's SELECT ... FOR UPDATE cleanup.
    if (!['schema_usage', 'can_select', 'can_insert', 'can_delete', 'can_lock'].every((name) => state[name] === true)) {
      return 'replay_privilege_missing';
    }
    return null;
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runReadiness(options = {}) {
  const connectionString = options.connectionString ?? process.env.STAS_PGURL;
  const log = options.log || ((message) => console.log(message));
  if (!connectionString) { log('[oauth-readiness] database_config_missing'); return 1; }
  let client;
  try {
    const factory = options.clientFactory || ((config) => new Client(config));
    client = factory({ connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000' });
    await client.connect();
    const issue = await checkReplayReadiness(client);
    log(`[oauth-readiness] ${issue || 'ready'}`);
    return issue ? 1 : 0;
  } catch {
    log('[oauth-readiness] database_unavailable');
    return 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (require.main === module) runReadiness().then((code) => { process.exitCode = code; });
module.exports = { CATALOG_QUERY, checkReplayReadiness, runReadiness };
