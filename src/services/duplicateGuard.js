/**
 * src/services/duplicateGuard.js
 * Chat booking: before saving, check whether the customer already has an open order for the
 * same service and pickup time (re-sent "book" flows, double bookings). If so, ask:
 *   "Keep existing" -> nothing saved (unpaid online order: its payment link again)
 *   "Book another"  -> continue confirming (a second load on purpose is fine)
 * Used by bookingFlow's confirm step (session step "duplicate").
 */

const { replyText, replyButtons } = require('./replyService');
const { paymentLink } = require('./paymentService');
const { paymentInstruction } = require('./whatsappPayService');
const { businessKnowledge } = require('../config/businessKnowledge');
const { saveSession, clearSession } = require('../models/sessionModel');
const { findDuplicateBooking, getBookingById } = require('../models/bookingModel');
const { CLOSED_STATUSES, bookingRef, awaitingOnlinePayment } = require('../config/orderStatuses');
const { formatDateTime } = require('../utils/formatDate');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const FLOW_INTENT = 'booking_flow';
const KEEP_ID = 'dup_keep';
const NEW_ID = 'dup_new';
const KEEP_WORDS = /^(1|keep|keep existing|keep it|no|n)$/i;
const NEW_WORDS = /^(2|new|book another|another|yes|y)$/i;

const serviceName = (data) => businessKnowledge.services.find((s) => s.id === data.serviceId)?.name ?? data.serviceId;

const paymentLines = (booking) => {
  if (!awaitingOnlinePayment(booking)) return [];
  return booking.payment_method === 'whatsapp_pay'
    ? [`It is waiting for payment. ${paymentInstruction(booking)}`]
    : [`It is waiting for payment: ${paymentLink(booking)}`];
};

// ---------------------------------------------------------------------------
// 2. Prompts
// ---------------------------------------------------------------------------
const askQuestion = (from, existing, prefix = '') =>
  replyButtons(
    from,
    existing,
    [
      `${prefix}You already have order #${bookingRef(existing)} for ${existing.service_type} at ${formatDateTime(new Date(existing.scheduled_time))} (${existing.status}).`,
      ...paymentLines(existing),
      '',
      'Do you want to book another one anyway?',
    ].join('\n'),
    [
      { id: KEEP_ID, title: 'Keep existing' },
      { id: NEW_ID, title: 'Book another' },
    ],
    FLOW_INTENT
  );

const answerOf = (input) => {
  if (input.type === 'choice') return input.id === KEEP_ID ? 'keep' : input.id === NEW_ID ? 'new' : null;
  if (input.type !== 'text') return null;
  const text = input.text.trim();
  return KEEP_WORDS.test(text) ? 'keep' : NEW_WORDS.test(text) ? 'new' : null;
};

// ---------------------------------------------------------------------------
// 3. Public API
// ---------------------------------------------------------------------------

/**
 * Called by the confirm step just before the booking is saved.
 * @param {{from: string, data: object, choice: string}} args  choice = confirm button id to resume with
 * @returns {Promise<boolean>} true if the customer was asked (the confirm step must stop)
 */
const askIfDuplicate = async ({ from, data, choice }) => {
  if (data.allowDuplicate) return false;
  const existing = await findDuplicateBooking(from, serviceName(data), data.slot.start, process.env.DEFAULT_BUSINESS_ID || null);
  if (!existing) return false;

  data.confirmChoice = choice;
  data.duplicateId = existing.id;
  data.retries = 0;
  await saveSession(from, 'booking', 'duplicate', data);
  await askQuestion(from, existing);
  return true;
};

/**
 * Session step "duplicate": the customer's answer to the question.
 * @param {object} ctx  step context from bookingFlow ({from, input, session, data})
 * @param {{confirm: Function, invalid: Function}} flow  bookingFlow's confirm step and wrong-answer helper
 */
const handleAnswer = async (ctx, { confirm, invalid }) => {
  const { from, input, data } = ctx;
  const existing = await getBookingById(data.duplicateId);
  const stillOpen = existing && existing.client_phone === from && !CLOSED_STATUSES.includes(existing.status);
  const answer = answerOf(input);

  if (answer === 'new') {
    data.allowDuplicate = true;
    data.retries = 0;
    return confirm({ ...ctx, session: { ...ctx.session, step: 'confirm' }, input: { type: 'choice', id: data.confirmChoice, title: '' }, data });
  }
  if (answer === 'keep') {
    await clearSession(from);
    return stillOpen
      ? replyText(from, existing, [`Okay, no new booking. Order #${bookingRef(existing)} stays as it is.`, ...paymentLines(existing)].join('\n'), FLOW_INTENT)
      : replyText(from, null, 'Okay, no new booking. Send *book* anytime.', FLOW_INTENT);
  }
  return invalid(ctx, 'Please tap *Keep existing* or *Book another*.', (p) =>
    stillOpen ? askQuestion(from, existing, p) : replyText(from, null, `${p}Reply *2* to book another, or *1* to skip.`, FLOW_INTENT)
  );
};

module.exports = { askIfDuplicate, handleAnswer };
