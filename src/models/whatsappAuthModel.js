/**
 * src/models/whatsappAuthModel.js
 * Storage for the WhatsApp QR-login session (Baileys credentials + Signal keys).
 * Values are opaque JSON strings; the channel encodes/decodes them.
 */

const { query } = require('../config/db');

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, string>>} id -> stored JSON text (missing ids absent)
 */
const readAuthRows = async (ids) => {
  if (!ids.length) return new Map();
  const { rows } = await query('SELECT id, data FROM whatsapp_auth WHERE id = ANY($1::text[])', [ids]);
  return new Map(rows.map((r) => [r.id, r.data]));
};

/**
 * Upsert and delete in one statement each (null value = delete).
 * @param {Array<[string, string|null]>} entries
 */
const writeAuthRows = async (entries) => {
  // Last write per id wins (one INSERT .. ON CONFLICT can't touch the same row twice).
  const latest = [...new Map(entries).entries()];
  const upserts = latest.filter(([, data]) => data !== null);
  const deletes = latest.filter(([, data]) => data === null).map(([id]) => id);

  if (upserts.length) {
    await query(
      `INSERT INTO whatsapp_auth (id, data)
       SELECT * FROM UNNEST($1::text[], $2::text[])
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [upserts.map(([id]) => id), upserts.map(([, data]) => data)]
    );
  }
  if (deletes.length) {
    await query('DELETE FROM whatsapp_auth WHERE id = ANY($1::text[])', [deletes]);
  }
};

/** Forget the linked device (logout): the next start shows a new QR code. */
const clearAuth = async () => {
  await query('DELETE FROM whatsapp_auth');
};

module.exports = { readAuthRows, writeAuthRows, clearAuth };
