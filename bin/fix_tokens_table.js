#!/usr/bin/env node
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: (/^true$/i).test(String(process.env.DB_SSL || '')) ? { rejectUnauthorized: false } : false
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop legacy column if present
    await client.query('ALTER TABLE public.gw_oauth_tokens DROP COLUMN IF EXISTS expires_at');
    // Ensure required columns exist (no-op if already there)
    await client.query("ALTER TABLE public.gw_oauth_tokens ADD COLUMN IF NOT EXISTS access_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour'");
    await client.query("ALTER TABLE public.gw_oauth_tokens ADD COLUMN IF NOT EXISTS refresh_expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'");
    await client.query('COMMIT');
    console.log('gw_oauth_tokens schema normalized');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Schema fix failed:', e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();


