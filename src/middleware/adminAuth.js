/**
 * src/middleware/adminAuth.js
 * Cookie sessions, CSRF protection and login throttling for the admin dashboard.
 */

const crypto = require('crypto');
const { findSession } = require('../models/adminModel');

const COOKIE_NAME = 'admin_session';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5; // per IP + email
const MAX_IP_LOGIN_FAILURES = Number(process.env.ADMIN_LOGIN_MAX_IP_FAILURES) || 20; // per IP, any email (password spraying)

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------
const parseCookies = (header = '') =>
  Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, ...rest]) => name && rest.length)
      .map(([name, ...rest]) => {
        try {
          return [name, decodeURIComponent(rest.join('='))];
        } catch {
          return [name, ''];
        }
      })
  );

// Secure flag when the request came over HTTPS (ngrok/proxy sets X-Forwarded-Proto; see trust proxy).
const setSessionCookie = (req, res, token, maxAgeSeconds) => {
  res.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${req.secure ? '; Secure' : ''}`
  );
};

const clearSessionCookie = (req, res) => {
  res.append('Set-Cookie', `${COOKIE_NAME}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
};

const sessionToken = (req) => parseCookies(req.headers.cookie)[COOKIE_NAME];

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Loads req.admin = { id, email, role, business_id, business_name, csrf_token } when logged in.
const loadAdmin = async (req, res, next) => {
  try {
    req.admin = await findSession(sessionToken(req));
    return next();
  } catch (err) {
    return next(err);
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.admin) return res.redirect(303, '/admin/login');
  return next();
};

// Only business admins can change their business (super admins get read-only views).
const requireBusinessAdmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== 'admin' || !req.admin.business_id) {
    return res.status(403).send('Forbidden');
  }
  return next();
};

// Every state-changing admin form must carry the session's CSRF token.
const verifyCsrf = (req, res, next) => {
  const sent = Buffer.from(String(req.body?._csrf || ''));
  const expected = Buffer.from(String(req.admin?.csrf_token || ''));
  if (!expected.length || sent.length !== expected.length || !crypto.timingSafeEqual(sent, expected)) {
    return res.status(403).send('Invalid or expired form. Reload the page and try again.');
  }
  return next();
};

// ---------------------------------------------------------------------------
// Login throttling (in memory, per server instance)
//   - per IP + email: stops guessing one account's password
//   - per IP, any email: stops trying common passwords against many accounts
// ---------------------------------------------------------------------------
const failures = new Map(); // key -> { count, first }

const throttleKey = (req, email) => `${req.ip}|${String(email || '').toLowerCase()}`;
const ipKey = (req) => `ip|${req.ip}`;

const countFor = (key) => {
  const entry = failures.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.first > LOGIN_WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  return entry.count;
};

const isLoginBlocked = (req, email) =>
  countFor(throttleKey(req, email)) >= MAX_LOGIN_FAILURES || countFor(ipKey(req)) >= MAX_IP_LOGIN_FAILURES;

const bump = (key) => {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first > LOGIN_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count += 1;
};

// A successful login later clears that account's counter only; the per-IP counter keeps counting.
const recordLoginFailure = (req, email) => {
  bump(throttleKey(req, email));
  bump(ipKey(req));
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
};

const clearLoginFailures = (req, email) => failures.delete(throttleKey(req, email));

module.exports = {
  parseCookies,
  sessionToken,
  setSessionCookie,
  clearSessionCookie,
  loadAdmin,
  requireAdmin,
  requireBusinessAdmin,
  verifyCsrf,
  isLoginBlocked,
  recordLoginFailure,
  clearLoginFailures,
};
