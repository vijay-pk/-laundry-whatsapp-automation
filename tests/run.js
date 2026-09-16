/**
 * tests/run.js
 * Test entry point (`npm test`).
 *
 * 1. Starts a throwaway PostgreSQL (embedded-postgres) in a temp directory,
 *    or uses TEST_DATABASE_URL if set (e.g. in CI).
 * 2. Applies src/models/schema.sql.
 * 3. Runs every tests/**\/*.test.js with node:test, one file at a time
 *    (files share the database and truncate tables in `before`).
 * 4. Stops the database and deletes its data directory.
 *
 * Extra arguments are passed to node --test, e.g.
 *   npm test -- --test-name-pattern="idempotency"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src', 'models', 'schema.sql');
const TEST_GLOB = 'tests/**/*.test.js';

// Ask the OS for a free port.
const getFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const startEmbeddedPostgres = async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const port = await getFreePort();
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-test-pg-'));
  const password = 'test';

  const pg = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password,
    port,
    persistent: false, // delete data directory on stop
    // Windows defaults to WIN1252, which can't store ₹ or emoji. Production must be UTF8 too.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},   // keep test output clean
  });

  console.log(`[test] Starting embedded PostgreSQL on port ${port}...`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('laundry_test');

  return {
    url: `postgresql://postgres:${password}@localhost:${port}/laundry_test`,
    stop: async () => {
      await pg.stop().catch(() => {});
      fs.rmSync(databaseDir, { recursive: true, force: true });
    },
  };
};

const applySchema = async (url) => {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // WhatsApp messages contain ₹, emoji and non-Latin scripts.
    const { rows } = await client.query('SHOW server_encoding');
    if (rows[0].server_encoding !== 'UTF8') {
      throw new Error(`Test database encoding is ${rows[0].server_encoding}; it must be UTF8`);
    }
    await client.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  } finally {
    await client.end();
  }
};

const runNodeTest = (databaseUrl, extraArgs) =>
  new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', ...extraArgs, TEST_GLOB],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
      }
    );
    child.on('exit', (code) => resolve(code ?? 1));
  });

const main = async () => {
  let db;

  if (process.env.TEST_DATABASE_URL) {
    // Tests TRUNCATE tables: refuse anything that doesn't look like a test database.
    const dbName = new URL(process.env.TEST_DATABASE_URL).pathname.slice(1);
    if (!/test/i.test(dbName)) {
      console.error(`[test] Refusing to run: TEST_DATABASE_URL database "${dbName}" must contain "test"`);
      return 1;
    }
    db = { url: process.env.TEST_DATABASE_URL, stop: async () => {} };
  } else {
    db = await startEmbeddedPostgres();
  }

  const cleanup = async () => {
    await db.stop();
  };
  process.once('SIGINT', async () => {
    await cleanup();
    process.exit(130);
  });

  try {
    await applySchema(db.url);
    return await runNodeTest(db.url, process.argv.slice(2));
  } finally {
    await cleanup();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[test] Runner failed:', err);
    process.exit(1);
  });
