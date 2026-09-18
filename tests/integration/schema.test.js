/**
 * Integration tests: src/models/schema.sql properties that protect hosted databases.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, closeDb } = require('../helpers/db');

describe('schema', () => {
  after(closeDb);

  it('enables Row Level Security on every app table (Supabase Data API exposure)', async () => {
    const { rows } = await query(
      `SELECT c.relname, c.relrowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`
    );
    assert.ok(rows.length >= 10, 'schema applied');
    assert.deepEqual(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname), []);
  });

  it('still lets the app (table owner) read and write', async () => {
    const { rows } = await query(
      "INSERT INTO businesses (name, whatsapp_number) VALUES ('RLS check', 'rls-check') RETURNING id"
    );
    await query('DELETE FROM businesses WHERE id = $1', [rows[0].id]);
  });
});
