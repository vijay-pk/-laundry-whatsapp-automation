/**
 * src/models/paymentModel.js
 * Payment records, booking payment fields and webhook idempotency.
 * Functions taking `db` accept either a transaction client or { query } from config/db.
 */

const { query } = require('../config/db');
const { toPaise } = require('../utils/money');

const defaultDb = { query };

// ---------------------------------------------------------------------------
// Bookings (payment side)
// ---------------------------------------------------------------------------
const getBookingByPaymentToken = async (token, db = defaultDb) => {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,64}$/.test(token)) return null;
  const { rows } = await db.query('SELECT * FROM bookings WHERE payment_token = $1', [token]);
  return rows[0] || null;
};

const lockBooking = async (db, bookingId) => {
  const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
  return rows[0] || null;
};

/**
 * Record money received on a booking (never lowers amounts; caps at the total).
 * Booking status becomes Confirmed unless the booking was cancelled meanwhile
 * (then refund_required is set instead).
 */
const applyPaymentToBooking = async (db, booking, amountRupees) => {
  const total = Number(booking.total_amount);
  const paid = Math.min(Number(booking.amount_paid) + Number(amountRupees), total);
  const remaining = Math.max(Math.round((total - paid) * 100) / 100, 0);
  const paymentStatus = remaining === 0 ? 'paid' : 'partially_paid';
  const cancelled = booking.status === 'Cancelled';

  const { rows } = await db.query(
    `UPDATE bookings
     SET amount_paid = $2,
         amount_remaining = $3,
         payment_status = $4,
         -- Only a booking still waiting (Pending) becomes Confirmed; later stages keep their status.
         status = CASE WHEN NOT $5 AND status = 'Pending' THEN 'Confirmed' ELSE status END,
         booking_state = CASE WHEN NOT $5 AND booking_state IN ('pending', 'awaiting_payment') THEN 'confirmed' ELSE booking_state END,
         refund_required = refund_required OR $5,
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [booking.id, paid, remaining, paymentStatus, cancelled]
  );
  return rows[0];
};

// A failed attempt never overrides money already received.
const markBookingPaymentFailed = async (db, bookingId) => {
  const { rows } = await db.query(
    `UPDATE bookings SET payment_status = 'failed', updated_at = NOW()
     WHERE id = $1 AND payment_status IN ('pending', 'failed')
     RETURNING *`,
    [bookingId]
  );
  return rows[0] || null;
};

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
const createRazorpayPayment = async (db, { bookingId, businessId, orderId, amount, currency, paymentType }) => {
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, business_id, provider, razorpay_order_id, amount, amount_paise, currency, payment_type, status)
     VALUES ($1, $2, 'razorpay', $3, $4, $5, $6, $7, 'created')
     RETURNING *`,
    [bookingId, businessId, orderId, amount, toPaise(amount), currency, paymentType]
  );
  return rows[0];
};

// Latest unpaid Razorpay order for a booking (can take another attempt) with the same amount.
const findReusableRazorpayPayment = async (db, bookingId, amount) => {
  const { rows } = await db.query(
    `SELECT * FROM payments
     WHERE booking_id = $1 AND provider = 'razorpay' AND status IN ('created', 'failed') AND amount_paise = $2
     ORDER BY created_at DESC LIMIT 1`,
    [bookingId, toPaise(amount)]
  );
  return rows[0] || null;
};

const lockPaymentByOrderId = async (db, orderId) => {
  const { rows } = await db.query('SELECT * FROM payments WHERE razorpay_order_id = $1 FOR UPDATE', [orderId]);
  return rows[0] || null;
};

const markPaymentPaid = async (db, paymentRowId, razorpayPaymentId) => {
  const { rows } = await db.query(
    `UPDATE payments
     SET status = 'paid', razorpay_payment_id = COALESCE($2, razorpay_payment_id), failure_reason = NULL,
         paid_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [paymentRowId, razorpayPaymentId]
  );
  return rows[0];
};

const markPaymentFailed = async (db, paymentRowId, reason) => {
  const { rows } = await db.query(
    `UPDATE payments SET status = 'failed', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('created', 'failed') RETURNING *`,
    [paymentRowId, String(reason || 'Payment failed').slice(0, 500)]
  );
  return rows[0] || null;
};

const createCashPayment = async (db, { bookingId, businessId, amount, currency, paymentType }) => {
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, business_id, provider, amount, amount_paise, currency, payment_type, status, paid_at)
     VALUES ($1, $2, 'cash', $3, $4, $5, $6, 'paid', NOW())
     RETURNING *`,
    [bookingId, businessId, amount, toPaise(amount), currency, paymentType]
  );
  return rows[0];
};

/**
 * Record a Razorpay refund against the payment (idempotent per refund id).
 * Marks the booking refunded when the whole payment has been refunded.
 */
const recordRefund = async (db, { razorpayPaymentId, pgTransactionId, refundId, amountPaise, status }) => {
  const { rows } = razorpayPaymentId
    ? await db.query('SELECT * FROM payments WHERE razorpay_payment_id = $1 FOR UPDATE', [razorpayPaymentId])
    : await db.query('SELECT * FROM payments WHERE pg_transaction_id = $1 FOR UPDATE', [pgTransactionId]);
  const payment = rows[0];
  if (!payment) return null;
  if (payment.razorpay_refund_id === refundId && payment.refund_status === status) return payment;

  const alreadyCounted = payment.razorpay_refund_id === refundId;
  const refunded = alreadyCounted
    ? Number(payment.refunded_amount)
    : Math.min(Number(payment.refunded_amount) + amountPaise / 100, Number(payment.amount));
  const fully = refunded >= Number(payment.amount);

  const updated = await db.query(
    `UPDATE payments
     SET refund_status = $2, refunded_amount = $3, razorpay_refund_id = $4,
         status = CASE WHEN $5 THEN 'refunded' ELSE 'partially_refunded' END, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [payment.id, status, refunded, refundId, fully]
  );
  if (fully && status === 'processed') {
    await db.query(`UPDATE bookings SET payment_status = 'refunded', refund_required = FALSE, updated_at = NOW() WHERE id = $1`, [payment.booking_id]);
  }
  return updated.rows[0];
};

// ---------------------------------------------------------------------------
// WhatsApp Pay
// ---------------------------------------------------------------------------
const createWhatsAppPayment = async (db, { bookingId, businessId, referenceId, configuration, gateway, amount, currency, paymentType }) => {
  const { rows } = await db.query(
    `INSERT INTO payments (booking_id, business_id, provider, wa_reference_id, wa_payment_configuration, gateway,
                           amount, amount_paise, currency, payment_type, status)
     VALUES ($1, $2, 'whatsapp_pay', $3, $4, $5, $6, $7, $8, $9, 'created')
     ON CONFLICT (wa_reference_id) DO NOTHING
     RETURNING *`,
    [bookingId, businessId, referenceId, configuration, gateway, amount, toPaise(amount), currency, paymentType]
  );
  return rows[0] || null;
};

const findPaymentByReference = async (referenceId, db = defaultDb) => {
  const { rows } = await db.query('SELECT * FROM payments WHERE wa_reference_id = $1', [referenceId]);
  return rows[0] || null;
};

const lockPaymentByReference = async (db, referenceId) => {
  const { rows } = await db.query('SELECT * FROM payments WHERE wa_reference_id = $1 FOR UPDATE', [referenceId]);
  return rows[0] || null;
};

const markWhatsAppPaymentPaid = async (db, paymentRowId, { gatewayOrderId, pgTransactionId }) => {
  const { rows } = await db.query(
    `UPDATE payments
     SET status = 'paid', gateway_order_id = COALESCE($2, gateway_order_id), pg_transaction_id = COALESCE($3, pg_transaction_id),
         failure_reason = NULL, paid_at = NOW(), updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [paymentRowId, gatewayOrderId || null, pgTransactionId || null]
  );
  return rows[0];
};

// Unpaid WhatsApp Pay requests to reconcile with Meta's lookup API (missed webhooks).
const listPendingWhatsAppPayments = async ({ maxAgeHours = 48, limit = 50 } = {}) => {
  const { rows } = await query(
    `SELECT p.* FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     WHERE p.provider = 'whatsapp_pay' AND p.status IN ('created', 'failed')
       AND b.payment_status IN ('pending', 'failed')
       AND p.created_at > NOW() - make_interval(hours => $1)
     ORDER BY p.created_at DESC LIMIT $2`,
    [maxAgeHours, limit]
  );
  return rows;
};

// Returns true the first time an event id is seen (inside the caller's transaction).
const recordWebhookEvent = async (db, eventId, event) => {
  const { rowCount } = await db.query(
    'INSERT INTO razorpay_webhook_events (event_id, event) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
    [eventId, event]
  );
  return rowCount === 1;
};

const listPaymentsForBooking = async (bookingId, db = defaultDb) => {
  const { rows } = await db.query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at DESC', [bookingId]);
  return rows;
};

/**
 * Bookings for the admin dashboard with their latest Razorpay references.
 * businessId null = all businesses (super admin only; enforced by the caller).
 */
const listBookingsWithPayments = async ({ businessId, limit = 200 }) => {
  const { rows } = await query(
    `SELECT b.*, biz.name AS business_name, p.razorpay_order_id, p.razorpay_payment_id, p.status AS last_payment_record_status,
            p.provider AS last_payment_provider, p.wa_reference_id, p.pg_transaction_id, p.gateway
     FROM bookings b
     JOIN businesses biz ON biz.id = b.business_id
     LEFT JOIN LATERAL (
       SELECT razorpay_order_id, razorpay_payment_id, status, provider, wa_reference_id, pg_transaction_id, gateway FROM payments
       WHERE booking_id = b.id ORDER BY (status = 'paid') DESC, created_at DESC LIMIT 1
     ) p ON TRUE
     WHERE ($1::uuid IS NULL OR b.business_id = $1)
       AND COALESCE(b.booking_state, '') <> 'rejected'
     ORDER BY b.created_at DESC
     LIMIT $2`,
    [businessId, limit]
  );
  return rows;
};

module.exports = {
  getBookingByPaymentToken,
  lockBooking,
  applyPaymentToBooking,
  markBookingPaymentFailed,
  createRazorpayPayment,
  findReusableRazorpayPayment,
  lockPaymentByOrderId,
  markPaymentPaid,
  markPaymentFailed,
  createCashPayment,
  recordRefund,
  createWhatsAppPayment,
  findPaymentByReference,
  lockPaymentByReference,
  markWhatsAppPaymentPaid,
  listPendingWhatsAppPayments,
  recordWebhookEvent,
  listPaymentsForBooking,
  listBookingsWithPayments,
};
