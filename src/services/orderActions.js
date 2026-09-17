/**
 * src/services/orderActions.js
 * Track, cancel, reschedule and confirm the right order when a customer has several.
 *   - order ref in the message ("cancel #A1B2C3D4") -> that order
 *   - one open order -> that order
 *   - several open orders -> list them (tap, or type the number or ref) -> chosen order
 *   - no open order -> latest order (explains it is delivered/cancelled) or "no orders"
 * Confirm ("yes") only considers Pending orders.
 * Cancelling always asks "Yes, cancel" / "No, keep it" first.
 * Order ids in taps are never trusted: every action re-loads the booking and checks
 * it belongs to the sender.
 */

const { sendTemplateMessage } = require('./whatsappService');
const { maskPhone, safeLog, replyText, replyButtons, replyList, notifyAdmin } = require('./replyService');
const { amountLines } = require('./paymentService');
const { paymentInstruction, remindPayment, syncBookingIfWhatsAppPay } = require('./whatsappPayService');
const { FLOW_INTENT, registerFlow, pickOption, textMatches, invalid, startReschedule } = require('./bookingFlow');
const {
  getBookingById,
  getLatestBookingForClient,
  getActiveBookingsForClient,
  findClientBookingByRef,
  updateBookingStatus,
} = require('../models/bookingModel');
const { saveSession, clearSession } = require('../models/sessionModel');
const { CHANGEABLE_STATUSES, CLOSED_STATUSES, bookingRef, statusMessage, awaitingOnlinePayment } = require('../config/orderStatuses');
const { formatDateTime } = require('../utils/formatDate');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const ORDER_FLOW = 'order';

// Approved template, assumed body: "Hi {{1}}, your {{2}} booking has been cancelled."
const CANCEL_TEMPLATE = process.env.TEMPLATE_BOOKING_CANCELLED || 'booking_cancelled';

// Outbound intent for replies that handed the customer to staff (excluded from AI learning).
const HANDOFF_INTENT = 'handoff';

const ACTIONS = ['track', 'cancel', 'reschedule', 'confirm'];
const ACTION_INTENT = { track: 'status', cancel: 'cancel', reschedule: 'reschedule', confirm: 'confirm' };
const PICK_QUESTIONS = {
  confirm: 'Which order do you want to confirm?',
  track: 'Which order do you want to track?',
  cancel: 'Which order do you want to cancel?',
  reschedule: 'Which pickup do you want to reschedule?',
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORDER_CHOICE = new RegExp(`^ord_(track|cancel|reschedule|confirm)_(${UUID})$`, 'i'); // row in the order list
const CANCEL_CHOICE = new RegExp(`^cxl_(yes|no)_(${UUID})$`, 'i'); // cancel confirmation buttons
const REF_IN_TEXT = /(?:^|[\s#])#?([0-9a-f]{8})(?=$|[\s.,!?])/i;

// Only these typed words answer the cancel question ("cancel" itself stops the flow and keeps the order).
const CANCEL_YES_WORDS = /^(yes|y|yes,? cancel( it)?|ok|okay|confirm)$/i;
const CANCEL_NO_WORDS = /^(no|n|keep|keep it|no,? keep( it)?)$/i;

// ---------------------------------------------------------------------------
// 2. Lookups (always scoped to the sender's phone number)
// ---------------------------------------------------------------------------
const ownedBooking = async (from, bookingId) => {
  if (!new RegExp(`^${UUID}$`, 'i').test(String(bookingId))) return null;
  const booking = await getBookingById(bookingId);
  return booking?.client_phone === from ? booking : null;
};

// "status of #a1b2c3d4" -> that booking, if it is the sender's.
const bookingFromText = async (from, text) => {
  const match = REF_IN_TEXT.exec(text || '');
  return match ? findClientBookingByRef(from, match[1]) : null;
};

const orderLabel = (booking) =>
  [
    booking.service_type,
    booking.status,
    booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : null,
  ].filter(Boolean).join(' · ');

// ---------------------------------------------------------------------------
// 3. Actions on one order
// ---------------------------------------------------------------------------
const sendTrack = async (from, booking) => {
  if (!booking) {
    return replyText(from, null, "You don't have any orders yet. Reply *book* to schedule a pickup.", 'status');
  }
  booking = await syncBookingIfWhatsAppPay(booking); // pick up a WhatsApp Pay payment whose webhook was missed
  return replyText(
    from,
    booking,
    [
      `Order #${bookingRef(booking)}${booking.service_type ? ` - ${booking.service_type}` : ''}`,
      `Status: *${booking.status}*`,
      statusMessage(booking, formatDateTime),
      // Payment details only for bookings that involve payment
      ...(booking.payment_status && booking.payment_status !== 'not_required' ? ['', ...amountLines(booking)] : []),
      ...(awaitingOnlinePayment(booking) ? [paymentInstruction(booking)] : []),
    ].join('\n'),
    'status'
  );
};

const requestCancel = async (from, booking) => {
  if (!booking) {
    return replyText(from, null, "We couldn't find an active booking to cancel.", 'cancel');
  }
  if (CLOSED_STATUSES.includes(booking.status)) {
    return replyText(from, booking, `Order #${bookingRef(booking)} is already ${booking.status.toLowerCase()}.`, 'cancel');
  }
  if (!CHANGEABLE_STATUSES.includes(booking.status)) {
    await replyText(from, booking, `Your clothes for order #${bookingRef(booking)} have already been picked up, so we can’t cancel online. Our team will contact you shortly.`, HANDOFF_INTENT);
    return notifyAdmin([
      'Cancellation requested after pickup - please call the customer.',
      `Booking: #${bookingRef(booking)} (${booking.client_name || 'Unknown'}, +${from})`,
      `Status: ${booking.status}`,
    ]);
  }

  await saveSession(from, ORDER_FLOW, 'cancel_confirm', { bookingId: booking.id, retries: 0 });
  return askCancel(from, booking);
};

const askCancel = (from, booking, prefix = '') =>
  replyButtons(
    from,
    booking,
    `${prefix}Cancel order #${bookingRef(booking)}?\n${orderLabel(booking)}`,
    [
      { id: `cxl_yes_${booking.id}`, title: 'Yes, cancel' },
      { id: `cxl_no_${booking.id}`, title: 'No, keep it' },
    ],
    'cancel'
  );

// Confirmed by the customer: status is re-checked, it may have changed since the question.
const cancelBooking = async (from, booking) => {
  await clearSession(from);
  if (!booking || CLOSED_STATUSES.includes(booking.status) || !CHANGEABLE_STATUSES.includes(booking.status)) {
    return requestCancel(from, booking);
  }

  // Only while still changeable: staff may have moved the order on since it was loaded.
  const cancelled = await updateBookingStatus(booking.id, 'Cancelled', { onlyFromStatuses: CHANGEABLE_STATUSES });
  if (!cancelled) return requestCancel(from, await getBookingById(booking.id));
  await sendTemplateMessage(from, CANCEL_TEMPLATE, [booking.client_name || 'Customer', booking.service_type || 'laundry']);
  if (cancelled?.refund_required) {
    await notifyAdmin([
      '⚠️ Paid booking cancelled by customer - refund needed',
      `Booking #${bookingRef(cancelled)} (${cancelled.client_name || 'Unknown'}, +${from})`,
      `Paid: ₹${Number(cancelled.amount_paid)}`,
    ]).catch((err) => console.error(`[orders] Refund alert failed: ${err.message}`));
  }
  await safeLog(booking, 'outbound', `[template:${CANCEL_TEMPLATE}]`, 'cancel', from);
  console.log(`[orders] Booking ${booking.id} cancelled by ${maskPhone(from)}`);
};

const requestReschedule = async (from, booking, text = '') => {
  if (!booking || CLOSED_STATUSES.includes(booking.status)) {
    return replyText(from, booking, "You don't have an active booking to reschedule. Reply *book* to schedule a pickup.", 'reschedule');
  }
  if (!CHANGEABLE_STATUSES.includes(booking.status)) {
    await replyText(from, booking, `Your clothes for order #${bookingRef(booking)} have already been picked up. Our team will contact you to arrange the delivery time.`, HANDOFF_INTENT);
    return notifyAdmin([
      'Reschedule requested after pickup - please follow up.',
      `Booking: #${bookingRef(booking)} (${booking.client_name || 'Unknown'}, +${from})`,
      `Status: ${booking.status}`,
      ...(text ? [`Message: "${text}"`] : []),
    ]);
  }
  return startReschedule({ from, booking });
};

// "yes" / "confirm". Silent when answering our own message (as before); `announce` after the
// customer picked from a list, so the tap gets an answer.
const confirmOrder = async (from, booking, { announce = false } = {}) => {
  if (!booking) {
    console.warn(`[orders] Confirm intent from ${maskPhone(from)} but no booking found`);
    return;
  }
  if (CLOSED_STATUSES.includes(booking.status)) {
    console.warn(`[orders] Confirm ignored: booking ${booking.id} is ${booking.status}`);
    return announce ? replyText(from, booking, `Order #${bookingRef(booking)} is already ${booking.status.toLowerCase()}.`, 'confirm') : undefined;
  }
  // A booking waiting for online payment is only confirmed by a verified payment.
  if (awaitingOnlinePayment(booking)) {
    await replyText(from, booking, `Booking #${bookingRef(booking)} is confirmed once the payment is received.\n${paymentInstruction(booking)}`, 'payment');
    return remindPayment(booking); // WhatsApp Pay: sends the Pay message again (no-op for Razorpay links)
  }

  if (booking.status === 'Pending') await updateBookingStatus(booking.id, 'Confirmed');
  console.log(`[orders] Booking ${booking.id} confirmed by ${maskPhone(from)}`);
  if (announce) await replyText(from, booking, `✅ Order #${bookingRef(booking)} is confirmed.`, 'confirm');
};

const runAction = (from, action, booking, text, { picked = false } = {}) => {
  switch (action) {
    case 'confirm': return confirmOrder(from, booking, { announce: picked });
    case 'cancel': return requestCancel(from, booking);
    case 'reschedule': return requestReschedule(from, booking, text);
    default: return sendTrack(from, booking);
  }
};

// ---------------------------------------------------------------------------
// 4. Choosing one of several orders (session flow "order")
// ---------------------------------------------------------------------------
const askPick = async (from, data, prefix = '') => {
  await saveSession(from, ORDER_FLOW, 'pick', data);
  return replyList(
    from,
    null,
    `${prefix}You have ${data.offered.length} ${data.action === 'confirm' ? 'pending' : 'open'} orders. ${PICK_QUESTIONS[data.action]}\nTap below, or type the number.`,
    'Choose order',
    data.offered,
    ACTION_INTENT[data.action]
  );
};

const orderSteps = {
  pick: async (ctx) => {
    const { from, input, data } = ctx;
    const option = pickOption(input, data.offered || []);
    const booking =
      (option && (await ownedBooking(from, ORDER_CHOICE.exec(option.id)?.[2]))) ||
      (input.type === 'text' ? await bookingFromText(from, input.text) : null);
    if (!booking) return invalid(ctx, 'Please choose an order from the list.', (p) => askPick(from, data, p));

    await clearSession(from);
    return runAction(from, data.action, booking, '', { picked: true });
  },

  cancel_confirm: async (ctx) => {
    const { from, input, data } = ctx;
    const tapped = input.type === 'choice' ? CANCEL_CHOICE.exec(input.id) : null;
    const answer = tapped && tapped[2].toLowerCase() === String(data.bookingId).toLowerCase()
      ? tapped[1].toLowerCase()
      : textMatches(input, CANCEL_YES_WORDS) ? 'yes' : textMatches(input, CANCEL_NO_WORDS) ? 'no' : null;

    const booking = answer ? await ownedBooking(from, data.bookingId) : null;
    if (!answer) {
      const current = await ownedBooking(from, data.bookingId);
      if (!current) {
        await clearSession(from);
        return replyText(from, null, "Sorry, we couldn't find that order. Send *track* to see your orders.", FLOW_INTENT);
      }
      return invalid(ctx, 'Please tap *Yes, cancel* or *No, keep it*.', (p) => askCancel(from, current, p));
    }
    if (answer === 'yes') return cancelBooking(from, booking);

    await clearSession(from);
    return replyText(from, booking, booking ? `Okay, order #${bookingRef(booking)} stays booked.` : 'Okay, nothing was cancelled.', FLOW_INTENT);
  },
};

registerFlow(ORDER_FLOW, orderSteps);

// ---------------------------------------------------------------------------
// 5. Public API
// ---------------------------------------------------------------------------

/**
 * Track / cancel / reschedule for the order the customer means.
 * @param {{from: string, action: 'track'|'cancel'|'reschedule', text?: string}} options
 */
const handleOrderRequest = async ({ from, action, text = '' }) => {
  if (!ACTIONS.includes(action)) throw new Error(`Unknown order action: ${action}`);

  const byRef = await bookingFromText(from, text);
  if (byRef) return runAction(from, action, byRef, text);

  const active = await getActiveBookingsForClient(from);
  // Only Pending orders need confirming; with none, fall back to the latest (as before).
  const candidates = action === 'confirm' ? active.filter((b) => b.status === 'Pending') : active;
  if (candidates.length > 1) {
    const offered = candidates.map((b) => ({ id: `ord_${action}_${b.id}`, title: `#${bookingRef(b)}`, description: orderLabel(b) }));
    return askPick(from, { action, offered, retries: 0 });
  }
  return runAction(from, action, candidates[0] ?? active[0] ?? (await getLatestBookingForClient(from)), text);
};

/**
 * Taps on order-list rows or cancel buttons outside a session (e.g. after it expired).
 * @returns {Promise<boolean>} false if the id is not an order button
 */
const handleOrderChoice = async (from, id) => {
  const order = ORDER_CHOICE.exec(id);
  const cancel = order ? null : CANCEL_CHOICE.exec(id);
  if (!order && !cancel) return false;

  const booking = await ownedBooking(from, (order || cancel)[2]);
  if (!booking) {
    await replyText(from, null, "Sorry, we couldn't find that order. Send *track* to see your orders.", 'menu');
    return true;
  }

  if (order) await runAction(from, order[1].toLowerCase(), booking, '', { picked: true });
  else if (cancel[1].toLowerCase() === 'yes') await cancelBooking(from, booking);
  else await replyText(from, booking, `Okay, order #${bookingRef(booking)} stays booked.`, 'cancel');
  return true;
};

module.exports = { ORDER_FLOW, HANDOFF_INTENT, handleOrderRequest, handleOrderChoice };
