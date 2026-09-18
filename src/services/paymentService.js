/**
 * src/services/paymentService.js
 * Optional payments: quote terms from business settings, run Razorpay checkout,
 * verify and reconcile payments, process webhooks, record cash.
 *
 * Money rules:
 *   - Amounts always come from the database (booking snapshot), never from the browser.
 *   - A payment is successful only after Razorpay signature verification, a verified
 *     webhook, or a server-side fetch from the Razorpay API.
 *   - Every success/failure runs in a transaction with row locks, so duplicate callbacks,
 *     webhooks and retries are processed once.
 */

const { isQrChannel } = require('../config/channel');
const { withTransaction } = require('../config/db');
const razorpay = require('./razorpayService');
const { replyText, notifyAdmin, maskPhone } = require('./replyService');
const { alertAdminNewBooking } = require('./notificationService');
const { notifyAdminGeofencedBooking } = require('./serviceAreaService');
const { getPaymentSettings } = require('../models/paymentSettingsModel');
const payments = require('../models/paymentModel');
const { calculatePaymentTerms, formatINR, toPaise } = require('../utils/money');
const { formatDateTime } = require('../utils/formatDate');
const { sha256, randomToken } = require('../utils/passwords');

const PAYMENT_STATUS_LABELS = {
  not_required: 'Not required',
  pending: 'Pending',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
};

const ORDER_ID = /^order_[A-Za-z0-9]{6,40}$/;
const PAYMENT_ID = /^pay_[A-Za-z0-9]{6,40}$/;

const createError = (message, status) => Object.assign(new Error(message), { status });
const bookingRef = (booking) => booking.id.slice(0, 8).toUpperCase();
const publicBaseUrl = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const paymentLink = (booking) => `${publicBaseUrl()}/pay/${booking.payment_token}`;

// ---------------------------------------------------------------------------
// 1. Quotes (chat booking)
// ---------------------------------------------------------------------------

/**
 * What the chat booking flow should offer for this business right now.
 * @returns {Promise<{required: boolean, online: boolean, cod: boolean, settings: object}>}
 */
const getPaymentOptions = async (businessId) => {
  if (!businessId) return { required: false, online: false, cod: false, settings: null };
  const settings = await getPaymentSettings(businessId);
  if (!settings.paymentEnabled) return { required: false, online: false, cod: false, settings };

  // Online provider chosen by the admin: Razorpay web link or in-chat WhatsApp Pay.
  const provider = settings.onlineProvider === 'whatsapp_pay' ? 'whatsapp_pay' : 'razorpay';
  const online = provider === 'whatsapp_pay'
    ? Boolean(settings.whatsappPayConfiguration && settings.whatsappPayGateway) && !isQrChannel() // no order_details over QR login
    : razorpay.isConfigured() && Boolean(publicBaseUrl());
  const cod = settings.allowCashOnDelivery;
  if (!online && !cod) {
    console.error(`[payment] Payment enabled but ${provider} is not configured and COD off: bookings will not require payment`);
    return { required: false, online: false, cod: false, provider, settings };
  }
  return { required: true, online, cod, provider, settings };
};

// Payment terms for a total under the given settings (snapshot stored on the booking).
const quote = (settings, total) =>
  calculatePaymentTerms(total, {
    mode: settings.paymentMode,
    advanceType: settings.advanceType,
    advanceValue: settings.advanceValue,
  });

// Booking fields for createBooking when payment applies. method: 'razorpay' | 'whatsapp_pay' | 'cod'
const paymentFieldsForBooking = (settings, total, method) => {
  const terms = quote(settings, total);
  const snapshot = {
    mode: terms.mode,
    advanceType: terms.advanceType,
    advanceValue: terms.advanceValue,
    allowCashOnDelivery: settings.allowCashOnDelivery,
    quotedAt: new Date().toISOString(),
  };

  if (method === 'cod') {
    return {
      totalAmount: terms.total,
      paymentStatus: 'pending',
      paymentMethod: 'cod',
      paymentMode: 'full',
      paymentTerms: { ...snapshot, method: 'cod' },
      amountDueNow: 0,
      amountRemaining: terms.total,
      status: 'Confirmed',
      bookingState: 'confirmed',
    };
  }

  const online = {
    totalAmount: terms.total,
    paymentStatus: 'pending',
    paymentMode: terms.mode,
    amountDueNow: terms.dueNow,
    amountRemaining: terms.total, // nothing paid yet
    status: 'Pending',
    bookingState: 'awaiting_payment',
  };

  if (method === 'whatsapp_pay') {
    return {
      ...online,
      paymentMethod: 'whatsapp_pay',
      // Configuration used for this booking is kept even if the admin changes it later.
      paymentTerms: {
        ...snapshot,
        method: 'whatsapp_pay',
        whatsappPayConfiguration: settings.whatsappPayConfiguration,
        whatsappPayGateway: settings.whatsappPayGateway,
      },
    };
  }

  return {
    ...online,
    paymentMethod: 'razorpay',
    paymentTerms: { ...snapshot, method: 'razorpay' },
    paymentToken: randomToken(32), // 64 hex chars, unguessable link id
  };
};

// Provider payment id shown to customers and admins.
const paymentReference = (payment) => payment.razorpay_payment_id || payment.pg_transaction_id || payment.wa_reference_id || '-';

// Human-readable lines for WhatsApp messages / receipts.
const amountLines = (booking) => [
  `Total: ${formatINR(booking.total_amount)}`,
  `Paid: ${formatINR(booking.amount_paid)}`,
  `Remaining: ${formatINR(booking.amount_remaining)}`,
  `Payment status: ${PAYMENT_STATUS_LABELS[booking.payment_status] || booking.payment_status}`,
];

// ---------------------------------------------------------------------------
// 2. Notifications after a verified payment
// ---------------------------------------------------------------------------
// Customer and admin notifications are attempted independently: one failing never blocks the other,
// and the payment (already committed) is never undone.
const notifyPaymentSuccess = async (booking, payment) => {
  await notifyCustomerOfPayment(booking, payment);
  await notifyAdminOfPayment(booking, payment);
};

const notifyCustomerOfPayment = async (booking, payment) => {
  const ref = bookingRef(booking);
  try {
    if (booking.status === 'Cancelled') {
      await replyText(booking.client_phone, booking, `We received your payment of ${formatINR(payment.amount)} for booking #${ref}, but this booking was cancelled. We will refund it.`, 'payment');
      return;
    }

    await replyText(
      booking.client_phone,
      booking,
      [
        '✅ Payment received - booking confirmed!',
        '',
        `Booking #${ref}`,
        `${booking.service_type} pickup: ${booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : 'to be scheduled'}`,
        '',
        ...amountLines(booking),
        `Payment ref: ${paymentReference(payment)}`,
        '',
        'Reply *track* anytime to check your order.',
      ].join('\n'),
      'payment'
    );
  } catch (err) {
    console.error(`[payment] Customer payment message failed for booking ${booking.id}: ${err.message}`);
  }
};

const notifyAdminOfPayment = async (booking, payment) => {
  const ref = bookingRef(booking);
  try {
    if (booking.status === 'Cancelled') {
      await notifyAdmin(['⚠️ Payment received for a CANCELLED booking - refund needed', `Booking: #${ref} (+${booking.client_phone})`, `Amount: ${formatINR(payment.amount)}`, `Payment ref: ${paymentReference(payment)}`]);
      return;
    }

    // Existing approved template (3 variables, unchanged) + a text with the payment breakdown.
    await alertAdminNewBooking(booking);
    await notifyAdmin([
      'New booking received (paid online).',
      `${booking.client_name || 'Customer'} booked ${booking.service_type} for ${booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : 'n/a'}.`,
      `Booking #${ref} (+${booking.client_phone})`,
      '',
      ...amountLines(booking),
      `Payment ref: ${paymentReference(payment)}`,
    ]);
    // Geofenced booking: the location notice waits for the payment (unpaid bookings aren't pickups yet).
    await notifyAdminGeofencedBooking(booking);
  } catch (err) {
    console.error(`[payment] Admin payment notice failed for booking ${booking.id}: ${err.message}`);
  }
};

// ---------------------------------------------------------------------------
// 3. Core state changes (idempotent, transactional)
// ---------------------------------------------------------------------------

/**
 * Mark a Razorpay order as paid. Safe to call repeatedly from checkout, webhooks and sync.
 * @returns {Promise<'paid_now'|'already_paid'|'unknown_order'>}
 */
const confirmPaid = async ({ orderId, paymentId, source, db = null }) => {
  const run = async (tx) => {
    const payment = await payments.lockPaymentByOrderId(tx, orderId);
    if (!payment) return { outcome: 'unknown_order' };
    if (payment.status === 'paid' || payment.status === 'refunded' || payment.status === 'partially_refunded') {
      if (paymentId && payment.razorpay_payment_id && payment.razorpay_payment_id !== paymentId) {
        console.error(`[payment] Second payment ${paymentId} for already-paid order ${orderId}: refund may be needed`);
      }
      return { outcome: 'already_paid', payment };
    }

    const booking = await payments.lockBooking(tx, payment.booking_id);
    const paid = await payments.markPaymentPaid(tx, payment.id, paymentId);
    const updated = await payments.applyPaymentToBooking(tx, booking, paid.amount);
    return { outcome: 'paid_now', payment: paid, booking: updated };
  };

  const result = db ? await run(db) : await withTransaction(run);
  if (result.outcome === 'paid_now') {
    console.log(`[payment] Booking ${result.booking.id} ${result.booking.payment_status} via ${source} (${result.payment.razorpay_payment_id})`);
  }
  return result;
};

/**
 * Record a failed Razorpay attempt. Never overrides a successful payment.
 * @returns {Promise<'failed'|'ignored'|'unknown_order'>}
 */
const recordFailure = async ({ orderId, reason, db = null }) => {
  const run = async (tx) => {
    const payment = await payments.lockPaymentByOrderId(tx, orderId);
    if (!payment) return 'unknown_order';
    if (!['created', 'failed'].includes(payment.status)) return 'ignored';
    await payments.markPaymentFailed(tx, payment.id, reason);
    await payments.markBookingPaymentFailed(tx, payment.booking_id);
    return 'failed';
  };
  return db ? run(db) : withTransaction(run);
};

// ---------------------------------------------------------------------------
// 4. Customer checkout (payment page)
// ---------------------------------------------------------------------------
const loadPayableBooking = async (token) => {
  const booking = await payments.getBookingByPaymentToken(token);
  if (!booking) throw createError('Payment link not found', 404);
  if (booking.payment_method !== 'razorpay') throw createError('This booking has no online payment', 409);
  return booking;
};

/**
 * Create (or reuse) the Razorpay order for a booking. Amount = booking.amount_due_now from the DB.
 * @returns {Promise<{alreadyPaid?: true, keyId?, orderId?, amountPaise?, currency?, bookingRef?, prefill?}>}
 */
const startCheckout = async (token) => {
  const booking = await loadPayableBooking(token);
  if (['paid', 'partially_paid', 'refunded'].includes(booking.payment_status)) return { alreadyPaid: true };
  if (booking.status === 'Cancelled') throw createError('This booking was cancelled', 409);

  const amount = Number(booking.amount_due_now);

  const payment = await withTransaction(async (tx) => {
    // Lock the booking so concurrent "Pay" clicks create at most one order.
    const locked = await payments.lockBooking(tx, booking.id);
    if (['paid', 'partially_paid'].includes(locked.payment_status)) return null;

    const reusable = await payments.findReusableRazorpayPayment(tx, booking.id, amount);
    if (reusable) return reusable;

    const order = await razorpay.createOrder({
      amountPaise: toPaise(amount),
      currency: booking.currency || 'INR',
      receipt: `bk_${booking.id.slice(0, 8)}_${Date.now()}`,
      notes: { booking_id: booking.id, business_id: booking.business_id },
    });
    if (order.amount !== toPaise(amount)) throw createError('Razorpay order amount mismatch', 502);

    return payments.createRazorpayPayment(tx, {
      bookingId: booking.id,
      businessId: booking.business_id,
      orderId: order.id,
      amount,
      currency: booking.currency || 'INR',
      paymentType: booking.payment_mode === 'advance' ? 'advance' : 'full',
    });
  });

  if (!payment) return { alreadyPaid: true };

  return {
    keyId: razorpay.publicKeyId(),
    orderId: payment.razorpay_order_id,
    amountPaise: payment.amount_paise,
    currency: payment.currency,
    bookingRef: bookingRef(booking),
    description: `${booking.service_type} - booking #${bookingRef(booking)}`,
    prefill: { name: booking.client_name || '', contact: `+${booking.client_phone}` },
  };
};

// Check a Razorpay payment entity against our order and capture if needed.
const settleRazorpayPayment = async (entity, paymentRow) => {
  if (entity.order_id !== paymentRow.razorpay_order_id || Number(entity.amount) !== Number(paymentRow.amount_paise)) {
    console.error(`[payment] Payment ${entity.id} does not match order ${paymentRow.razorpay_order_id} (order/amount mismatch)`);
    return 'mismatch';
  }
  if (entity.status === 'captured') return 'captured';
  if (entity.status === 'authorized') {
    const captured = await razorpay.capturePayment(entity.id, paymentRow.amount_paise, paymentRow.currency);
    return captured.status === 'captured' ? 'captured' : 'pending';
  }
  if (entity.status === 'failed') return 'failed';
  return 'pending';
};

/**
 * Checkout success callback from the browser: {razorpay_order_id, razorpay_payment_id, razorpay_signature}.
 * @returns {Promise<{result: 'paid'|'failed'|'pending', booking: object}>}
 */
const verifyCheckout = async (token, body = {}) => {
  const booking = await loadPayableBooking(token);
  const orderId = String(body.razorpay_order_id || '');
  const paymentId = String(body.razorpay_payment_id || '');
  const signature = String(body.razorpay_signature || '');

  if (!ORDER_ID.test(orderId) || !PAYMENT_ID.test(paymentId)) throw createError('Invalid payment details', 400);
  if (!razorpay.verifyCheckoutSignature(orderId, paymentId, signature)) {
    console.warn(`[payment] Invalid checkout signature for booking ${booking.id}`);
    throw createError('Payment verification failed', 400);
  }

  const history = await payments.listPaymentsForBooking(booking.id);
  const paymentRow = history.find((p) => p.razorpay_order_id === orderId);
  if (!paymentRow) throw createError('Payment does not belong to this booking', 400);

  // Signature is Razorpay's proof of payment; also confirm state/amount from the API when reachable.
  let state = 'captured';
  try {
    state = await settleRazorpayPayment(await razorpay.fetchPayment(paymentId), paymentRow);
  } catch (err) {
    console.warn(`[payment] Could not fetch payment ${paymentId}, relying on verified signature: ${err.message}`);
  }

  if (state === 'mismatch') throw createError('Payment verification failed', 400);
  if (state === 'failed') {
    await recordFailure({ orderId, reason: 'Payment failed' });
    return { result: 'failed', booking: await payments.getBookingByPaymentToken(token) };
  }
  if (state === 'pending') return { result: 'pending', booking };

  const outcome = await confirmPaid({ orderId, paymentId, source: 'checkout' });
  if (outcome.outcome === 'paid_now') await notifyPaymentSuccess(outcome.booking, outcome.payment);
  return { result: 'paid', booking: await payments.getBookingByPaymentToken(token) };
};

/**
 * Reconcile a booking's unpaid Razorpay orders with Razorpay (page load, retry, "check status").
 * Recovers payments whose browser callback or webhook never arrived. Never throws.
 */
const syncBookingPayments = async (booking) => {
  if (booking.payment_method !== 'razorpay' || !['pending', 'failed'].includes(booking.payment_status)) return booking;

  try {
    const history = await payments.listPaymentsForBooking(booking.id);
    for (const row of history.filter((p) => p.provider === 'razorpay' && ['created', 'failed'].includes(p.status))) {
      const attempts = await razorpay.fetchOrderPayments(row.razorpay_order_id);
      let settledId = null;
      let failed = false;

      for (const entity of attempts) {
        const state = await settleRazorpayPayment(entity, row);
        if (state === 'captured') settledId = entity.id;
        if (state === 'failed') failed = true;
      }

      if (settledId) {
        const outcome = await confirmPaid({ orderId: row.razorpay_order_id, paymentId: settledId, source: 'sync' });
        if (outcome.outcome === 'paid_now') await notifyPaymentSuccess(outcome.booking, outcome.payment);
      } else if (failed && row.status === 'created') {
        await recordFailure({ orderId: row.razorpay_order_id, reason: attempts.find((a) => a.status === 'failed')?.error_description });
      }
    }
  } catch (err) {
    console.error(`[payment] Sync failed for booking ${booking.id}: ${err.message}`);
  }
  return (await payments.getBookingByPaymentToken(booking.payment_token)) || booking;
};

// ---------------------------------------------------------------------------
// 5. Razorpay webhooks
// ---------------------------------------------------------------------------

/**
 * Process a verified webhook once (by event id). Returns a short outcome for logging.
 * @param {Buffer} rawBody
 * @param {object} headers  { signature, eventId }
 */
const handleWebhook = async (rawBody, { signature, eventId }) => {
  if (!razorpay.verifyWebhookSignature(rawBody, signature)) throw createError('Invalid webhook signature', 401);

  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw createError('Invalid webhook body', 400);
  }

  const event = String(body.event || '');
  const id = eventId || sha256(rawBody);
  const paymentEntity = body.payload?.payment?.entity;
  const refundEntity = body.payload?.refund?.entity;

  const result = await withTransaction(async (tx) => {
    if (!(await payments.recordWebhookEvent(tx, id, event))) return { outcome: 'duplicate' };

    switch (event) {
      case 'payment.captured':
      case 'order.paid':
        if (!paymentEntity?.order_id) return { outcome: 'ignored' };
        return confirmPaid({ orderId: paymentEntity.order_id, paymentId: paymentEntity.id, source: `webhook:${event}`, db: tx });
      case 'payment.failed':
        if (!paymentEntity?.order_id) return { outcome: 'ignored' };
        return { outcome: await recordFailure({ orderId: paymentEntity.order_id, reason: paymentEntity.error_description, db: tx }) };
      case 'refund.created':
      case 'refund.processed':
      case 'refund.failed':
        if (!refundEntity?.payment_id) return { outcome: 'ignored' };
        await payments.recordRefund(tx, {
          razorpayPaymentId: refundEntity.payment_id,
          refundId: refundEntity.id,
          amountPaise: Number(refundEntity.amount) || 0,
          status: event === 'refund.processed' ? 'processed' : event === 'refund.failed' ? 'failed' : 'pending',
        });
        return { outcome: 'refund_recorded' };
      default:
        return { outcome: 'ignored' };
    }
  });

  // Notify only after the transaction committed.
  if (result.outcome === 'paid_now') await notifyPaymentSuccess(result.booking, result.payment);
  console.log(`[payment] Webhook ${event} ${id.slice(0, 20)} -> ${result.outcome}`);
  return result.outcome;
};

// ---------------------------------------------------------------------------
// 6. Cash (admin dashboard): record money collected at pickup/delivery
// ---------------------------------------------------------------------------
const recordCashPayment = async ({ bookingId, businessId }) => {
  const result = await withTransaction(async (tx) => {
    const booking = await payments.lockBooking(tx, bookingId);
    // Ownership check: an admin can only record cash for their own business.
    if (!booking || (businessId && booking.business_id !== businessId)) throw createError('Booking not found', 404);
    if (booking.total_amount === null) throw createError('This booking has no amount to collect', 409);

    const remaining = Number(booking.amount_remaining);
    if (!(remaining > 0) || !['pending', 'partially_paid'].includes(booking.payment_status)) {
      throw createError('Nothing left to collect for this booking', 409);
    }
    // Online payments must be verified by the provider; cash is for COD bookings and advance balances only.
    if (['razorpay', 'whatsapp_pay'].includes(booking.payment_method) && ['pending', 'failed'].includes(booking.payment_status)) {
      throw createError('Online payment is still pending; it can only be confirmed by Razorpay or WhatsApp Pay', 409);
    }

    const payment = await payments.createCashPayment(tx, {
      bookingId,
      businessId: booking.business_id,
      amount: remaining,
      currency: booking.currency || 'INR',
      paymentType: booking.payment_status === 'partially_paid' ? 'balance' : 'full',
    });
    const updated = await payments.applyPaymentToBooking(tx, booking, remaining);
    return { booking: updated, payment };
  });

  console.log(`[payment] Cash ${formatINR(result.payment.amount)} recorded for booking ${bookingId} (${maskPhone(result.booking.client_phone)})`);
  return result;
};

module.exports = {
  notifyPaymentSuccess,
  paymentReference,
  PAYMENT_STATUS_LABELS,
  getPaymentOptions,
  quote,
  paymentFieldsForBooking,
  paymentLink,
  amountLines,
  startCheckout,
  verifyCheckout,
  syncBookingPayments,
  handleWebhook,
  recordCashPayment,
  confirmPaid,
  recordFailure,
};
