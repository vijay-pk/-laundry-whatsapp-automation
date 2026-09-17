/**
 * src/services/razorpayService.js
 * Razorpay REST API (orders, payments) and signature verification.
 * The key secret and webhook secret are only ever used here, on the server.
 */

const crypto = require('crypto');
const axios = require('axios');

const REQUEST_TIMEOUT_MS = 10000;

const getConfig = () => ({
  keyId: process.env.RAZORPAY_KEY_ID || '',
  keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  baseUrl: process.env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com/v1', // tests point this at a mock
});

const isPlaceholder = (value) => !value || value.startsWith('replace_');

// Online payment can only be offered when API keys are configured.
const isConfigured = () => {
  const { keyId, keySecret } = getConfig();
  return !isPlaceholder(keyId) && !isPlaceholder(keySecret);
};

// Public key id for Razorpay Checkout (safe to send to the browser).
const publicKeyId = () => getConfig().keyId;

const createError = (message, status, extra = {}) => Object.assign(new Error(message), { status }, extra);

const client = () => {
  const { keyId, keySecret, baseUrl } = getConfig();
  if (!isConfigured()) throw createError('Razorpay is not configured', 503);
  return axios.create({
    baseURL: baseUrl,
    timeout: REQUEST_TIMEOUT_MS,
    auth: { username: keyId, password: keySecret },
    headers: { 'Content-Type': 'application/json' },
  });
};

// Wrap API/network errors: 503 when Razorpay is unreachable or failing, 502 for rejected requests.
const call = async (operation, fn) => {
  try {
    const { data } = await fn(client());
    return data;
  } catch (err) {
    if (!err.isAxiosError) throw err; // our own errors (e.g. not configured) already carry a status
    const status = err.response?.status;
    const description = err.response?.data?.error?.description || err.message;
    console.error(`[razorpay] ${operation} failed: http=${status ?? 'none'} ${description}`);
    throw createError(`Razorpay ${operation} failed`, !status || status >= 500 ? 503 : 502, { providerStatus: status, description });
  }
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Create an order. Amount comes from the database, in paise.
 * @returns {Promise<{id: string, amount: number, currency: string, status: string}>}
 */
const createOrder = ({ amountPaise, currency = 'INR', receipt, notes = {} }) =>
  call('create order', (api) =>
    api.post('/orders', { amount: amountPaise, currency, receipt: String(receipt).slice(0, 40), notes })
  );

const fetchPayment = (paymentId) => call('fetch payment', (api) => api.get(`/payments/${encodeURIComponent(paymentId)}`));

const fetchOrderPayments = async (orderId) => {
  const data = await call('fetch order payments', (api) => api.get(`/orders/${encodeURIComponent(orderId)}/payments`));
  return data.items || [];
};

// Needed only if the account doesn't auto-capture.
const capturePayment = (paymentId, amountPaise, currency = 'INR') =>
  call('capture payment', (api) =>
    api.post(`/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency })
  );

// ---------------------------------------------------------------------------
// Signatures (constant-time)
// ---------------------------------------------------------------------------
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

const safeEqualHex = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]+$/i.test(a)) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && bufA.length > 0 && crypto.timingSafeEqual(bufA, bufB);
};

// Checkout success handler: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret)
const verifyCheckoutSignature = (orderId, paymentId, signature) => {
  const { keySecret } = getConfig();
  if (!isConfigured() || !orderId || !paymentId) return false;
  return safeEqualHex(signature, hmacHex(keySecret, `${orderId}|${paymentId}`));
};

// Webhooks: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook secret)
const verifyWebhookSignature = (rawBody, signature) => {
  const { webhookSecret } = getConfig();
  if (isPlaceholder(webhookSecret) || !rawBody) return false;
  return safeEqualHex(signature, hmacHex(webhookSecret, rawBody));
};

module.exports = {
  isConfigured,
  publicKeyId,
  createOrder,
  fetchPayment,
  fetchOrderPayments,
  capturePayment,
  verifyCheckoutSignature,
  verifyWebhookSignature,
};
