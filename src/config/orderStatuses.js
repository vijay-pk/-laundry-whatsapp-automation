/**
 * src/config/orderStatuses.js
 * Order lifecycle and the message customers get at each stage.
 */

// In lifecycle order. Keys are stored in bookings.status.
const ORDER_STATUSES = {
  Pending: 'We have received your booking request.',
  Confirmed: 'Your pickup is confirmed for {slot}.',
  'Out for Pickup': 'Our driver is on the way to pick up your clothes.',
  'Picked Up': 'Your clothes have been picked up.',
  Processing: 'Your clothes have been received and are being processed.',
  Ready: 'Your clothes are ready! We will deliver them soon.',
  'Out for Delivery': 'Your clothes are out for delivery.',
  Delivered: 'Your order has been delivered. Thank you for choosing us!',
  Cancelled: 'Your booking has been cancelled.',
};

const STATUS_NAMES = Object.keys(ORDER_STATUSES);

// Customer can cancel or reschedule by chat only before pickup.
const CHANGEABLE_STATUSES = ['Pending', 'Confirmed', 'Out for Pickup'];

// Finished orders: not "active" for tracking or changes.
const CLOSED_STATUSES = ['Delivered', 'Cancelled'];

const isValidStatus = (status) => STATUS_NAMES.includes(status);

/**
 * Customer-facing text for a booking's current status.
 * @param {object} booking  bookings row
 * @param {(date: Date) => string} formatSlot
 */
const statusMessage = (booking, formatSlot) => {
  const template = ORDER_STATUSES[booking.status] || `Your order status: ${booking.status}.`;
  const slot = booking.scheduled_time ? formatSlot(new Date(booking.scheduled_time)) : 'the agreed time';
  return template.replace('{slot}', slot);
};

module.exports = {
  ORDER_STATUSES,
  STATUS_NAMES,
  CHANGEABLE_STATUSES,
  CLOSED_STATUSES,
  isValidStatus,
  statusMessage,
};
