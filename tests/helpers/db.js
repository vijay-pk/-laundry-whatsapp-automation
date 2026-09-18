/**
 * tests/helpers/db.js
 * Shared database helpers for integration tests.
 * DATABASE_URL is provided by tests/run.js.
 */

// Safety check BEFORE src/config/db.js loads .env: tests TRUNCATE tables, so never
// fall back to the developer's real DATABASE_URL from .env.
const assertTestDatabase = () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Integration tests need the test database. Run them with `npm test`.');
  }
  const dbName = new URL(url).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to run integration tests against "${dbName}": database name must contain "test".`);
  }
};
assertTestDatabase();

const { pool, query, closePools } = require('../../src/config/db');

// Empty all tables so each test file starts clean.
const resetDb = async () => {
  await query('TRUNCATE whatsapp_auth, razorpay_webhook_events, admin_sessions, admin_users, payments, business_payment_settings, conversation_sessions, webhook_events, messages, bookings, businesses CASCADE');
};

let businessCounter = 0;
const createBusiness = async (name = 'Test Laundry') => {
  businessCounter += 1;
  const { rows } = await query(
    'INSERT INTO businesses (name, whatsapp_number) VALUES ($1, $2) RETURNING *',
    [name, `9100000${String(businessCounter).padStart(5, '0')}`]
  );
  return rows[0];
};

const closeDb = () => closePools();

module.exports = { query, resetDb, createBusiness, closeDb };
