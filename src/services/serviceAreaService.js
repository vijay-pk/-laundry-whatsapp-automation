/**
 * src/services/serviceAreaService.js
 * Geofenced pickup check helpers:
 *   - read the customer's location from a WhatsApp location or a pasted Google Maps link
 *   - decide inside / outside / uncertain (approximate locations get a safety margin)
 *   - record rejected requests and tell the admin where an accepted pickup is
 * Side-effect functions never throw: the conversation must continue even if they fail.
 */

const { createBooking } = require('../models/bookingModel');
const { notifyAdmin } = require('./replyService');
const { resolveMapsLink } = require('./locationResolver');
const { mapsLink, parseCoordinates, checkServiceArea } = require('../utils/geo');
const { extractMapsUrl } = require('../utils/mapsLink');
const { formatDateTime } = require('../utils/formatDate');

/**
 * Customer location from their answer.
 * @returns {Promise<{location: object} | {error: 'not_location' | 'unreadable_link'}>}
 *   location: { latitude, longitude, precision: 'exact'|'approximate', uncertaintyKm, link?, label? }
 */
const readCustomerLocation = async (input) => {
  if (input.type === 'location') {
    const coords = parseCoordinates(input.location?.latitude, input.location?.longitude);
    return coords ? { location: { ...coords, precision: 'exact', uncertaintyKm: 0 } } : { error: 'not_location' };
  }
  if (input.type === 'text' && extractMapsUrl(input.text)) {
    const location = await resolveMapsLink(input.text);
    return location ? { location } : { error: 'unreadable_link' };
  }
  return { error: 'not_location' };
};

/**
 * Inside / outside the radius. For approximate (geocoded) locations the uncertainty is
 * applied both ways: only clearly-inside is accepted and only clearly-outside rejected.
 * @returns {{decision: 'inside'|'outside'|'uncertain', distanceKm: number, radiusKm: number}}
 */
const decideServiceArea = (location, area) => {
  const { distanceKm, radiusKm } = checkServiceArea(location.latitude, location.longitude, area);
  const margin = location.uncertaintyKm || 0;
  let decision = 'uncertain';
  if (distanceKm + margin <= radiusKm) decision = 'inside';
  else if (distanceKm - margin > radiusKm) decision = 'outside';
  return { decision, distanceKm, radiusKm };
};

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
 * `data` (chat session: slot + geo) is optional; without it the details come from the booking row
 * (used after an online payment). Returns false for bookings without a checked location.
 * Text messages need the admin to have messaged the business number in the last 24h.
 */
const notifyAdminGeofencedBooking = async (booking, data = {}) => {
  const geo = data.geo || (booking.latitude !== null && booking.latitude !== undefined
    ? {
        latitude: Number(booking.latitude),
        longitude: Number(booking.longitude),
        distanceKm: Number(booking.distance_km),
        precision: booking.location_precision,
        link: booking.location_link,
      }
    : null);
  if (!geo) return false;
  const slot = data.slot || {
    title: booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : 'not scheduled',
    description: 'pickup',
  };

  try {
    return await notifyAdmin([
      '📍 New pickup inside service area',
      `Customer: ${booking.client_name || 'Unknown'}`,
      `Phone: +${booking.client_phone}`,
      `Service: ${booking.service_type}`,
      `Pickup: ${slot.title} (${slot.description})`,
      `Distance: ${geo.distanceKm} km${geo.precision === 'approximate' ? ' (approximate, from a place link)' : ''}`,
      `Location: ${mapsLink(geo.latitude, geo.longitude)}`,
      ...(geo.link ? [`Customer's link: ${geo.link}`] : []),
    ]);
  } catch (err) {
    console.error(`[service-area] Admin location notice failed: ${err.message}`);
  }
};

module.exports = { readCustomerLocation, decideServiceArea, recordRejectedRequest, notifyAdminGeofencedBooking };
