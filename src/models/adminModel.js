/**
 * src/models/adminModel.js
 * Admin accounts and dashboard sessions.
 */

const { query } = require('../config/db');
const { hashPassword, randomToken, sha256 } = require('../utils/passwords');

const SESSION_HOURS = 12;

const findAdminByEmail = async (email) => {
  const { rows } = await query('SELECT * FROM admin_users WHERE LOWER(email) = LOWER($1)', [String(email || '').trim()]);
  return rows[0] || null;
};

/**
 * Create an admin. role 'admin' requires businessId; 'super_admin' has none.
 */
const createAdmin = async ({ email, password, role = 'admin', businessId = null }) => {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw Object.assign(new Error('Invalid email'), { status: 400 });
  if (!['admin', 'super_admin'].includes(role)) throw Object.assign(new Error('Invalid role'), { status: 400 });
  if (role === 'admin' && !businessId) throw Object.assign(new Error('An admin must belong to a business'), { status: 400 });

  const { rows } = await query(
    `INSERT INTO admin_users (email, password_hash, role, business_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, email, role, business_id, created_at`,
    [cleanEmail, await hashPassword(password), role, role === 'super_admin' ? null : businessId]
  );
  return rows[0];
};

/**
 * Start a session. Returns the raw token (cookie value) and CSRF token; only the hash is stored.
 */
const createSession = async (adminId) => {
  const token = randomToken(32);
  const csrfToken = randomToken(32);
  await query(
    `INSERT INTO admin_sessions (token_hash, admin_id, csrf_token, expires_at)
     VALUES ($1, $2, $3, NOW() + make_interval(hours => $4))`,
    [sha256(token), adminId, csrfToken, SESSION_HOURS]
  );
  await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [adminId]);
  return { token, csrfToken, maxAgeSeconds: SESSION_HOURS * 3600 };
};

// Admin for a valid, unexpired session token (or null).
const findSession = async (token) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await query(
    `SELECT s.csrf_token, a.id, a.email, a.role, a.business_id, b.name AS business_name
     FROM admin_sessions s
     JOIN admin_users a ON a.id = s.admin_id
     LEFT JOIN businesses b ON b.id = a.business_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [sha256(token)]
  );
  return rows[0] || null;
};

const deleteSession = async (token) => {
  if (typeof token !== 'string') return;
  await query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
};

const purgeExpiredAdminSessions = async () => {
  const { rowCount } = await query('DELETE FROM admin_sessions WHERE expires_at < NOW()');
  return rowCount;
};

const listBusinessesWithSettings = async () => {
  const { rows } = await query(
    `SELECT b.id, b.name, s.payment_enabled, s.payment_mode, s.advance_type, s.advance_value,
            s.allow_cash_on_delivery, s.online_provider, s.whatsapp_pay_gateway, s.updated_at
     FROM businesses b
     LEFT JOIN business_payment_settings s ON s.business_id = b.id
     ORDER BY b.name`
  );
  return rows;
};

module.exports = {
  findAdminByEmail,
  createAdmin,
  createSession,
  findSession,
  deleteSession,
  purgeExpiredAdminSessions,
  listBusinessesWithSettings,
};
