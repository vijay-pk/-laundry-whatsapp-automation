/**
 * src/services/whatsappPayService.js
 * WhatsApp Pay (India): in-chat payments via an order_details message, as an
 * alternative to the Razorpay web link. The admin picks the provider in Payment Settings.
 *
 * Flow:
 *   booking confirmed with "Pay" -> booking Pending/awaiting_payment -> order_details message
 *   customer pays inside WhatsApp (gateway linked in WhatsApp Manager)
 *   -> WhatsApp webhook statuses[type=payment] (signature-verified by /webhook)
 *   -> confirmWhatsAppPaid (row lock, idempotent) -> booking Confirmed + receipt + admin alert
 * Missed webhooks are recovered with Meta's payment lookup API (sync job + track/yes).
 */

const { query, withTransaction } = require('../config/db');
const { sendOrderDetailsMessage, lookupWhatsAppPayment } = require('./whatsappService');
const { replyText, safeLog, notifyAdmin, maskPhone } = require('./replyService');
const { notifyPaymentSuccess, paymentLink } = require('./paymentService');
const payments = require('../models/paymentModel');
const { businessKnowledge } = require('../config/businessKnowledge');
const { bookingRef } = require('../config/orderStatuses');
const { formatINR, toPaise } = require('../utils/money');
const { formatDateTime } = require('../utils/formatDate');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const MIN_EXPIRY_SECONDS = 300; // Meta minimum
const expiryHours = () => {
  const hours = Number(process.env.WHATSAPP_PAY_EXPIRY_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours : 24;
};

const MAX_ATTEMPTS = 20;

// reference_id: max 35 chars, letters/digits/_-. only; unique per payment request.
const referenceFor = (booking, attempt) => `lb${booking.id.replace(/-/g, '').slice(0, 24)}-${attempt}`;

const isExpired = (payment) =>
  Date.now() - new Date(payment.created_at).getTime() > Math.max(expiryHours() * 3600, MIN_EXPIRY_SECONDS) * 1000 - 60000;

// ---------------------------------------------------------------------------
// 2. Payment request (order_details message)
// ---------------------------------------------------------------------------

/**
 * Send (or re-send) the WhatsApp Pay request for a booking awaiting payment.
 * Reuses the latest unexpired request; creates a new reference after expiry.
 * @returns {Promise<object>} payments row used
 */
const requestPayment = async (booking) => {
  const terms = booking.payment_terms || {};
  const configuration = terms.whatsappPayConfiguration;
  const gateway = terms.whatsappPayGateway;
  if (!configuration || !gateway) throw Object.assign(new Error('Booking has no WhatsApp Pay configuration'), { status: 409 });

  const amount = Number(booking.amount_due_now);
  const history = (await payments.listPaymentsForBooking(booking.id)).filter((p) => p.provider === 'whatsapp_pay');
  let payment = history.find((p) => ['created', 'failed'].includes(p.status) && !isExpired(p) && Number(p.amount_paise) === toPaise(amount));

  if (!payment) {
    const attempt = history.length + 1;
    if (attempt > MAX_ATTEMPTS) throw Object.assign(new Error('Too many payment requests for this booking'), { status: 429 });
    payment = await payments.createWhatsAppPayment({ query }, {
      bookingId: booking.id,
      businessId: booking.business_id,
      referenceId: referenceFor(booking, attempt),
      configuration,
      gateway,
      amount,
      currency: booking.currency || 'INR',
      paymentType: booking.payment_mode === 'advance' ? 'advance' : 'full',
    });
    if (!payment) payment = await payments.findPaymentByReference(referenceFor(booking, attempt));
  }

  const service = businessKnowledge.services.find((s) => s.name === booking.service_type);
  const advance = booking.payment_mode === 'advance';
  const remaining = Math.max(Number(booking.total_amount) - amount, 0);
  const quantity = booking.quantity ? ` (${Number(booking.quantity)} ${booking.unit === 'kg' ? 'kg' : 'pcs'})` : '';
  const expiresAt = new Date(new Date(payment.created_at).getTime() + expiryHours() * 3600 * 1000);

  await sendOrderDetailsMessage(booking.client_phone, {
    referenceId: payment.wa_reference_id,
    configuration: payment.wa_payment_configuration,
    gateway: payment.gateway,
    bodyText: [
      `Booking #${bookingRef(booking)} - ${booking.service_type}${quantity}`,
      booking.scheduled_time ? `Pickup: ${formatDateTime(new Date(booking.scheduled_time))}` : null,
      `Total: ${formatINR(booking.total_amount)}`,
      advance ? `Pay now (advance): ${formatINR(amount)} · Remaining later: ${formatINR(remaining)}` : `Pay now: ${formatINR(amount)}`,
      'Tap *Review and pay* to pay securely in WhatsApp.',
    ].filter(Boolean).join('\n'),
    footerText: businessKnowledge.name.replace('[EDIT] ', ''),
    totalPaise: toPaise(amount),
    items: [{
      retailerId: service?.id || 'laundry',
      name: `${advance ? 'Advance - ' : ''}${booking.service_type}${quantity} #${bookingRef(booking)}`,
      amountPaise: toPaise(amount),
      quantity: 1,
    }],
    expiresAt: expiresAt.getTime() - Date.now() > MIN_EXPIRY_SECONDS * 1000 ? expiresAt : new Date(Date.now() + MIN_EXPIRY_SECONDS * 1000 + 60000),
    receipt: payment.wa_reference_id,
    notes: { booking_id: booking.id },
  });

  await safeLog(booking, 'outbound', `[WhatsApp Pay request ${formatINR(amount)} ref ${payment.wa_reference_id}]`, 'payment', booking.client_phone);
  return payment;
};

// ---------------------------------------------------------------------------
// 3. Payment results (webhooks + lookup)
// ---------------------------------------------------------------------------

/**
 * Mark a WhatsApp Pay request as paid. Idempotent (row lock on the payment).
 * @returns {Promise<{outcome: 'paid_now'|'already_paid'|'unknown_reference'|'amount_mismatch', booking?, payment?}>}
 */
const confirmWhatsAppPaid = async ({ referenceId, amountPaise, gatewayOrderId, pgTransactionId, source }) => {
  const result = await withTransaction(async (tx) => {
    const payment = await payments.lockPaymentByReference(tx, referenceId);
    if (!payment) return { outcome: 'unknown_reference' };
    if (['paid', 'refunded', 'partially_refunded'].includes(payment.status)) return { outcome: 'already_paid', payment };
    if (amountPaise !== undefined && Number(amountPaise) !== Number(payment.amount_paise)) {
      console.error(`[whatsapp-pay] Amount mismatch for ${referenceId}: got ${amountPaise}, expected ${payment.amount_paise}`);
      return { outcome: 'amount_mismatch' };
    }
    const booking = await payments.lockBooking(tx, payment.booking_id);
    const paid = await payments.markWhatsAppPaymentPaid(tx, payment.id, { gatewayOrderId, pgTransactionId });

    // An older payment request for the same booking was already paid: never count money twice.
    if (['paid', 'partially_paid', 'refunded'].includes(booking.payment_status)) {
      await tx.query('UPDATE bookings SET refund_required = TRUE, updated_at = NOW() WHERE id = $1', [booking.id]);
      return { outcome: 'duplicate_payment', payment: paid, booking };
    }

    const updated = await payments.applyPaymentToBooking(tx, booking, paid.amount);
    return { outcome: 'paid_now', payment: paid, booking: updated };
  });

  if (result.outcome === 'duplicate_payment') {
    console.error(`[whatsapp-pay] Second payment for booking ${result.booking.id} (${referenceId}): refund needed`);
    await notifyAdmin([
      '⚠️ Customer paid twice - refund needed',
      `Booking #${bookingRef(result.booking)} (+${result.booking.client_phone})`,
      `Extra payment: ${formatINR(result.payment.amount)} (ref ${result.payment.pg_transaction_id || referenceId})`,
    ]).catch(() => {});
  }

  if (result.outcome === 'paid_now') {
    console.log(`[whatsapp-pay] Booking ${result.booking.id} ${result.booking.payment_status} via ${source} (${referenceId})`);
    await notifyPaymentSuccess(result.booking, result.payment);
  }
  return result;
};

const recordWhatsAppFailure = async ({ referenceId, reason }) =>
  withTransaction(async (tx) => {
    const payment = await payments.lockPaymentByReference(tx, referenceId);
    if (!payment) return 'unknown_reference';
    if (!['created', 'failed'].includes(payment.status)) return 'ignored';
    await payments.markPaymentFailed(tx, payment.id, reason);
    await payments.markBookingPaymentFailed(tx, payment.booking_id);
    return 'failed';
  });

const recordWhatsAppRefunds = async (pgTransactionId, refunds = []) => {
  if (!pgTransactionId) return;
  for (const refund of refunds) {
    if (!refund?.id) continue;
    const status = refund.status === 'success' ? 'processed' : refund.status === 'failed' ? 'failed' : 'pending';
    await withTransaction((tx) =>
      payments.recordRefund(tx, { pgTransactionId, refundId: refund.id, amountPaise: Number(refund.amount?.value) || 0, status })
    );
  }
};

// Payment status updates in a WhatsApp webhook body: entry[].changes[].value.statuses[type=payment]
const extractPaymentStatuses = (body) =>
  (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry) =>
    (Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) =>
      (Array.isArray(change?.value?.statuses) ? change.value.statuses : []).filter((s) => s?.type === 'payment' && s.payment)
    )
  );

/**
 * Process payment status updates from a (signature-verified) WhatsApp webhook. Never throws.
 */
const handlePaymentStatuses = async (body) => {
  for (const status of extractPaymentStatuses(body)) {
    const p = status.payment;
    const referenceId = String(p.reference_id || '');
    const tx = p.transaction || {};
    try {
      if (!/^[A-Za-z0-9_.-]{1,35}$/.test(referenceId)) continue;
      const amountPaise = p.amount?.offset === 100 ? p.amount.value : undefined;

      if (tx.status === 'success' || status.status === 'captured') {
        await confirmWhatsAppPaid({ referenceId, amountPaise, gatewayOrderId: tx.id, pgTransactionId: tx.pg_transaction_id, source: 'webhook' });
      } else if (tx.status === 'failed' || status.status === 'failed') {
        const outcome = await recordWhatsAppFailure({ referenceId, reason: tx.error?.reason || tx.error?.code || 'Payment failed' });
        console.log(`[whatsapp-pay] ${referenceId} failure -> ${outcome}`);
      }
      if (Array.isArray(p.refunds) && p.refunds.length) await recordWhatsAppRefunds(tx.pg_transaction_id, p.refunds);
    } catch (err) {
      console.error(`[whatsapp-pay] Could not process payment status for ${referenceId}: ${err.message}`);
    }
  }
};

/**
 * Reconcile one unpaid WhatsApp Pay request with Meta's lookup API. Never throws.
 */
const syncWhatsAppPayment = async (payment) => {
  try {
    const [result] = await lookupWhatsAppPayment(payment.wa_payment_configuration, payment.wa_reference_id);
    if (!result) return 'not_found';
    const transactions = Array.isArray(result.transactions) ? result.transactions : [];
    const success = transactions.find((t) => t.status === 'success');

    if (result.status === 'captured' || success) {
      const amountPaise = result.amount?.offset === 100 ? result.amount.value : undefined;
      const { outcome } = await confirmWhatsAppPaid({
        referenceId: payment.wa_reference_id, amountPaise, gatewayOrderId: success?.id, pgTransactionId: success?.pg_transaction_id, source: 'lookup',
      });
      return outcome;
    }
    if (transactions.length && transactions.every((t) => t.status === 'failed') && payment.status === 'created') {
      return recordWhatsAppFailure({ referenceId: payment.wa_reference_id, reason: transactions[0].error?.reason || 'Payment failed' });
    }
    return 'pending';
  } catch (err) {
    console.error(`[whatsapp-pay] Sync failed for ${payment.wa_reference_id}: ${err.message}`);
    return 'error';
  }
};

// Background job: reconcile recent unpaid WhatsApp Pay requests.
const syncPendingWhatsAppPayments = async () => {
  const pending = await payments.listPendingWhatsAppPayments();
  for (const payment of pending) await syncWhatsAppPayment(payment);
  return pending.length;
};

// Reconcile before showing a booking's payment state to the customer (track / "yes").
const syncBookingIfWhatsAppPay = async (booking) => {
  if (booking?.payment_method !== 'whatsapp_pay' || !['pending', 'failed'].includes(booking.payment_status)) return booking;
  const history = await payments.listPaymentsForBooking(booking.id);
  for (const payment of history.filter((p) => p.provider === 'whatsapp_pay' && ['created', 'failed'].includes(p.status))) {
    await syncWhatsAppPayment(payment);
  }
  const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [booking.id]);
  return rows[0] || booking;
};

// ---------------------------------------------------------------------------
// 4. Customer-facing helpers (used by booking, tracking, duplicate guard)
// ---------------------------------------------------------------------------

// One line telling the customer how to pay a booking that awaits online payment.
const paymentInstruction = (booking) =>
  booking.payment_method === 'whatsapp_pay'
    ? 'Tap *Review and pay* on the payment message in this chat (reply *pay* to get it again).'
    : `Pay here: ${paymentLink(booking)}`;

/**
 * Re-send the payment request for WhatsApp Pay bookings (Razorpay links are in the text already).
 * Failures are reported to the customer and admin; never throws.
 */
const remindPayment = async (booking) => {
  if (booking?.payment_method !== 'whatsapp_pay') return false;
  try {
    await requestPayment(booking);
    return true;
  } catch (err) {
    console.error(`[whatsapp-pay] Payment request failed for booking ${booking.id} (${maskPhone(booking.client_phone)}): ${err.message}`);
    await replyText(booking.client_phone, booking, "Sorry, we couldn't open WhatsApp Pay right now. Our team will contact you about the payment.", 'payment').catch(() => {});
    await notifyAdmin([
      '⚠️ WhatsApp Pay request failed',
      `Booking #${bookingRef(booking)} (+${booking.client_phone})`,
      `Error: ${err.message}${err.hint ? ` (${err.hint})` : ''}`,
    ]).catch(() => {});
    return false;
  }
};

module.exports = {
  referenceFor,
  requestPayment,
  remindPayment,
  paymentInstruction,
  confirmWhatsAppPaid,
  recordWhatsAppFailure,
  extractPaymentStatuses,
  handlePaymentStatuses,
  syncWhatsAppPayment,
  syncPendingWhatsAppPayments,
  syncBookingIfWhatsAppPay,
};
