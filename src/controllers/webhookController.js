/**
 * src/controllers/webhookController.js
 * Handles Meta WhatsApp webhooks: verification (GET) and incoming events (POST).
 */

const { detectIntent, generateReply } = require('../services/aiService');
const { sendTemplateMessage } = require('../services/whatsappService');
const { maskPhone, safeLog, replyText, notifyAdmin } = require('../services/replyService');
const {
  FLOW_INTENT,
  bookingRef,
  sendWelcomeMenu,
  startBooking,
  startReschedule,
  handleFlowMessage,
} = require('../services/bookingFlow');
const { getLatestBookingForClient, updateBookingStatus } = require('../models/bookingModel');
const { getActiveSession } = require('../models/sessionModel');
const { claimEvent, markEventDone, markEventFailed } = require('../models/webhookEventModel');
const { CHANGEABLE_STATUSES, CLOSED_STATUSES, statusMessage } = require('../config/orderStatuses');
const { servicesText } = require('../config/businessKnowledge');
const { formatDateTime } = require('../utils/formatDate');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
// Approved template, assumed body: "Hi {{1}}, your {{2}} booking has been cancelled."
const CANCEL_TEMPLATE = process.env.TEMPLATE_BOOKING_CANCELLED || 'booking_cancelled';

// Outbound intent for replies that handed the customer to staff.
// Excluded from AI learning so "we'll get back to you" isn't reused as an answer.
const HANDOFF_INTENT = 'handoff';

// Typed words that open the main menu without asking the AI.
const MENU_WORDS = /^(menu|start|main menu)$/i;

const MAX_PROFILE_NAME_LENGTH = 60;

// ---------------------------------------------------------------------------
// 2. Parsing
// ---------------------------------------------------------------------------

// Collect every message in the payload with the sender's WhatsApp profile name.
// Meta can batch several entries/changes/messages into one delivery.
// Status updates (sent/delivered/read) have no messages.
const extractMessages = (body) =>
  (Array.isArray(body?.entry) ? body.entry : []).flatMap((entry) =>
    (Array.isArray(entry?.changes) ? entry.changes : []).flatMap((change) => {
      const value = change?.value;
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages = Array.isArray(value?.messages) ? value.messages : [];

      return messages.map((message) => {
        const contact = contacts.find((c) => c?.wa_id === message?.from) ?? contacts[0];
        const name = typeof contact?.profile?.name === 'string' ? contact.profile.name.trim() : '';
        return { message, profileName: name.slice(0, MAX_PROFILE_NAME_LENGTH) || null };
      });
    })
  );

/**
 * Normalize a WhatsApp message into:
 *   { type: 'text', text } | { type: 'choice', id, title } | { type: 'location', location } | { type: 'other', kind }
 */
const parseInput = (message) => {
  switch (message.type) {
    case 'text':
      return { type: 'text', text: message.text?.body?.trim() || '' };
    case 'interactive': {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      return reply?.id ? { type: 'choice', id: String(reply.id), title: String(reply.title || '') } : { type: 'other', kind: 'interactive' };
    }
    case 'button': // quick-reply button on a template message
      return { type: 'choice', id: String(message.button?.payload || message.button?.text || ''), title: String(message.button?.text || '') };
    case 'location':
      return { type: 'location', location: message.location || null };
    default:
      return { type: 'other', kind: message.type };
  }
};

// How an inbound message is recorded in the conversation log.
const describeInput = (input) => {
  switch (input.type) {
    case 'text': return input.text;
    case 'choice': return `[tap] ${input.title || input.id}`;
    case 'location': return `[location] ${input.location?.latitude},${input.location?.longitude}`;
    default: return `[${input.kind}]`;
  }
};

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

const isActive = (booking) => booking && !CLOSED_STATUSES.includes(booking.status);

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
  if (!CHANGEABLE_STATUSES.includes(booking.status)) {
    await replyText(from, booking, 'Your clothes have already been picked up, so we can’t cancel online. Our team will contact you shortly.', HANDOFF_INTENT);
    return notifyAdmin([
      'Cancellation requested after pickup - please call the customer.',
      `Booking: #${bookingRef(booking)} (${booking.client_name || 'Unknown'}, +${from})`,
      `Status: ${booking.status}`,
    ]);
  }

  await updateBookingStatus(booking.id, 'Cancelled');

  await sendTemplateMessage(from, CANCEL_TEMPLATE, [
    booking.client_name || 'Customer',
    booking.service_type || 'laundry',
  ]);
  await safeLog(booking, 'outbound', `[template:${CANCEL_TEMPLATE}]`, 'cancel', from);

  console.log(`[webhook] Booking ${booking.id} cancelled by ${maskPhone(from)}`);
};

const handleReschedule = async (from, booking, text) => {
  if (!isActive(booking)) {
    return replyText(from, booking, "You don't have an active booking to reschedule. Reply *book* to schedule a pickup.", 'reschedule');
  }
  if (!CHANGEABLE_STATUSES.includes(booking.status)) {
    await replyText(from, booking, 'Your clothes have already been picked up. Our team will contact you to arrange the delivery time.', HANDOFF_INTENT);
    return notifyAdmin([
      'Reschedule requested after pickup - please follow up.',
      `Booking: #${bookingRef(booking)} (${booking.client_name || 'Unknown'}, +${from})`,
      `Status: ${booking.status}`,
      `Message: "${text}"`,
    ]);
  }
  return startReschedule({ from, booking });
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

const handleTrack = async (from, booking) => {
  if (!booking) {
    return replyText(from, null, "You don't have any orders yet. Reply *book* to schedule a pickup.", 'status');
  }
  return replyText(
    from,
    booking,
    [
      `Order #${bookingRef(booking)}${booking.service_type ? ` - ${booking.service_type}` : ''}`,
      `Status: *${booking.status}*`,
      statusMessage(booking, formatDateTime),
    ].join('\n'),
    'status'
  );
};

const handlePrices = (from) =>
  replyText(from, null, `${servicesText()}\n\nReply *book* to schedule a pickup.`, 'menu');

const handleBook = (from, booking, profileName) =>
  startBooking({
    from,
    name: booking?.client_name || profileName,
    savedAddress: booking?.pickup_address || null,
  });

// Questions and anything else: AI answers from business info and past answers.
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

// Taps on main-menu buttons (or old menus) when no flow is active.
const handleMenuChoice = async (from, input, booking, profileName) => {
  switch (input.id) {
    case 'menu_book':
      return handleBook(from, booking, profileName);
    case 'menu_track':
      return handleTrack(from, booking);
    case 'menu_prices':
      return handlePrices(from);
    default:
      // A button from a flow that has expired or finished
      await replyText(from, null, 'That menu has expired.', 'menu');
      return sendWelcomeMenu(from, profileName || booking?.client_name);
  }
};

// ---------------------------------------------------------------------------
// 4. Main processing pipeline (runs after Meta has received its 200)
// ---------------------------------------------------------------------------
const processMessage = async ({ message, profileName }) => {
  const from = message.from;
  if (!from) return;

  const input = parseInput(message);
  if (input.type === 'text' && !input.text) return;

  // Customers inside a booking/reschedule flow continue it.
  const session = await getActiveSession(from);
  let logged = false;
  if (session) {
    await safeLog(session.data?.bookingId ?? null, 'inbound', describeInput(input), FLOW_INTENT, from);
    logged = true;
    if (await handleFlowMessage({ from, input, session })) return;
    // Otherwise the flow was left (e.g. "menu"): handle as a fresh message below.
  }

  if (input.type === 'choice') {
    const booking = await getLatestBookingForClient(from);
    if (!logged) await safeLog(booking, 'inbound', describeInput(input), 'menu', from);
    return handleMenuChoice(from, input, booking, profileName);
  }

  if (input.type !== 'text') {
    if (!logged) await safeLog(null, 'inbound', describeInput(input), 'unsupported', from);
    console.log(`[webhook] Unsupported message type from ${maskPhone(from)}: ${input.kind || input.type}`);
    return replyText(from, null, 'Sorry, I can only read text messages for now. Send *Hi* to see the menu.', 'unsupported');
  }

  const text = input.text;

  // Intent detection and booking lookup don't depend on each other, so run them in parallel.
  const [intent, booking] = await Promise.all([
    MENU_WORDS.test(text) ? 'greeting' : resolveIntent(text),
    getLatestBookingForClient(from),
  ]);

  if (!logged) await safeLog(booking, 'inbound', text, intent, from);
  console.log(`[webhook] ${maskPhone(from)} intent=${intent} booking=${booking?.id ?? 'none'}`);

  switch (intent) {
    case 'greeting':
      return sendWelcomeMenu(from, profileName || booking?.client_name);
    case 'book':
      return handleBook(from, booking, profileName);
    case 'status':
      return handleTrack(from, booking);
    case 'cancel':
      return handleCancel(from, booking);
    case 'reschedule':
      return handleReschedule(from, booking, text);
    case 'confirm':
      return handleConfirm(from, booking);
    default:
      return handleGeneral(from, booking, text, intent);
  }
};

// ---------------------------------------------------------------------------
// 5. Idempotency wrapper
//    Claim the message id before doing anything, so a duplicate delivery
//    (even one arriving while the first is still running) is skipped.
// ---------------------------------------------------------------------------
const processOnce = async (item) => {
  const { message } = item;
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
    await processMessage(item);
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
  for (const item of extractMessages(req.body)) {
    await processOnce(item); // never throws
  }
};

module.exports = {
  verifyWebhook,
  handleIncomingMessage,
};
