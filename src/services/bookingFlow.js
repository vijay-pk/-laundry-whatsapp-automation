/**
 * src/services/bookingFlow.js
 * Multi-step WhatsApp chat flows, driven by conversation_sessions:
 *   booking:    service -> [quantity] -> [location check] -> pickup slot -> address -> name -> instructions -> confirm
 *               -> [duplicate: same service + time already open]
 *               (quantity only when the business has payment enabled: bookingCheckout;
 *                location check only when BUSINESS_LAT/BUSINESS_LNG are set: geofencing)
 *   reschedule: pickup slot -> update booking
 *
 * Customers can tap buttons/lists or type (numbers or text). "stop" ends a flow,
 * "menu" goes back to the main menu. Sessions expire after 30 minutes of silence.
 */

const { businessKnowledge } = require('../config/businessKnowledge');
const { listSlots, findSlot } = require('./slotService');
const { replyText, replyButtons, replyList, notifyAdmin, maskPhone, safeLog } = require('./replyService');
const { sendLocationRequest, locationRequestText } = require('./whatsappService');
const { saveSession, clearSession } = require('../models/sessionModel');
const { updateBookingSchedule, getBookingById } = require('../models/bookingModel');
const checkout = require('./bookingCheckout');
const { getPaymentOptions } = require('./paymentService');
const { formatDateTime } = require('../utils/formatDate');
const { bookingRef, CHANGEABLE_STATUSES } = require('../config/orderStatuses');
const { getServiceArea } = require('../utils/geo');
const { readCustomerLocation, decideServiceArea, recordRejectedRequest } = require('./serviceAreaService');
const duplicateGuard = require('./duplicateGuard');

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
const LOCATION_HINTS = {
  unreadable_link: "I couldn't read a location from that link. Please share your location using the 📎 attachment icon.",
  not_location: 'Please share your location using the 📎 attachment icon, or paste a Google Maps link.',
};

// Inside a flow, "cancel" means "stop this flow", not "cancel my existing booking".
const STOP_WORDS = /^(stop|exit|quit|abort|cancel)$/i;
const MENU_WORDS = /^(menu|restart|start over|main menu)$/i;
const YES_WORDS = /^(yes|y|confirm|ok|okay|sure)$/i;
const NO_WORDS = /^(no|n|cancel|discard)$/i;
const SKIP_WORDS = /^(no|none|skip|nothing|na|n\/a|nope)$/i;

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

// ---------------------------------------------------------------------------
// Geofencing: ask for the customer's native WhatsApp location after they pick a service.
// ---------------------------------------------------------------------------
const askLocation = async (from, data, prefix = '') => {
  await saveSession(from, FLOW.BOOKING, 'location', data);
  if (prefix) {
    return replyText(from, null, `${prefix}${locationRequestText(getServiceArea().radiusKm)}`, FLOW_INTENT);
  }
  await sendLocationRequest(from);
  return safeLog(null, 'outbound', locationRequestText(getServiceArea().radiusKm), FLOW_INTENT, from);
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
  // Location already verified: we only need the details a map pin can't give.
  const prompt = data.geo
    ? 'Thanks! Please send your house/flat number, street and a landmark for the pickup.'
    : 'Please send your pickup address (house no., street, area, landmark), or share your location 📎.';
  return replyText(from, null, prompt, FLOW_INTENT);
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
    ...(data.geo ? [`📌 Distance: ${data.geo.distanceKm} km from our store`] : []),
    `👤 Name: ${data.name}`,
    `📝 Instructions: ${data.notes || 'None'}`,
  ].join('\n');
};

const askConfirm = async (from, data) => {
  await saveSession(from, FLOW.BOOKING, 'confirm', data);
  const quote = await checkout.quoteForData(data); // payment lines/buttons only when payment applies
  const body = [bookingSummary(data), ...checkout.paymentSummaryLines(quote, data)].join('\n');
  return replyButtons(from, null, body, checkout.confirmButtons(quote), FLOW_INTENT);
};

const askQuantity = async (from, data, prefix = '') => {
  await saveSession(from, FLOW.BOOKING, 'quantity', data);
  return replyText(from, null, `${prefix}${checkout.quantityPrompt(businessKnowledge.services.find((s) => s.id === data.serviceId))}`, FLOW_INTENT);
};

// After the service (and quantity): geofencing check or straight to pickup slots.
const afterService = (from, data) => (getServiceArea().enabled ? askLocation(from, data) : askSlot(from, FLOW.BOOKING, data));

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

    // Payment enabled -> ask the quantity so the total can be calculated.
    const payment = await getPaymentOptions(process.env.DEFAULT_BUSINESS_ID);
    if (payment.required && option.service.unitPrice) return askQuantity(from, data);
    return afterService(from, data);
  },

  quantity: async (ctx) => {
    const { from, input, data } = ctx;
    const service = businessKnowledge.services.find((s) => s.id === data.serviceId);
    const quantity = input.type === 'text' ? checkout.parseQuantity(input.text, service.unit) : null;
    if (quantity === null) return invalid(ctx, checkout.quantityError(service.unit), (p) => askQuantity(from, data, p));

    data.quantity = quantity;
    data.retries = 0;
    return afterService(from, data);
  },

  // Geofencing step: customer must share a native WhatsApp location (not text).
  location: async (ctx) => {
    const { from, input, data } = ctx;

    // WhatsApp location attachment, or a pasted Google Maps link (resolved + geocoded if needed)
    const { location, error } = await readCustomerLocation(input);
    if (!location) return invalid(ctx, LOCATION_HINTS[error], (p) => askLocation(from, data, p));

    const area = getServiceArea();
    data.retries = 0;
    if (!area.enabled) return askSlot(from, FLOW.BOOKING, data); // config removed mid-conversation
    const { decision, distanceKm, radiusKm } = decideServiceArea(location, area);
    const service = businessKnowledge.services.find((sv) => sv.id === data.serviceId);
    console.log(`[flow] Location check for ${maskPhone(from)}: ${distanceKm} km (${location.precision}, limit ${radiusKm} km) -> ${decision}`);

    // Place link too imprecise to decide (near the boundary): ask for the exact location.
    if (decision === 'uncertain') {
      await saveSession(from, FLOW.BOOKING, 'location', data);
      return replyText(from, null, `That place is near the edge of our ${radiusKm}km service radius, so we need your exact spot. Please share your location using 📎 → Location.`, FLOW_INTENT);
    }

    // Outside the radius: end the flow, record the request for reporting, tell the customer.
    const { latitude, longitude } = location;
    if (decision === 'outside') {
      await clearSession(from);
      await recordRejectedRequest({ from, name: data.name, serviceName: service?.name ?? data.serviceId, distanceKm, latitude, longitude });
      return replyText(from, null, `Sorry, your location is outside our ${radiusKm}km service radius. We cannot process this booking.`, FLOW_INTENT);
    }

    // Inside the radius: keep the coordinates for the booking and continue.
    data.geo = { latitude, longitude, distanceKm, precision: location.precision, link: location.link ?? null };
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
    const choice = input.type === 'choice' ? input.id : textMatches(input, YES_WORDS) ? 'confirm_yes' : null;
    const quote = await checkout.quoteForData(data); // re-read: settings may have changed since the summary
    const method = choice ? checkout.resolveMethod(choice, quote) : null;
    if (!method) {
      return invalid(ctx, 'Please tap one of the buttons to confirm, or *Cancel*.', () => askConfirm(from, data));
    }

    if (!findSlot(data.slot.id)) {
      return askSlot(from, FLOW.BOOKING, data, 'Sorry, your pickup time is no longer available. Please choose another.\n\n');
    }

    if (!process.env.DEFAULT_BUSINESS_ID) {
      console.error('[flow] DEFAULT_BUSINESS_ID not set; cannot save chat booking');
      await clearSession(from);
      await replyText(from, null, 'Sorry, we could not save your booking right now. Our team will contact you.', FLOW_INTENT);
      return notifyAdmin(['Chat booking failed: DEFAULT_BUSINESS_ID not configured.', `Client: +${from}`]).catch(() => {});
    }

    // Same service + pickup time already booked and open: ask before saving a second one.
    if (await duplicateGuard.askIfDuplicate({ from, data, choice })) return;

    await clearSession(from);
    return checkout.finalizeBooking({ from, data, method, quote });
  },

  duplicate: (ctx) => duplicateGuard.handleAnswer(ctx, { confirm: bookingSteps.confirm, invalid }),
};

const rescheduleSteps = {
  slot: async (ctx) => {
    const { from, input, data } = ctx;
    const option = pickOption(input, data.offeredSlots || []);
    if (!option) return invalid(ctx, 'Please choose a new pickup time from the list.', (p) => askSlot(from, FLOW.RESCHEDULE, data, p));

    if (!findSlot(option.id)) {
      return askSlot(from, FLOW.RESCHEDULE, data, 'Sorry, that time is no longer available.\n\n');
    }

    // Re-check: the order may have been picked up or cancelled while the customer was choosing.
    const current = await getBookingById(data.bookingId);
    await clearSession(from);
    if (!current || current.client_phone !== from) {
      return replyText(from, null, "Sorry, we couldn't find that booking anymore.", FLOW_INTENT);
    }
    if (!CHANGEABLE_STATUSES.includes(current.status)) {
      return replyText(from, current, `Order #${bookingRef(current)} is ${current.status.toLowerCase()} now, so the pickup time can't be changed here. Our team will contact you if needed.`, FLOW_INTENT);
    }

    const booking = await updateBookingSchedule(data.bookingId, option.start);
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

// Other services add their own session flows (e.g. orderActions: choosing one of several orders).
const registerFlow = (flow, steps) => {
  STEPS[flow] = steps;
};

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
  registerFlow,
  pickOption,
  textMatches,
  invalid,
};
