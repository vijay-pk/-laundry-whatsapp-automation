/**
 * src/controllers/payController.js
 * Customer payment page and its JSON endpoints, plus the Razorpay webhook.
 *
 *   GET  /pay/:token          payment page (reconciles with Razorpay first)
 *   POST /pay/:token/order    create/reuse Razorpay order (amount from DB)
 *   POST /pay/:token/verify   verify Checkout signature and record payment
 *   POST /pay/:token/sync     re-check status with Razorpay ("I already paid")
 *   POST /webhooks/razorpay   Razorpay webhook (signature-verified, idempotent)
 */

const paymentService = require('../services/paymentService');
const { getBookingByPaymentToken, listPaymentsForBooking } = require('../models/paymentModel');
const { query } = require('../config/db');
const { renderPayPage, renderPayNotFound } = require('../views/payPage');
const { newNonce, setPageHeaders } = require('../views/html');

// Friendly JSON errors; internal details stay in server logs.
const sendError = (res, err) => {
  const status = err.status && err.status < 600 ? err.status : 500;
  const message = status === 503
    ? 'Payment is temporarily unavailable. Please try again in a few minutes.'
    : status >= 500
      ? 'Something went wrong. Please try again.'
      : err.message;
  if (status >= 500) console.error(`[pay] ${err.message}`);
  return res.status(status).json({ success: false, error: message });
};

const showPaymentPage = async (req, res, next) => {
  const nonce = newNonce();
  try {
    let booking = await getBookingByPaymentToken(req.params.token);
    if (!booking) {
      setPageHeaders(res, nonce);
      return res.status(404).send(renderPayNotFound(nonce));
    }

    // Recovers payments whose browser callback or webhook was lost (never throws).
    booking = await paymentService.syncBookingPayments(booking);

    const [{ rows: biz }, history] = await Promise.all([
      query('SELECT name FROM businesses WHERE id = $1', [booking.business_id]),
      listPaymentsForBooking(booking.id),
    ]);
    const paidRazorpay = history.find((p) => p.provider === 'razorpay' && p.status !== 'created' && p.status !== 'failed');

    setPageHeaders(res, nonce, { razorpay: true });
    return res.send(renderPayPage({
      booking,
      businessName: biz[0]?.name || 'Laundry',
      paymentRef: paidRazorpay?.razorpay_payment_id || null,
      nonce,
      token: booking.payment_token,
    }));
  } catch (err) {
    return next(err);
  }
};

const createOrder = async (req, res) => {
  try {
    return res.json({ success: true, ...(await paymentService.startCheckout(req.params.token)) });
  } catch (err) {
    return sendError(res, err);
  }
};

const verifyPayment = async (req, res) => {
  try {
    const { result, booking } = await paymentService.verifyCheckout(req.params.token, req.body || {});
    return res.json({ success: result === 'paid', result, paymentStatus: booking?.payment_status });
  } catch (err) {
    return sendError(res, err);
  }
};

const syncPayment = async (req, res) => {
  try {
    const booking = await getBookingByPaymentToken(req.params.token);
    if (!booking) return res.status(404).json({ success: false, error: 'Payment link not found' });
    const updated = await paymentService.syncBookingPayments(booking);
    return res.json({ success: true, paymentStatus: updated.payment_status });
  } catch (err) {
    return sendError(res, err);
  }
};

/**
 * Razorpay webhook. 2xx tells Razorpay the event is handled (including duplicates and
 * events we ignore); errors return 5xx so Razorpay retries.
 */
const razorpayWebhook = async (req, res) => {
  try {
    const outcome = await paymentService.handleWebhook(req.rawBody, {
      signature: req.get('x-razorpay-signature'),
      eventId: req.get('x-razorpay-event-id'),
    });
    return res.json({ success: true, outcome });
  } catch (err) {
    if (err.status === 401 || err.status === 400) {
      console.warn(`[pay] Rejected Razorpay webhook: ${err.message}`);
      return res.status(err.status).json({ success: false });
    }
    console.error(`[pay] Webhook processing failed: ${err.message}`);
    return res.status(500).json({ success: false });
  }
};

module.exports = { showPaymentPage, createOrder, verifyPayment, syncPayment, razorpayWebhook };
