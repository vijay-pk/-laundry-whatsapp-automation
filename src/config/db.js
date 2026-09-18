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

// ---------------------------------------------------------------------------
// 4. Transactions
//    fn receives a client whose query() runs inside BEGIN/COMMIT; any throw rolls back.
// ---------------------------------------------------------------------------
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// ---------------------------------------------------------------------------
// 5. Advisory locks
//    withLock(key, fn): only one fn per key runs at a time, across every server instance.
//    The lock lives on a connection from a separate small pool, so waiting lock holders
//    can never use up the connections fn itself needs for its queries.
//    Released when fn finishes or throws; if the connection dies, Postgres releases it.
// ---------------------------------------------------------------------------
const LOCK_WAIT = process.env.DB_LOCK_TIMEOUT || '60s'; // give up waiting (message retried later)

let lockPool;
const getLockPool = () => {
  if (!lockPool) {
    lockPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_LOCK_POOL_MAX) || 5, // customers processed in parallel per instance
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 60000,
    });
    lockPool.on('error', (err) => console.error('[db] Unexpected error on idle lock client:', err.message));
  }
  return lockPool;
};

const withLock = async (key, fn) => {
  const client = await getLockPool().connect();
  let broken = null;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [LOCK_WAIT]);
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [String(key)]);
  } catch (err) {
    client.release(err); // discard: lock state unknown
    throw err;
  }
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [String(key)]).catch((err) => {
      broken = err;
    });
    client.release(broken || undefined); // a failed unlock closes the connection, which releases the lock
  }
};

const closePools = async () => {
  await Promise.all([pool.end(), lockPool?.end()]);
};

module.exports = { pool, query, withTransaction, withLock, closePools };
