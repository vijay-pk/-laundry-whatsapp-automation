/**
 * src/controllers/webhookController.js
 * Handles Meta WhatsApp webhooks: verification (GET) and incoming events (POST).
 */

const { detectIntent, generateReply } = require('../services/aiService');
const { sendTemplateMessage, sendTextMessage } = require('../services/whatsappService');
const {
  getLatestBookingForClient,
  updateBookingStatus,
  logMessage,
} = require('../models/bookingModel');
const { claimEvent, markEventDone, markEventFailed } = require('../models/webhookEventModel');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
// Approved template, assumed body: "Hi {{1}}, your {{2}} booking has been cancelled."
const CANCEL_TEMPLATE = process.env.TEMPLATE_BOOKING_CANCELLED || 'booking_cancelled';

// Bookings in these states can no longer be cancelled or confirmed.
const CLOSED_STATUSES = ['Cancelled', 'Delivered'];

// Outbound intent for replies that handed the customer to staff.
// Excluded from AI learning so "we'll get back to you" isn't reused as an answer.
const HANDOFF_INTENT = 'handoff';

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

// Only log the last 4 digits. Phone numbers are customer PII.
const maskPhone = (phone) => `***${String(phone).slice(-4)}`;

// Collect every message in the payload. Meta can batch several entries/changes/messages
// into one delivery. Status updates (sent/delivered/read) have no messages.
const extractMessages = (body) =>
  (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry) =>
    (Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) =>
      Array.isArray(change?.value?.messages) ? change.value.messages : []
    )
  );

// If the AI call fails, fall back to 'other' so the customer still gets a reply.
const resolveIntent = async (text) => {
  try {
    const result = await detectIntent(text);
    const intent = typeof result === 'string' ? result : result?.intent;
    return String(intent || 'other').toLowerCase().trim();
  } catch (err) {
    console.error(`[webhook] Intent detection failed, using 'other': ${err.message}`);
    return 'other';
  }
};

// A failed database log must never block a reply to the customer.
const safeLog = async (bookingId, direction, content, intent, clientPhone) => {
  try {
    await logMessage(bookingId, direction, content, intent, clientPhone);
  } catch (err) {
    console.error(`[webhook] Failed to log ${direction} message: ${err.message}`);
  }
};

// Send a text reply to the client and record it in the conversation log.
const replyText = async (to, booking, text, intent) => {
  await sendTextMessage(to, text);
  await safeLog(booking?.id ?? null, 'outbound', text, intent, to);
};

// Send a plain-text note to the admin. Returns false if ADMIN_PHONE is missing.
const notifyAdmin = async (lines) => {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) {
    console.warn('[webhook] ADMIN_PHONE not set; admin notification skipped');
    return false;
  }
  await sendTextMessage(adminPhone, lines.join('\n'));
  return true;
};

const formatSlot = (booking) =>
  booking?.scheduled_time ? new Date(booking.scheduled_time).toLocaleString() : 'n/a';

// ---------------------------------------------------------------------------
// 3. Intent handlers
// ---------------------------------------------------------------------------
const handleCancel = async (from, booking) => {
  if (!booking) {
    return replyText(from, null, "We couldn't find an active booking to cancel.", 'cancel');
  }
  if (CLOSED_STATUSES.includes(booking.status)) {
    return replyText(from, booking, `Your booking is already ${booking.status.toLowerCase()}.`, 'cancel');
  }

  await updateBookingStatus(booking.id, 'Cancelled');

  await sendTemplateMessage(from, CANCEL_TEMPLATE, [
    booking.client_name || 'Customer',
    booking.service_type || 'laundry',
  ]);
  await safeLog(booking.id, 'outbound', `[template:${CANCEL_TEMPLATE}]`, 'cancel', from);

  console.log(`[webhook] Booking ${booking.id} cancelled by ${maskPhone(from)}`);
};

const handleReschedule = async (from, booking, text) => {
  const sent = await notifyAdmin([
    'Reschedule request - please follow up.',
    `Client: ${booking?.client_name || 'Unknown'} (+${from})`,
    `Booking: ${booking?.id || 'none found'}`,
    `Current slot: ${formatSlot(booking)}`,
    `Message: "${text}"`,
  ]);

  if (sent) console.log(`[webhook] Reschedule request from ${maskPhone(from)} forwarded to admin`);
};

const handleConfirm = async (from, booking) => {
  if (!booking) {
    console.warn(`[webhook] Confirm intent from ${maskPhone(from)} but no booking found`);
    return;
  }
  if (CLOSED_STATUSES.includes(booking.status)) {
    console.warn(`[webhook] Confirm ignored: booking ${booking.id} is ${booking.status}`);
    return;
  }

  await updateBookingStatus(booking.id, 'Confirmed');
  console.log(`[webhook] Booking ${booking.id} confirmed by ${maskPhone(from)}`);
};

// Questions, greetings and anything else: AI answers from business info and past answers.
const handleGeneral = async (from, booking, text, intent) => {
  const { reply, needsHuman } = await generateReply(text, from);

  await replyText(from, booking, reply, needsHuman ? HANDOFF_INTENT : intent);

  if (needsHuman) {
    await notifyAdmin([
      'Customer needs help - AI could not answer.',
      `Client: ${booking?.client_name || 'Unknown'} (+${from})`,
      `Message: "${text}"`,
    ]);
  }
};

// ---------------------------------------------------------------------------
// 4. Main processing pipeline (runs after Meta has received its 200)
// ---------------------------------------------------------------------------
const processMessage = async (message) => {
  // Only text is supported for now (image, audio, button, etc. are ignored)
  if (message.type !== 'text') {
    console.log(`[webhook] Ignoring unsupported message type: ${message.type}`);
    return;
  }

  const from = message.from;
  const text = message.text?.body?.trim();
  if (!from || !text) return;

  // Intent detection and booking lookup don't depend on each other, so run them in parallel.
  const [intent, booking] = await Promise.all([
    resolveIntent(text),
    getLatestBookingForClient(from),
  ]);

  await safeLog(booking?.id ?? null, 'inbound', text, intent, from);
  console.log(`[webhook] ${maskPhone(from)} intent=${intent} booking=${booking?.id ?? 'none'}`);

  switch (intent) {
    case 'cancel':
      await handleCancel(from, booking);
      break;

    case 'reschedule':
      await handleReschedule(from, booking, text);
      break;

    case 'confirm':
      await handleConfirm(from, booking);
      break;

    default:
      await handleGeneral(from, booking, text, intent);
      break;
  }
};

// ---------------------------------------------------------------------------
// 5. Idempotency wrapper
//    Claim the message id before doing anything, so a duplicate delivery
//    (even one arriving while the first is still running) is skipped.
// ---------------------------------------------------------------------------
const processOnce = async (message) => {
  if (!message?.id) {
    console.warn('[webhook] Message without id; cannot deduplicate, skipping');
    return;
  }

  let claimed;
  try {
    claimed = await claimEvent(message.id);
  } catch (err) {
    // Without the database we can neither deduplicate nor process (bookings, logs).
    console.error(`[webhook] Could not claim message ${message.id}, skipping: ${err.message}`);
    return;
  }

  if (!claimed) {
    console.log(`[webhook] Duplicate message ${message.id} skipped`);
    return;
  }

  try {
    await processMessage(message);
  } catch (err) {
    console.error(
      `[webhook] Failed to process message ${message.id} from ${maskPhone(message.from)}: ` +
        `${err.message}${err.hint ? ` | hint: ${err.hint}` : ''}`
    );
    await markEventFailed(message.id, err.message).catch((markErr) =>
      console.error(`[webhook] Could not mark message ${message.id} failed: ${markErr.message}`)
    );
    return;
  }

  // Outside the try above: if only this update fails, the message was handled
  // and must not be marked 'failed' (that would allow a duplicate retry).
  await markEventDone(message.id).catch((err) =>
    console.error(`[webhook] Could not mark message ${message.id} done: ${err.message}`)
  );
};

// ---------------------------------------------------------------------------
// 6. Exported route handlers
// ---------------------------------------------------------------------------

/**
 * GET /webhook
 * Meta sends hub.mode, hub.verify_token and hub.challenge when you register the URL.
 */
const verifyWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log('[webhook] Verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] Verification failed: invalid mode or token');
  return res.sendStatus(403);
};

/**
 * POST /webhook
 * Acknowledges right away, then processes. Meta expects a fast 200 and
 * re-sends the event if it doesn't get one. The AI and API calls could take
 * several seconds, so they run after the response is sent.
 * Every message is processed at most once (see processOnce).
 */
const handleIncomingMessage = async (req, res) => {
  res.sendStatus(200);

  // Empty for delivery/read status updates: nothing to do.
  // Sequential, so a customer's messages are handled in the order sent.
  for (const message of extractMessages(req.body)) {
    await processOnce(message); // never throws
  }
};

module.exports = {
  verifyWebhook,
  handleIncomingMessage,
};
