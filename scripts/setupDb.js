/**
 * scripts/setupDb.js
 * Prepare a database for the app (`npm run db:setup`), e.g. Supabase or any Postgres:
 *   1. check the database uses UTF8
 *   2. apply src/models/schema.sql (safe to re-run)
 *   3. make sure a business row exists and print its id for DEFAULT_BUSINESS_ID
 *
 * Uses DATABASE_URL from .env (or the environment).
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const { businessKnowledge } = require('../src/config/businessKnowledge');

const SCHEMA_PATH = path.join(__dirname, '..', 'src', 'models', 'schema.sql');

/**
 * @param {string} databaseUrl
 * @returns {Promise<{businessId: string, created: boolean}>}
 */
const setupDatabase = async (databaseUrl) => {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { rows: enc } = await client.query('SHOW server_encoding');
    if (enc[0].server_encoding !== 'UTF8') {
      throw new Error(`Database encoding is ${enc[0].server_encoding}; it must be UTF8 (₹, emoji, Indian languages).`);
    }

    await client.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));

    const existing = await client.query('SELECT id, name FROM businesses ORDER BY created_at LIMIT 1');
    if (existing.rows[0]) return { businessId: existing.rows[0].id, created: false };

    // whatsapp_number is updated later when the real business number is known.
    const { rows } = await client.query(
      'INSERT INTO businesses (name, whatsapp_number) VALUES ($1, $2) RETURNING id',
      [businessKnowledge.name.replace('[EDIT] ', ''), 'pending-setup']
    );
    return { businessId: rows[0].id, created: true };
  } finally {
    await client.end();
  }
};

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (.env).');
    process.exit(1);
  }

  setupDatabase(url)
    .then(({ businessId, created }) => {
      console.log('✔ Schema applied');
      console.log(`${created ? '✔ Business created' : '✔ Business exists'}: ${businessId}`);
      if (process.env.DEFAULT_BUSINESS_ID !== businessId) {
        console.log(`\nSet this in .env:\nDEFAULT_BUSINESS_ID=${businessId}`);
      }
    })
    .catch((err) => {
      console.error(`✖ Database setup failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { setupDatabase };
