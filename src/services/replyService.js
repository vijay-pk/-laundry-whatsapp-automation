/**
 * src/services/replyService.js
 * Send WhatsApp replies to customers and record them in the conversation log.
 * Shared by the webhook controller and the chat flows.
 */

const { sendTextMessage, sendButtonsMessage, sendListMessage } = require('./whatsappService');
const { logMessage } = require('../models/bookingModel');

// Only log the last 4 digits. Phone numbers are customer PII.
const maskPhone = (phone) => `***${String(phone).slice(-4)}`;

// Accept a booking row, a booking id, or null.
const bookingIdOf = (booking) => (typeof booking === 'string' ? booking : booking?.id ?? null);

// A failed database log must never block a reply to the customer.
const safeLog = async (booking, direction, content, intent, clientPhone) => {
  try {
    await logMessage(bookingIdOf(booking), direction, content, intent, clientPhone);
  } catch (err) {
    console.error(`[reply] Failed to log ${direction} message: ${err.message}`);
  }
};

const replyText = async (to, booking, text, intent) => {
  await sendTextMessage(to, text);
  await safeLog(booking, 'outbound', text, intent, to);
};

const replyButtons = async (to, booking, body, buttons, intent) => {
  await sendButtonsMessage(to, body, buttons);
  await safeLog(booking, 'outbound', `${body}\n[buttons: ${buttons.map((b) => b.title).join(' | ')}]`, intent, to);
};

const replyList = async (to, booking, body, buttonText, rows, intent) => {
  await sendListMessage(to, body, buttonText, rows);
  await safeLog(booking, 'outbound', `${body}\n[list: ${rows.map((r) => r.title).join(' | ')}]`, intent, to);
};

// Plain-text note to the admin. Returns false if ADMIN_PHONE is missing or sending failed.
// Never throws: the customer has usually been answered already, and a failed admin note must not
// turn the message into an error (which would also send the customer an apology).
// Text only arrives if the admin messaged the business number in the last 24 hours.
const notifyAdmin = async (lines) => {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) {
    console.warn('[reply] ADMIN_PHONE not set; admin notification skipped');
    return false;
  }
  try {
    await sendTextMessage(adminPhone, lines.join('\n'));
    return true;
  } catch (err) {
    console.error(`[reply] Admin notification failed: ${err.message}${err.hint ? ` | hint: ${err.hint}` : ''}`);
    return false;
  }
};

module.exports = { maskPhone, safeLog, replyText, replyButtons, replyList, notifyAdmin };
