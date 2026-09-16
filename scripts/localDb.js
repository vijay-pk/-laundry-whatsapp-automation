/**
 * scripts/localDb.js
 * Run a local PostgreSQL for development without installing Postgres (`npm run db:local`).
 * Uses the embedded-postgres dev dependency. Data is kept in .localdb/ (gitignored)
 * between runs. Keep this terminal open while the app runs; Ctrl+C stops the database.
 *
 * .env for this database:
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/laundry
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { setupDatabase } = require('./setupDb');

const DATA_DIR = path.join(__dirname, '..', '.localdb');
const PORT = Number(process.env.LOCAL_DB_PORT) || 5433; // 5433 avoids clashing with an installed Postgres
const USER = 'postgres';
const PASSWORD = 'postgres'; // local only, not reachable from other machines
const DB_NAME = 'laundry';

const main = async () => {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });

  const firstRun = !fs.existsSync(path.join(DATA_DIR, 'PG_VERSION'));
  if (firstRun) {
    console.log('Creating local database in .localdb/ (first run)...');
    await pg.initialise();
  }
  await pg.start();

  // Create the app database once.
  const admin = new Client({ connectionString: `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/postgres` });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
  if (rowCount === 0) await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const url = `postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DB_NAME}`;
  const { businessId } = await setupDatabase(url);

  console.log(`\n✔ Local PostgreSQL running on port ${PORT}`);
  console.log('\nUse in .env:');
  console.log(`DATABASE_URL=${url}`);
  console.log(`DEFAULT_BUSINESS_ID=${businessId}`);
  console.log('\nPress Ctrl+C to stop the database.');

  const stop = async () => {
    console.log('\nStopping local PostgreSQL...');
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30); // keep running
};

main().catch((err) => {
  console.error(`✖ Local database failed: ${err.message}`);
  process.exit(1);
});
