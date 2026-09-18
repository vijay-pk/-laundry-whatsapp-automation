/**
 * src/utils/passwords.js
 * Password hashing with Node's built-in scrypt (no native dependencies).
 * Stored format: scrypt$N$r$p$saltBase64$hashBase64
 */

const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 10;

const scrypt = (password, salt, n, r, p) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });

const hashPassword = async (password) => {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
};

// Constant-time comparison; false for malformed hashes.
const verifyPassword = async (password, stored) => {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
};

// Random token (hex) and its sha256 (what gets stored).
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

module.exports = { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword, randomToken, sha256 };
