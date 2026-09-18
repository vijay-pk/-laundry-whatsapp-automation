/**
 * server.js
 * Entry point for the laundry WhatsApp automation service.
 */

// ---------------------------------------------------------------------------
// 1. Environment configuration
// ---------------------------------------------------------------------------
require('dotenv').config({ quiet: true });

const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

// Fail fast with a clear message before any module tries to use these.
const REQUIRED_ENV = [
  'WEBHOOK_VERIFY_TOKEN',
  'GRAPH_API_TOKEN',
  'PHONE_NUMBER_ID',
  'META_APP_SECRET',
  'DATABASE_URL',
  'BOOKING_API_KEY',
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[startup] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

if (!process.env.ADMIN_PHONE) {
  console.warn('[startup] ADMIN_PHONE not set: admin alerts, reschedule and hand-off forwarding disabled');
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('[startup] OPENAI_API_KEY not set: keyword intent detection and fallback replies only');
}

// Load app modules after env validation. db.js throws on load if DATABASE_URL is missing.
const { verifyWebhook, handleIncomingMessage } = require('./src/controllers/webhookController');
const { createNewBooking, updateStatus } = require('./src/controllers/bookingController');
const { verifyMetaSignature } = require('./src/utils/verifyMetaSignature');
const { purgeOldEvents } = require('./src/models/webhookEventModel');
const { purgeExpiredSessions } = require('./src/models/sessionModel');
const { purgeExpiredAdminSessions } = require('./src/models/adminModel');
const adminRoutes = require('./src/routes/adminRoutes');
const { payRouter, webhookRouter } = require('./src/routes/payRoutes');
const razorpay = require('./src/services/razorpayService');
const { syncPendingWhatsAppPayments } = require('./src/services/whatsappPayService');

if (!razorpay.isConfigured()) {
  console.warn('[startup] RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET not set: online payment unavailable (bookings without payment still work)');
} else if (!process.env.PUBLIC_BASE_URL) {
  console.warn('[startup] PUBLIC_BASE_URL not set: payment links cannot be sent, online payment unavailable');
}
const { closePools } = require('./src/config/db');

const PORT = Number(process.env.PORT) || 3000;

// ---------------------------------------------------------------------------
// 2. App initialization & global middleware
// ---------------------------------------------------------------------------
const app = express();

// Which proxies to trust for X-Forwarded-For/-Proto (req.ip for login throttling, req.secure for cookies).
// Default 'loopback' = local tunnel (ngrok). Hosted behind a platform proxy (Render): TRUST_PROXY=<hop count>.
// A hop count, not 'true': trusting every hop would let clients spoof X-Forwarded-For past the throttle.
const trustProxySetting = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return 'loopback';
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw; // subnet list / names, e.g. 'loopback, 10.0.0.0/8'
};
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY));

app.use(cors());

// Keep the raw body on req.rawBody: verifyMetaSignature needs the exact bytes.
app.use(
  bodyParser.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// 3. API key authentication for third-party integrations
//    Clients send header:  x-api-key: <BOOKING_API_KEY>
// ---------------------------------------------------------------------------
const requireApiKey = (req, res, next) => {
  const provided = req.get('x-api-key');
  if (!provided) {
    return res.status(401).json({ success: false, error: 'Missing x-api-key header' });
  }

  // Hash both sides so timingSafeEqual gets equal-length buffers,
  // and the comparison time doesn't reveal the key.
  const hash = (value) => crypto.createHash('sha256').update(value).digest();
  if (!crypto.timingSafeEqual(hash(provided), hash(process.env.BOOKING_API_KEY))) {
    return res.status(403).json({ success: false, error: 'Invalid API key' });
  }

  return next();
};

// ---------------------------------------------------------------------------
// 4. Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Meta WhatsApp webhook
app.get('/webhook', verifyWebhook);
app.post('/webhook', verifyMetaSignature, handleIncomingMessage);

// Booking API: third-party intake + order status updates
app.post('/api/bookings', requireApiKey, createNewBooking);
app.patch('/api/bookings/:id/status', requireApiKey, updateStatus);

// Customer payment page, Razorpay webhook, admin dashboard
app.use('/pay', payRouter);
app.use('/webhooks', webhookRouter);
app.use('/admin', adminRoutes);

// ---------------------------------------------------------------------------
// 5. 404 handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// ---------------------------------------------------------------------------
// 6. Centralized error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }

  console.error('[error]', err);

  const status = err.status || err.statusCode || 500;
  const isProduction = process.env.NODE_ENV === 'production';

  return res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.message,
    ...(isProduction ? {} : { stack: err.stack }),
  });
});

// ---------------------------------------------------------------------------
// 7. Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`[startup] Server listening on port ${PORT}`);
});

// ---------------------------------------------------------------------------
// 8. Background jobs
//    Purge old webhook idempotency ids and abandoned chat sessions at startup, then daily.
// ---------------------------------------------------------------------------
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

const runPurge = async () => {
  try {
    const removed = await purgeOldEvents();
    if (removed > 0) console.log(`[jobs] Purged ${removed} old webhook event ids`);
    const sessions = await purgeExpiredSessions();
    if (sessions > 0) console.log(`[jobs] Purged ${sessions} expired chat sessions`);
    const adminSessions = await purgeExpiredAdminSessions();
    if (adminSessions > 0) console.log(`[jobs] Purged ${adminSessions} expired admin sessions`);
  } catch (err) {
    console.error(`[jobs] Purge failed: ${err.message}`);
  }
};

runPurge();
setInterval(runPurge, PURGE_INTERVAL_MS).unref(); // unref: never keeps the process alive

// WhatsApp Pay: reconcile unpaid payment requests with Meta's lookup API (recovers missed webhooks).
const WHATSAPP_PAY_SYNC_MS = Number(process.env.WHATSAPP_PAY_SYNC_MINUTES || 5) * 60 * 1000;
setInterval(async () => {
  try {
    await syncPendingWhatsAppPayments();
  } catch (err) {
    console.error(`[jobs] WhatsApp Pay sync failed: ${err.message}`);
  }
}, WHATSAPP_PAY_SYNC_MS).unref();

// ---------------------------------------------------------------------------
// 9. Process-level safety nets & graceful shutdown
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
  process.exit(1);
});

const shutdown = (signal) => {
  console.log(`[shutdown] ${signal} received, closing server...`);
  server.close(async () => {
    await closePools().catch(() => {}); // release DB connections (queries + locks)
    console.log('[shutdown] Server and DB pool closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
