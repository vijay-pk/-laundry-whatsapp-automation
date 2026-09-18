/**
 * tests/helpers/mockRazorpay.js
 * Local stand-in for the Razorpay REST API (orders, payments, capture) plus helpers that
 * produce correctly signed Checkout callbacks and webhooks with the test secrets.
 * The server under test points RAZORPAY_API_BASE_URL here.
 */

const http = require('http');
const crypto = require('crypto');

const KEY_ID = 'rzp_test_mockkey123';
const KEY_SECRET = 'mock_key_secret_for_tests';
const WEBHOOK_SECRET = 'mock_webhook_secret_for_tests';

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const rid = (prefix) => `${prefix}_${crypto.randomBytes(7).toString('hex').slice(0, 14)}`;

const startMockRazorpay = async () => {
  const orders = new Map();   // id -> order
  const paymentsById = new Map(); // id -> payment entity
  const requests = [];
  let failNext = 0;
  let failStatus = 500;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const auth = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
      requests.push({ method: req.method, url: req.url, body, auth });

      const send = (status, data) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(data));
      };

      if (auth !== `${KEY_ID}:${KEY_SECRET}`) return send(401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
      if (failNext > 0) {
        failNext -= 1;
        return send(failStatus, { error: { code: 'SERVER_ERROR', description: 'Mock outage' } });
      }

      const url = new URL(req.url, 'http://mock');
      let m;
      if (req.method === 'POST' && url.pathname === '/v1/orders') {
        const order = { id: rid('order'), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes, status: 'created' };
        orders.set(order.id, order);
        return send(200, order);
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/orders\/([^/]+)\/payments$/))) {
        return send(200, { entity: 'collection', items: [...paymentsById.values()].filter((p) => p.order_id === m[1]) });
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/v1\/payments\/([^/]+)$/))) {
        const p = paymentsById.get(m[1]);
        return p ? send(200, p) : send(400, { error: { description: 'The id provided does not exist' } });
      }
      if (req.method === 'POST' && (m = url.pathname.match(/^\/v1\/payments\/([^/]+)\/capture$/))) {
        const p = paymentsById.get(m[1]);
        if (!p) return send(400, { error: { description: 'not found' } });
        p.status = 'captured';
        return send(200, p);
      }
      return send(404, { error: { description: 'not found' } });
    });
  });

  await new Promise((resolve) => server.listen(0, resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    env: {
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
    orders,
    requests,
    ordersCreated: () => requests.filter((r) => r.method === 'POST' && r.url === '/v1/orders'),

    /** Simulate the customer paying (or failing) an order in Checkout. */
    pay(orderId, { status = 'captured', amount } = {}) {
      const order = orders.get(orderId);
      const payment = {
        id: rid('pay'), entity: 'payment', order_id: orderId, amount: amount ?? order.amount, currency: order.currency,
        status, method: 'upi', error_description: status === 'failed' ? 'Payment declined by bank' : null,
      };
      paymentsById.set(payment.id, payment);
      if (status === 'captured') order.status = 'paid';
      return payment;
    },

    /** Checkout success callback body with a valid (or tampered) signature. */
    checkoutCallback(payment, { tamper = false } = {}) {
      const signature = hmac(KEY_SECRET, `${payment.order_id}|${payment.id}`);
      return {
        razorpay_order_id: payment.order_id,
        razorpay_payment_id: payment.id,
        razorpay_signature: tamper ? signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) : signature,
      };
    },

    /** Signed webhook request { body (string), headers }. */
    webhook(event, { payment, refund, eventId = rid('evt'), secret = WEBHOOK_SECRET } = {}) {
      const payload = {};
      if (payment) payload.payment = { entity: payment };
      if (refund) payload.refund = { entity: refund };
      const body = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
      return { body, headers: { 'X-Razorpay-Signature': hmac(secret, body), 'X-Razorpay-Event-Id': eventId } };
    },

    failNextRequests(n = 1, status = 500) {
      failNext = n;
      failStatus = status;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

module.exports = { startMockRazorpay, KEY_SECRET, WEBHOOK_SECRET };
