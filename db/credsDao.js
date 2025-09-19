'use strict';
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
});

async function getIcuCredsByUserId(user_id) {
  const q = `
    SELECT icu_api_key, icu_athlete_id
    FROM gw_user_creds
    WHERE user_id = $1
  `;
  const { rows } = await pool.query(q, [user_id]);
  if (!rows.length) return null;
  return rows[0];
}

module.exports = { getIcuCredsByUserId, pool };
