#!/usr/bin/env node
/**
 * Seed or update OAuth client and print the generated secret.
 * Uses environment variables for DB connection.
 */
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
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

  const clientId = process.argv[2] || 'chatgpt-actions';
  const secret = crypto.randomBytes(32).toString('base64');
  const secretHash = await bcrypt.hash(secret, 10);

  const query = `
    INSERT INTO public.gw_oauth_clients (client_id, client_secret_hash, allowed_redirects, scopes)
    VALUES ($1, $2, ARRAY['https://chat.openai.com/aip/api/callback','https://chatgpt.com/aip/api/callback'], ARRAY['read:me','icu','workouts:write'])
    ON CONFLICT (client_id) DO UPDATE SET
      client_secret_hash = EXCLUDED.client_secret_hash,
      allowed_redirects = EXCLUDED.allowed_redirects,
      scopes = EXCLUDED.scopes
    RETURNING client_id;
  `;

  try {
    const r = await pool.query(query, [clientId, secretHash]);
    console.log(`CLIENT_ID=${r.rows[0].client_id}`);
    console.log(`CLIENT_SECRET=${secret}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


