/**
 * src/services/notificationService.js
 * Booking notifications: new-booking alerts to the admin and
 * order status updates to customers. Never throw: callers have already
 * saved their changes, so failures are reported, not raised.
 */

const { sendTemplateMessage, sendTextMessage } = require('./whatsappService');
const { safeLog } = require('./replyService');
const { bookingRef, statusMessage } = require('../config/orderStatuses');
const { formatDateTime } = require('../utils/formatDate');

// Approved template, assumed body: "New booking: {{1}} booked {{2}} for {{3}}."
const ADMIN_ALERT_TEMPLATE = 'laundry_booking_alert';

/**
 * Alert the admin about a new booking (template, works outside the 24-hour window).
 * @returns {Promise<{sent: boolean, messageId?: string, error?: string}>}
 */
const alertAdminNewBooking = async (booking) => {
  const adminPhone = process.env.ADMIN_PHONE;
  if (!adminPhone) {
    console.warn('[notify] ADMIN_PHONE not set; admin alert skipped');
    return { sent: false, error: 'ADMIN_PHONE not configured' };
  }

  const variables = [
    booking.client_name || 'Customer',
    booking.service_type || 'Laundry',
    booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : 'Not scheduled',
  ];

  try {
    const { messageId } = await sendTemplateMessage(adminPhone, ADMIN_ALERT_TEMPLATE, variables);
    return { sent: true, messageId };
  } catch (err) {
    console.error(`[notify] Admin alert failed: ${err.message}${err.hint ? ` | hint: ${err.hint}` : ''}`);
    return { sent: false, error: err.message };
  }
};

/**
 * Tell the customer their order's current status, prefixed with the order ref
 * (customers with several orders know which one changed).
 * Uses TEMPLATE_ORDER_STATUS (body "Hi {{1}}, {{2}}") when set, so it arrives even
 * outside the 24-hour window; otherwise plain text.
 * @returns {Promise<{sent: boolean, channel: 'template'|'text', messageId?: string, error?: string}>}
 */
const notifyCustomerStatus = async (booking) => {
  const text = `Order #${bookingRef(booking)}: ${statusMessage(booking, formatDateTime)}`;
  const template = process.env.TEMPLATE_ORDER_STATUS;
  const channel = template ? 'template' : 'text';

  try {
    const { messageId } = template
      ? await sendTemplateMessage(booking.client_phone, template, [booking.client_name || 'there', text])
      : await sendTextMessage(booking.client_phone, text);

    await safeLog(booking, 'outbound', text, 'status_update', booking.client_phone);
    return { sent: true, channel, messageId };
  } catch (err) {
    console.error(`[notify] Status update failed: ${err.message}${err.hint ? ` | hint: ${err.hint}` : ''}`);
    return { sent: false, channel, error: err.message };
  }
};

module.exports = { ADMIN_ALERT_TEMPLATE, alertAdminNewBooking, notifyCustomerStatus };
