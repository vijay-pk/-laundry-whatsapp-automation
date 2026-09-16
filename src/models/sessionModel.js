/**
 * src/models/sessionModel.js
 * Chat flow state per customer (conversation_sessions table).
 */

const { query } = require('../config/db');

// A customer who goes quiet this long starts over.
const SESSION_TTL_MINUTES = 30;

/**
 * Active (non-expired) session for a client, or null. Expired sessions are deleted.
 * @returns {Promise<{client_phone, flow, step, data, updated_at} | null>}
 */
const getActiveSession = async (clientPhone) => {
  const { rows } = await query('SELECT * FROM conversation_sessions WHERE client_phone = $1', [clientPhone]);
  const session = rows[0];
  if (!session) return null;

  const ageMs = Date.now() - new Date(session.updated_at).getTime();
  if (ageMs > SESSION_TTL_MINUTES * 60 * 1000) {
    await clearSession(clientPhone);
    return null;
  }
  return session;
};

// Create or replace the client's session.
const saveSession = async (clientPhone, flow, step, data = {}) => {
  const { rows } = await query(
    `INSERT INTO conversation_sessions (client_phone, flow, step, data, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (client_phone) DO UPDATE
       SET flow = EXCLUDED.flow, step = EXCLUDED.step, data = EXCLUDED.data, updated_at = NOW()
     RETURNING *`,
    [clientPhone, flow, step, JSON.stringify(data)]
  );
  return rows[0];
};

const clearSession = async (clientPhone) => {
  await query('DELETE FROM conversation_sessions WHERE client_phone = $1', [clientPhone]);
};

// Delete sessions customers abandoned. Returns number removed.
const purgeExpiredSessions = async () => {
  const { rowCount } = await query(
    'DELETE FROM conversation_sessions WHERE updated_at < NOW() - make_interval(mins => $1)',
    [SESSION_TTL_MINUTES]
  );
  return rowCount;
};

module.exports = { SESSION_TTL_MINUTES, getActiveSession, saveSession, clearSession, purgeExpiredSessions };
