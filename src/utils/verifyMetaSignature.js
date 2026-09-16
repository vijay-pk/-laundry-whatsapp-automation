/**
 * src/utils/verifyMetaSignature.js
 * Express middleware that rejects webhook requests not signed by Meta.
 *
 * Meta signs every webhook POST with your App Secret:
 *   X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw request body>
 *
 * Requires req.rawBody (captured by bodyParser.json's `verify` option in server.js).
 * The HMAC must be computed over the exact bytes received, not re-serialized JSON.
 */

const crypto = require('crypto');

const SIGNATURE_PREFIX = 'sha256=';

const verifyMetaSignature = (req, res, next) => {
  const appSecret = process.env.META_APP_SECRET;

  // Fail closed: never accept unverified webhooks because of missing config.
  if (!appSecret) {
    console.error('[signature] META_APP_SECRET not set; rejecting webhook');
    return res.sendStatus(500);
  }

  const header = req.get('x-hub-signature-256');
  if (!header || !header.startsWith(SIGNATURE_PREFIX)) {
    console.warn('[signature] Missing or malformed X-Hub-Signature-256 header');
    return res.sendStatus(401);
  }

  // No raw body means the request wasn't JSON (Meta always sends JSON).
  if (!req.rawBody) {
    console.warn('[signature] No raw body to verify');
    return res.sendStatus(401);
  }

  const expected = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest();
  const received = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');

  // Length check first: timingSafeEqual throws on different lengths.
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    console.warn('[signature] Invalid webhook signature');
    return res.sendStatus(401);
  }

  return next();
};

module.exports = { verifyMetaSignature };
