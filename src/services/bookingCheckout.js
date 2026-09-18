/**
 * src/services/bookingCheckout.js
 * Chat booking: quantity + price when payment is enabled, the payment part of the
 * booking summary, and saving the confirmed booking (with or without payment).
 *
 * Payment disabled -> exactly the original flow: booking Confirmed, confirmation + admin alert.
 * Online payment   -> booking Pending/awaiting_payment; confirmation and admin alert only after
 *                     the provider verifies the payment. Provider chosen by the admin:
 *                     Razorpay web link (paymentService) or in-chat WhatsApp Pay (whatsappPayService).
 * Cash on delivery -> booking Confirmed, payment pending (collected later, recorded by admin).
 */

const { businessKnowledge } = require('../config/businessKnowledge');
const { replyText, notifyAdmin, maskPhone } = require('./replyService');
const { alertAdminNewBooking } = require('./notificationService');
const { notifyAdminGeofencedBooking } = require('./serviceAreaService');
const paymentService = require('./paymentService');
const whatsappPay = require('./whatsappPayService');
const { createBooking } = require('../models/bookingModel');
const { bookingTotal, formatINR } = require('../utils/money');

const FLOW_INTENT = 'booking_flow';

const bookingRef = (booking) => booking.id.slice(0, 8).toUpperCase();
const findService = (serviceId) => businessKnowledge.services.find((s) => s.id === serviceId);

// ---------------------------------------------------------------------------
// Quantity (only asked when payment is enabled)
// ---------------------------------------------------------------------------
const unitLabel = (unit, n = 2) => (unit === 'kg' ? 'kg' : n === 1 ? 'piece' : 'pieces');

const quantityPrompt = (service) =>
  service.unit === 'kg'
    ? `About how many kg of clothes for ${service.name}? (${service.price})\nAn estimate is fine, e.g. *5*. We weigh them at pickup.`
    : `How many pieces for ${service.name}? (${service.price})\nFor example *6*.`;

/**
 * "5", "5 kg", "3.5kg", "6 pieces" -> number within the limits, else null.
 * Pieces must be whole numbers.
 */
const parseQuantity = (text, unit) => {
  const match = String(text ?? '').trim().toLowerCase().match(/^(\d{1,3}(?:\.\d{1,2})?)\s*(kg|kgs|kilo|kilos|pcs|pieces?|nos?)?$/);
  if (!match) return null;
  const value = Number(match[1]);
  const limits = businessKnowledge.quantityLimits?.[unit] || { min: 1, max: 100 };
  if (unit === 'piece' && !Number.isInteger(value)) return null;
  return value >= limits.min && value <= limits.max ? value : null;
};

const quantityError = (unit) => {
  const { min, max } = businessKnowledge.quantityLimits?.[unit] || { min: 1, max: 100 };
  return unit === 'kg'
    ? `Please send the weight as a number between ${min} and ${max} (kg).`
    : `Please send the number of pieces as a whole number between ${min} and ${max}.`;
};

// ---------------------------------------------------------------------------
// Summary + buttons
// ---------------------------------------------------------------------------

/**
 * Current payment options + quote for the session data.
 * @returns {Promise<{options: object, terms: object|null}>}
 */
const quoteForData = async (data) => {
  const options = await paymentService.getPaymentOptions(process.env.DEFAULT_BUSINESS_ID);
  const service = findService(data.serviceId);
  if (!options.required || !data.quantity || !service?.unitPrice) return { options: { ...options, required: false }, terms: null };
  const total = bookingTotal(data.quantity, service.unitPrice);
  return { options, terms: paymentService.quote(options.settings, total) };
};

const paymentSummaryLines = ({ options, terms }, data) => {
  if (!terms) return [];
  const service = findService(data.serviceId);
  const lines = [
    '',
    `🧺 Quantity: ${data.quantity} ${unitLabel(service.unit, data.quantity)} × ${formatINR(service.unitPrice)}`,
    `💰 Total: ${formatINR(terms.total)}`,
  ];
  if (options.online) {
    const where = options.provider === 'whatsapp_pay' ? 'in WhatsApp' : 'online';
    lines.push(terms.remaining > 0
      ? `💳 Pay ${where}: ${formatINR(terms.dueNow)} now (advance), ${formatINR(terms.remaining)} later`
      : `💳 Pay ${where}: ${formatINR(terms.dueNow)} now`);
  }
  if (options.cod) lines.push(`💵 Or pay ${formatINR(terms.total)} cash on delivery`);
  return lines;
};

const confirmButtons = ({ options, terms }) => {
  if (!terms) {
    return [
      { id: 'confirm_yes', title: 'Confirm' },
      { id: 'confirm_restart', title: 'Start over' },
      { id: 'confirm_no', title: 'Cancel' },
    ];
  }
  const buttons = [];
  if (options.online) buttons.push({ id: 'confirm_pay', title: `Pay ${formatINR(terms.dueNow)}` });
  if (options.cod) buttons.push({ id: 'confirm_cod', title: 'Cash on delivery' });
  if (buttons.length < 2) buttons.push({ id: 'confirm_restart', title: 'Start over' });
  buttons.push({ id: 'confirm_no', title: 'Cancel' });
  return buttons;
};

/**
 * Which payment the customer chose. confirm_yes / "yes" pick the first available option.
 * @returns {'none'|'razorpay'|'whatsapp_pay'|'cod'|null} null = choice not available
 */
const resolveMethod = (choiceId, { options, terms }) => {
  if (!terms) return choiceId === 'confirm_yes' ? 'none' : null;
  const online = options.provider === 'whatsapp_pay' ? 'whatsapp_pay' : 'razorpay';
  if (choiceId === 'confirm_pay') return options.online ? online : null;
  if (choiceId === 'confirm_cod') return options.cod ? 'cod' : null;
  if (choiceId === 'confirm_yes') return options.online ? online : 'cod';
  return null;
};

// ---------------------------------------------------------------------------
// Save the booking
// ---------------------------------------------------------------------------
const confirmationText = (booking, data, extra = []) =>
  [
    '✅ Booking confirmed!',
    '',
    `Ref: #${bookingRef(booking)}`,
    `${booking.service_type} pickup: ${data.slot.title} (${data.slot.description})`,
    ...extra,
    '',
    'Reply *track* anytime to check your order, or *reschedule* / *cancel* to change it.',
  ].join('\n');

/**
 * Create the booking for a confirmed chat session and send the right messages.
 * @param {{from: string, data: object, method: 'none'|'razorpay'|'whatsapp_pay'|'cod', quote: {options, terms}}} args
 */
const finalizeBooking = async ({ from, data, method, quote }) => {
  const businessId = process.env.DEFAULT_BUSINESS_ID;
  const service = findService(data.serviceId);

  const base = {
    clientPhone: from,
    clientName: data.name,
    serviceType: service?.name ?? data.serviceId,
    pickupAddress: data.address,
    scheduledTime: data.slot.start,
    notes: data.notes,
    source: 'whatsapp',
    status: 'Confirmed',
    bookingState: 'confirmed',
    latitude: data.geo?.latitude,
    longitude: data.geo?.longitude,
    distanceKm: data.geo?.distanceKm,
    locationPrecision: data.geo?.precision,
    locationLink: data.geo?.link,
    ...(data.quantity && service?.unitPrice
      ? { quantity: data.quantity, unit: service.unit, unitPrice: service.unitPrice }
      : {}),
  };

  const payment = method === 'none' || !quote.terms
    ? {}
    : paymentService.paymentFieldsForBooking(quote.options.settings, quote.terms.total, method);
  const booking = await createBooking(businessId, { ...base, ...payment });
  console.log(`[flow] Chat booking ${booking.id} created for ${maskPhone(from)} (payment: ${method})`);

  // WhatsApp Pay: reserve, then send the in-chat "Review and pay" message.
  // Nothing is confirmed until WhatsApp reports a successful payment.
  if (method === 'whatsapp_pay') {
    const due = Number(booking.amount_due_now);
    const remaining = Number(booking.total_amount) - due;
    await replyText(
      from,
      booking,
      [
        `🧾 Booking #${bookingRef(booking)} is reserved - payment needed to confirm.`,
        `Pay now: ${formatINR(due)}${remaining > 0 ? ` (remaining ${formatINR(remaining)} later)` : ''}`,
        '',
        "Tap *Review and pay* on the next message. We'll confirm your pickup as soon as the payment is received.",
      ].join('\n'),
      FLOW_INTENT
    );
    await whatsappPay.remindPayment(booking); // sends the order_details message; reports failures itself
    return booking;
  }

  // Razorpay link: nothing is confirmed until Razorpay verifies the payment.
  if (method === 'razorpay') {
    const due = Number(booking.amount_due_now);
    const remaining = Number(booking.total_amount) - due;
    await replyText(
      from,
      booking,
      [
        `🧾 Booking #${bookingRef(booking)} is reserved - payment needed to confirm.`,
        '',
        `Total: ${formatINR(booking.total_amount)}`,
        `Pay now: ${formatINR(due)}${remaining > 0 ? ` (remaining ${formatINR(remaining)} later)` : ''}`,
        '',
        `Pay securely here: ${paymentService.paymentLink(booking)}`,
        '',
        "We'll confirm your pickup as soon as the payment is received.",
      ].join('\n'),
      FLOW_INTENT
    );
    return booking;
  }

  const extra = method === 'cod'
    ? ['', `Total: ${formatINR(booking.total_amount)}`, '💵 Payment: cash on delivery']
    : [];
  await replyText(from, booking, confirmationText(booking, data, extra), FLOW_INTENT);
  await alertAdminNewBooking(booking);
  if (method === 'cod') {
    await notifyAdmin([
      'New booking received (cash on delivery).',
      `Booking #${bookingRef(booking)} - ${booking.client_name || 'Customer'} (+${from})`,
      ...paymentService.amountLines(booking),
    ]).catch((err) => console.error(`[flow] Admin COD notice failed: ${err.message}`));
  }
  if (data.geo) await notifyAdminGeofencedBooking(booking, data);
  return booking;
};

module.exports = {
  quantityPrompt,
  parseQuantity,
  quantityError,
  quoteForData,
  paymentSummaryLines,
  confirmButtons,
  resolveMethod,
  finalizeBooking,
};
