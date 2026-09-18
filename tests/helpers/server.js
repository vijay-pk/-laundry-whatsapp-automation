/**
 * tests/helpers/server.js
 * Starts the real server.js in a child process against the test database
 * and a mock Graph API, plus HTTP helpers for calling it.
 */

const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const TEST_ENV = {
  WEBHOOK_VERIFY_TOKEN: 'test_verify_token',
  META_APP_SECRET: 'test_app_secret',
  BOOKING_API_KEY: 'test_api_key',
  GRAPH_API_TOKEN: 'test_graph_token',
  PHONE_NUMBER_ID: '100000000000001',
  ADMIN_PHONE: '910000000099',
  TEMPLATE_BOOKING_CANCELLED: 'booking_cancelled',
  TIMEZONE: 'Asia/Kolkata',
  OPENAI_API_KEY: '', // never call OpenAI from tests
  // Geofencing off unless a test enables it (never inherit the developer's .env values)
  BUSINESS_LAT: '',
  BUSINESS_LNG: '',
  MAX_DELIVERY_RADIUS_KM: '5',
  // Never call the real geocoder from tests (port 9 refuses connections immediately)
  GEOCODER_BASE_URL: 'http://127.0.0.1:9',
  GEOCODER_MIN_INTERVAL_MS: '0',
  // Payments off unless a test enables them (never inherit real Razorpay keys from .env)
  RAZORPAY_KEY_ID: '',
  RAZORPAY_KEY_SECRET: '',
  RAZORPAY_WEBHOOK_SECRET: '',
  RAZORPAY_API_BASE_URL: 'http://127.0.0.1:9',
  PUBLIC_BASE_URL: '',
  TEMPLATE_ORDER_STATUS: '',
  TRUST_PROXY: '', // loopback only unless a test sets it
};

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until fn() is truthy or timeout. Returns the last value.
const waitFor = async (fn, { timeout = 15000, interval = 100 } = {}) => {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await fn();
    if (value) return value;
    await sleep(interval);
  }
  return value;
};

/**
 * @param {object} options
 * @param {string} options.graphUrl       mock Graph API base URL
 * @param {object} [options.env]          extra/overriding env vars
 */
const startServer = async ({ graphUrl, env = {} }) => {
  const port = await getFreePort();
  const output = [];

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...TEST_ENV,
      NODE_ENV: 'production', // quiet SQL logging
      PORT: String(port),
      WHATSAPP_API_BASE_URL: graphUrl,
      ...env,
    },
  });
  child.stdout.on('data', (d) => output.push(String(d)));
  child.stderr.on('data', (d) => output.push(String(d)));

  const started = await waitFor(() => output.join('').includes('Server listening'), { timeout: 15000 });
  if (!started) {
    child.kill();
    throw new Error(`Server did not start:\n${output.join('')}`);
  }

  const baseUrl = `http://localhost:${port}`;

  // form: object -> application/x-www-form-urlencoded. Redirects are returned, not followed.
  const request = async (method, pathname, { body, headers = {}, form } = {}) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...headers },
      body: form ? new URLSearchParams(form).toString() : body,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, text, json, headers: res.headers };
  };

  const sign = (raw) =>
    'sha256=' + crypto.createHmac('sha256', TEST_ENV.META_APP_SECRET).update(raw).digest('hex');

  return {
    baseUrl,
    logs: () => output.join(''),
    request,
    // POST /webhook with a valid Meta signature
    postWebhook: (payload) => {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return request('POST', '/webhook', { body: raw, headers: { 'X-Hub-Signature-256': sign(raw) } });
    },
    // POST /api/bookings with the API key
    postBooking: (payload, headers = {}) =>
      request('POST', '/api/bookings', {
        body: JSON.stringify(payload),
        headers: { 'x-api-key': TEST_ENV.BOOKING_API_KEY, ...headers },
      }),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        child.kill();
      }),
  };
};

// Build a Meta webhook payload containing the given messages.
// options.profileName adds the sender's WhatsApp profile (value.contacts).
const webhookPayload = (messages, { profileName } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: TEST_ENV.PHONE_NUMBER_ID },
            ...(profileName ? { contacts: messages.map((m) => ({ profile: { name: profileName }, wa_id: m.from })) } : {}),
            messages,
          },
        },
      ],
    },
  ],
});

const textMessage = (id, from, body) => ({ id, from, timestamp: '1700000000', type: 'text', text: { body } });

// Customer tapped a reply button (kind 'button_reply') or picked a list row (kind 'list_reply').
const tapMessage = (id, from, replyId, title = replyId, kind = 'button_reply') => ({
  id, from, timestamp: '1700000000', type: 'interactive', interactive: { type: kind, [kind]: { id: replyId, title } },
});

const locationMessage = (id, from, location) => ({ id, from, timestamp: '1700000000', type: 'location', location });

module.exports = { TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, locationMessage, waitFor, sleep };
