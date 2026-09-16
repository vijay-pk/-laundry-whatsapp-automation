/**
 * src/services/bookingFlow.js
 * Multi-step WhatsApp chat flows, driven by conversation_sessions:
 *   booking:    service -> pickup slot -> address -> name -> instructions -> confirm
 *   reschedule: pickup slot -> update booking
 *
 * Customers can tap buttons/lists or type (numbers or text). "stop" ends a flow,
 * "menu" goes back to the main menu. Sessions expire after 30 minutes of silence.
 */

const { businessKnowledge } = require('../config/businessKnowledge');
const { listSlots, findSlot } = require('./slotService');
const { replyText, replyButtons, replyList, notifyAdmin, maskPhone } = require('./replyService');
const { alertAdminNewBooking } = require('./notificationService');
const { saveSession, clearSession } = require('../models/sessionModel');
const { createBooking, updateBookingSchedule } = require('../models/bookingModel');
const { formatDateTime } = require('../utils/formatDate');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const FLOW = { BOOKING: 'booking', RESCHEDULE: 'reschedule' };

// Intent stored on flow messages (keeps menus out of AI learning).
const FLOW_INTENT = 'booking_flow';

const MAX_RETRIES = 3;
const MIN_ADDRESS_LENGTH = 10;
const MAX_ADDRESS_LENGTH = 300;
const MAX_NOTES_LENGTH = 500;

// Inside a flow, "cancel" means "stop this flow", not "cancel my existing booking".
const STOP_WORDS = /^(stop|exit|quit|abort|cancel)$/i;
const MENU_WORDS = /^(menu|restart|start over|main menu)$/i;
const YES_WORDS = /^(yes|y|confirm|ok|okay|sure)$/i;
const NO_WORDS = /^(no|n|cancel|discard)$/i;
const SKIP_WORDS = /^(no|none|skip|nothing|na|n\/a|nope)$/i;

// Short reference customers and staff can quote.
const bookingRef = (booking) => booking.id.slice(0, 8).toUpperCase();

const serviceOptions = () =>
  businessKnowledge.services.map((s) => ({
    id: `svc_${s.id}`,
    title: s.name,
    description: `${s.price} · ${s.turnaround}`,
    service: s,
  }));

// ---------------------------------------------------------------------------
// 2. Input helpers
// ---------------------------------------------------------------------------

// Match a tapped option by id, or typed text by number ("2") or title.
const pickOption = (input, options) => {
  if (input.type === 'choice') return options.find((o) => o.id === input.id) || null;
  if (input.type !== 'text') return null;

  const text = input.text.trim().toLowerCase();
  const index = Number.parseInt(text, 10);
  if (String(index) === text && index >= 1 && index <= options.length) return options[index - 1];

  return (
    options.find((o) => o.title.toLowerCase() === text) ||
    options.find((o) => text.length >= 3 && o.title.toLowerCase().includes(text)) ||
    null
  );
};

const isChoice = (input, id) => input.type === 'choice' && input.id === id;
const textMatches = (input, regex) => input.type === 'text' && regex.test(input.text.trim());

// ---------------------------------------------------------------------------
// 3. Prompts
// ---------------------------------------------------------------------------
const sendWelcomeMenu = (from, profileName) =>
  replyButtons(
    from,
    null,
    `Hi${profileName ? ` ${profileName}` : ''}! 👋 Welcome to ${businessKnowledge.name}.\nHow can we help you today?`,
    [
      { id: 'menu_book', title: 'Book a pickup' },
      { id: 'menu_track', title: 'Track my order' },
      { id: 'menu_prices', title: 'Prices' },
    ],
    'menu'
  );

const askService = (from, prefix = '') =>
  replyList(
    from,
    null,
    `${prefix}Which service do you need?`,
    'Choose service',
    serviceOptions().map(({ id, title, description }) => ({ id, title, description })),
    FLOW_INTENT
  );

// Offers current slots and remembers them for typed answers. Returns false if none are available.
const askSlot = async (from, flow, data, prefix = '') => {
  const slots = listSlots();
  if (slots.length === 0) {
    await clearSession(from);
    await replyText(from, null, 'Sorry, there are no pickup slots available in the next few days. Our team will contact you.', FLOW_INTENT);
    await notifyAdmin(['No pickup slots available for a customer.', `Client: +${from}`]).catch(() => {});
    return false;
  }

  data.offeredSlots = slots.map(({ id, start, title, description }) => ({ id, start, title, description }));
  await saveSession(from, flow, 'slot', data);
  await replyList(from, null, `${prefix}When should we pick up?`, 'Choose time', slots.map(({ id, title, description }) => ({ id, title, description })), FLOW_INTENT);
  return true;
};

const askAddress = async (from, data) => {
  if (data.savedAddress) {
    await saveSession(from, FLOW.BOOKING, 'address_choice', data);
    return replyButtons(
      from,
      null,
      `Where should we pick up?\n\n📍 ${data.savedAddress}`,
      [
        { id: 'addr_saved', title: 'Use this address' },
        { id: 'addr_new', title: 'New address' },
      ],
      FLOW_INTENT
    );
  }
  await saveSession(from, FLOW.BOOKING, 'address', data);
  return replyText(from, null, 'Please send your pickup address (house no., street, area, landmark), or share your location 📎.', FLOW_INTENT);
};

const askName = async (from, data) => {
  if (data.name) return askNotes(from, data);
  await saveSession(from, FLOW.BOOKING, 'name', data);
  return replyText(from, null, 'What name should we use for this booking?', FLOW_INTENT);
};

const askNotes = async (from, data) => {
  await saveSession(from, FLOW.BOOKING, 'notes', data);
  return replyButtons(
    from,
    null,
    'Any special instructions? (e.g. no starch, separate whites, missing button)\nType them, or tap below.',
    [{ id: 'notes_skip', title: 'No instructions' }],
    FLOW_INTENT
  );
};

const bookingSummary = (data) => {
  const service = businessKnowledge.services.find((s) => s.id === data.serviceId);
  return [
    'Please confirm your booking:',
    '',
    `🧺 Service: ${service?.name ?? data.serviceId}`,
    `🕒 Pickup: ${data.slot.title} (${data.slot.description})`,
    `📍 Address: ${data.address}`,
    `👤 Name: ${data.name}`,
    `📝 Instructions: ${data.notes || 'None'}`,
  ].join('\n');
};

const askConfirm = async (from, data) => {
  await saveSession(from, FLOW.BOOKING, 'confirm', data);
  return replyButtons(
    from,
    null,
    bookingSummary(data),
    [
      { id: 'confirm_yes', title: 'Confirm' },
      { id: 'confirm_restart', title: 'Start over' },
      { id: 'confirm_no', title: 'Cancel' },
    ],
    FLOW_INTENT
  );
};

// Count a wrong answer; after MAX_RETRIES give up so customers are never stuck.
const invalid = async (ctx, message, reask) => {
  const { from, session, data } = ctx;
  data.retries = (data.retries || 0) + 1;

  if (data.retries >= MAX_RETRIES) {
    await clearSession(from);
    return replyText(from, null, "Sorry, I didn't get that. Let's start again: send *Hi* or type *book*.", FLOW_INTENT);
  }

  await saveSession(from, session.flow, session.step, data);
  return reask(`${message}\n\n`);
};

// ---------------------------------------------------------------------------
// 4. Flow steps: each handles the customer's answer for one step
// ---------------------------------------------------------------------------
const bookingSteps = {
  service: async (ctx) => {
    const { from, input, data } = ctx;
    const option = pickOption(input, serviceOptions());
    if (!option) return invalid(ctx, 'Please choose a service from the list.', (p) => askService(from, p));

    data.serviceId = option.service.id;
    data.retries = 0;
    return askSlot(from, FLOW.BOOKING, data);
  },

  slot: async (ctx) => {
    const { from, input, data } = ctx;
    const option = pickOption(input, data.offeredSlots || []);
    if (!option) return invalid(ctx, 'Please choose a pickup time from the list.', (p) => askSlot(from, FLOW.BOOKING, data, p));

    if (!findSlot(option.id)) {
      return askSlot(from, FLOW.BOOKING, data, 'Sorry, that time is no longer available.\n\n');
    }

    data.slot = option;
    data.retries = 0;
    return askAddress(from, data);
  },

  address_choice: async (ctx) => {
    const { from, input, data } = ctx;
    if (isChoice(input, 'addr_saved') || textMatches(input, /^(1|yes|use this address|same)$/i)) {
      data.address = data.savedAddress;
      data.retries = 0;
      return askName(from, data);
    }
    if (isChoice(input, 'addr_new') || textMatches(input, /^(2|new|new address|no)$/i)) {
      data.retries = 0;
      await saveSession(from, FLOW.BOOKING, 'address', data);
      return replyText(from, null, 'Please send your pickup address (house no., street, area, landmark), or share your location 📎.', FLOW_INTENT);
    }
    // A typed address is also fine here.
    if (input.type === 'text' && input.text.trim().length >= MIN_ADDRESS_LENGTH) {
      data.address = input.text.trim().slice(0, MAX_ADDRESS_LENGTH);
      data.retries = 0;
      return askName(from, data);
    }
    return invalid(ctx, 'Please tap an option or type your new address.', () => askAddress(from, data));
  },

  address: async (ctx) => {
    const { from, input, data } = ctx;

    if (input.type === 'location' && input.location) {
      const { latitude, longitude, name, address } = input.location;
      const label = [name, address].filter(Boolean).join(', ');
      data.address = `${label ? `${label} ` : ''}(https://maps.google.com/?q=${latitude},${longitude})`.slice(0, MAX_ADDRESS_LENGTH);
    } else if (input.type === 'text' && input.text.trim().length >= MIN_ADDRESS_LENGTH) {
      data.address = input.text.trim().slice(0, MAX_ADDRESS_LENGTH);
    } else {
      return invalid(ctx, `Please send the full pickup address (at least ${MIN_ADDRESS_LENGTH} characters) or share your location.`, (p) =>
        replyText(from, null, `${p}Please send your pickup address.`, FLOW_INTENT)
      );
    }

    data.retries = 0;
    return askName(from, data);
  },

  name: async (ctx) => {
    const { from, input, data } = ctx;
    const name = input.type === 'text' ? input.text.trim() : '';
    if (name.length < 2 || name.length > 60) {
      return invalid(ctx, 'Please send a name between 2 and 60 characters.', (p) =>
        replyText(from, null, `${p}What name should we use for this booking?`, FLOW_INTENT)
      );
    }
    data.name = name;
    data.retries = 0;
    return askNotes(from, data);
  },

  notes: async (ctx) => {
    const { from, input, data } = ctx;
    if (isChoice(input, 'notes_skip') || textMatches(input, SKIP_WORDS)) {
      data.notes = null;
    } else if (input.type === 'text' && input.text.trim()) {
      data.notes = input.text.trim().slice(0, MAX_NOTES_LENGTH);
    } else {
      return invalid(ctx, 'Please type your instructions, or tap "No instructions".', () => askNotes(from, data));
    }
    data.retries = 0;
    return askConfirm(from, data);
  },

  confirm: async (ctx) => {
    const { from, input, data } = ctx;

    if (isChoice(input, 'confirm_restart')) {
      return startBooking({ from, name: data.name, savedAddress: data.address });
    }
    if (isChoice(input, 'confirm_no') || textMatches(input, NO_WORDS)) {
      await clearSession(from);
      return replyText(from, null, 'Booking discarded. Send *Hi* whenever you want to book.', FLOW_INTENT);
    }
    if (!(isChoice(input, 'confirm_yes') || textMatches(input, YES_WORDS))) {
      return invalid(ctx, 'Please tap *Confirm* to book, or *Cancel*.', () => askConfirm(from, data));
    }

    if (!findSlot(data.slot.id)) {
      return askSlot(from, FLOW.BOOKING, data, 'Sorry, your pickup time is no longer available. Please choose another.\n\n');
    }

    const businessId = process.env.DEFAULT_BUSINESS_ID;
    if (!businessId) {
      console.error('[flow] DEFAULT_BUSINESS_ID not set; cannot save chat booking');
      await clearSession(from);
      await replyText(from, null, 'Sorry, we could not save your booking right now. Our team will contact you.', FLOW_INTENT);
      return notifyAdmin(['Chat booking failed: DEFAULT_BUSINESS_ID not configured.', `Client: +${from}`]).catch(() => {});
    }

    const service = businessKnowledge.services.find((s) => s.id === data.serviceId);
    const booking = await createBooking(businessId, {
      clientPhone: from,
      clientName: data.name,
      serviceType: service?.name ?? data.serviceId,
      pickupAddress: data.address,
      scheduledTime: data.slot.start,
      notes: data.notes,
      source: 'whatsapp',
      status: 'Confirmed',
    });

    await clearSession(from);
    console.log(`[flow] Chat booking ${booking.id} created for ${maskPhone(from)}`);

    await replyText(
      from,
      booking,
      [
        '✅ Booking confirmed!',
        '',
        `Ref: #${bookingRef(booking)}`,
        `${booking.service_type} pickup: ${data.slot.title} (${data.slot.description})`,
        '',
        'Reply *track* anytime to check your order, or *reschedule* / *cancel* to change it.',
      ].join('\n'),
      FLOW_INTENT
    );

    await alertAdminNewBooking(booking);
  },
};

const rescheduleSteps = {
  slot: async (ctx) => {
    const { from, input, data } = ctx;
    const option = pickOption(input, data.offeredSlots || []);
    if (!option) return invalid(ctx, 'Please choose a new pickup time from the list.', (p) => askSlot(from, FLOW.RESCHEDULE, data, p));

    if (!findSlot(option.id)) {
      return askSlot(from, FLOW.RESCHEDULE, data, 'Sorry, that time is no longer available.\n\n');
    }

    const booking = await updateBookingSchedule(data.bookingId, option.start);
    await clearSession(from);

    if (!booking) {
      return replyText(from, null, "Sorry, we couldn't find that booking anymore.", FLOW_INTENT);
    }

    await replyText(from, booking, `✅ Done! Your pickup is now ${option.title} (${option.description}).`, FLOW_INTENT);
    await notifyAdmin([
      'Pickup rescheduled by customer.',
      `Booking: #${bookingRef(booking)} (${booking.client_name || 'Unknown'}, +${from})`,
      `New slot: ${formatDateTime(new Date(booking.scheduled_time))}`,
    ]).catch((err) => console.error(`[flow] Admin reschedule notice failed: ${err.message}`));
  },
};

const STEPS = { [FLOW.BOOKING]: bookingSteps, [FLOW.RESCHEDULE]: rescheduleSteps };

// ---------------------------------------------------------------------------
// 5. Public API
// ---------------------------------------------------------------------------

/**
 * Start a new chat booking.
 * @param {{from: string, name?: string, savedAddress?: string}} options
 */
const startBooking = async ({ from, name = null, savedAddress = null }) => {
  const data = { name, savedAddress, retries: 0 };
  await saveSession(from, FLOW.BOOKING, 'service', data);
  return askService(from);
};

/** Let the customer pick a new pickup slot for an existing booking. */
const startReschedule = async ({ from, booking }) => {
  const current = booking.scheduled_time ? `Your current pickup is ${formatDateTime(new Date(booking.scheduled_time))}.\n` : '';
  return askSlot(from, FLOW.RESCHEDULE, { bookingId: booking.id, retries: 0 }, current);
};

/**
 * Handle a message from a customer who is inside a flow.
 * @returns {Promise<boolean>} false if the message should be handled outside the flow
 *                             (the session has been cleared)
 */
const handleFlowMessage = async ({ from, input, session }) => {
  if (textMatches(input, STOP_WORDS)) {
    await clearSession(from);
    await replyText(from, null, "No problem, I've stopped. Send *Hi* anytime to start again.", FLOW_INTENT);
    return true;
  }

  // Main menu words or taps leave the flow and are handled as fresh messages.
  if (textMatches(input, MENU_WORDS) || (input.type === 'choice' && input.id.startsWith('menu_'))) {
    await clearSession(from);
    return false;
  }

  const step = STEPS[session.flow]?.[session.step];
  if (!step) {
    await clearSession(from);
    return false;
  }

  await step({ from, input, session, data: { ...session.data } });
  return true;
};

module.exports = {
  FLOW,
  FLOW_INTENT,
  bookingRef,
  sendWelcomeMenu,
  startBooking,
  startReschedule,
  handleFlowMessage,
};
