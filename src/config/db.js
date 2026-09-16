/**
 * src/config/db.js
 * PostgreSQL connection pool plus a thin query helper.
 */

require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// 1. Validate configuration
// ---------------------------------------------------------------------------
if (!process.env.DATABASE_URL) {
  throw new Error('[db] DATABASE_URL is not set');
}

// ---------------------------------------------------------------------------
// 2. Create the pool
//    One pool per process. It reuses connections instead of opening one per query.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX) || 10,   // max concurrent connections
  idleTimeoutMillis: 30000,                     // close idle clients after 30s
  connectionTimeoutMillis: 5000,                // fail fast if DB is unreachable
});

// An idle client can error (network drop, DB restart). Without this listener,
// the error would crash the process.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client:', err.message);
});

// ---------------------------------------------------------------------------
// 3. Query helper
//    Always pass values through `params`. Never interpolate them into `text`.
// ---------------------------------------------------------------------------
const query = async (text, params = []) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);

    if (process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test') {
      // Log the SQL and timing only. Params hold customer PII (phones, addresses).
      console.log(`[db] ${Date.now() - start}ms rows=${result.rowCount} :: ${text.replace(/\s+/g, ' ').trim()}`);
    }

    return result;
  } catch (err) {
    console.error(`[db] Query failed (code=${err.code}): ${err.message}`);
    throw err;
  }
};

module.exports = { pool, query };
