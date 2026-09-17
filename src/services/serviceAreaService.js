/**
 * src/services/serviceAreaService.js
 * Side effects of the geofenced pickup check: recording rejected requests and
 * telling the admin where an accepted pickup is. Never throw: the customer's
 * conversation must continue even if these fail.
 */

const { createBooking } = require('../models/bookingModel');
const { notifyAdmin } = require('./replyService');
const { mapsLink } = require('../utils/geo');

/**
 * Save a request from outside the service radius (status Cancelled, booking_state 'rejected')
 * so the business can see demand from areas it doesn't serve yet.
 */
const recordRejectedRequest = async ({ from, name, serviceName, latitude, longitude, distanceKm }) => {
  const businessId = process.env.DEFAULT_BUSINESS_ID;
  if (!businessId) return null;

  try {
    return await createBooking(businessId, {
      clientPhone: from,
      clientName: name,
      serviceType: serviceName,
      source: 'whatsapp',
      status: 'Cancelled',
      bookingState: 'rejected',
      latitude,
      longitude,
      distanceKm,
    });
  } catch (err) {
    console.error(`[service-area] Could not record rejected request: ${err.message}`);
    return null;
  }
};

/**
 * WhatsApp text to the admin for a confirmed booking inside the service radius:
 * customer name, phone, service, pickup slot, distance and a Google Maps link.
 * Text messages need the admin to have messaged the business number in the last 24h.
 */
const notifyAdminGeofencedBooking = async (booking, { slot, geo }) => {
  try {
    await notifyAdmin([
      '📍 New pickup inside service area',
      `Customer: ${booking.client_name || 'Unknown'}`,
      `Phone: +${booking.client_phone}`,
      `Service: ${booking.service_type}`,
      `Pickup: ${slot.title} (${slot.description})`,
      `Distance: ${geo.distanceKm} km`,
      `Location: ${mapsLink(geo.latitude, geo.longitude)}`,
    ]);
  } catch (err) {
    console.error(`[service-area] Admin location notice failed: ${err.message}`);
  }
};

module.exports = { recordRejectedRequest, notifyAdminGeofencedBooking };
