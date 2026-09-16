/**
 * src/controllers/bookingController.js
 * Receives bookings from third-party systems and alerts the admin on WhatsApp.
 */

const { createBooking, findBookingByExternalId } = require('../models/bookingModel');
const { sendTemplateMessage } = require('../services/whatsappService');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
// Approved template, assumed body: "New booking: {{1}} booked {{2}} for {{3}}."
const ADMIN_ALERT_TEMPLATE = 'laundry_booking_alert';

const REQUIRED_FIELDS = ['clientName', 'clientPhone', 'serviceType', 'scheduledTime'];

const MAX_EXTERNAL_ID_LENGTH = 255;

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------

// Returns a list of validation problems (empty list = valid).
const validateBookingInput = (body) => {
  const errors = [];

  for (const field of REQUIRED_FIELDS) {
    if (typeof body[field] !== 'string' || body[field].trim() === '') {
      errors.push(`${field} is required and must be a non-empty string`);
    }
  }

  if (typeof body.clientPhone === 'string') {
    const digits = body.clientPhone.replace(/\D/g, '');
    if (digits.length < 8 || digits.length > 15) {
      errors.push('clientPhone must be a valid international number with country code');
    }
  }

  if (typeof body.scheduledTime === 'string' && Number.isNaN(Date.parse(body.scheduledTime))) {
    errors.push('scheduledTime must be a valid ISO 8601 date, e.g. 2026-09-20T15:00:00+05:30');
  }

  if (typeof body.clientName === 'string' && body.clientName.length > 255) {
    errors.push('clientName must be 255 characters or fewer');
  }
  if (typeof body.serviceType === 'string' && body.serviceType.length > 100) {
    errors.push('serviceType must be 100 characters or fewer');
  }

  return errors;
};

// Idempotency key: body `externalId` (caller's own booking id) or `Idempotency-Key` header.
// Returns { key } (key may be null = no deduplication) or { error }.
const resolveExternalId = (req) => {
  const fromBody = req.body?.externalId;
  const fromHeader = req.get('idempotency-key');

  if (fromBody !== undefined && typeof fromBody !== 'string') {
    return { error: 'externalId must be a string' };
  }

  const bodyKey = fromBody?.trim() || null;
  const headerKey = fromHeader?.trim() || null;

  if (bodyKey && headerKey && bodyKey !== headerKey) {
    return { error: 'externalId and Idempotency-Key header must match when both are sent' };
  }

  const key = bodyKey || headerKey;
  if (key && key.length > MAX_EXTERNAL_ID_LENGTH) {
    return { error: `externalId must be ${MAX_EXTERNAL_ID_LENGTH} characters or fewer` };
  }

  return { key };
};

// A retry must describe the same booking. Reusing a key for different details is a caller bug.
const sameBookingDetails = (existing, incoming) =>
  existing.client_phone === incoming.clientPhone &&
  existing.client_name === incoming.clientName &&
  existing.service_type === incoming.serviceType &&
  (existing.pickup_address ?? null) === (incoming.pickupAddress ?? null) &&
  new Date(existing.scheduled_time).getTime() === new Date(incoming.scheduledTime).getTime();

// Turn an ISO timestamp into something readable in the admin's WhatsApp alert.
const formatForHumans = (date) => {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: process.env.TIMEZONE || 'UTC',
    }).format(date);
  } catch {
    return date.toISOString(); // invalid TIMEZONE value, fall back to ISO
  }
};

// Send the admin alert. Never throws: the booking is already saved, so a
// WhatsApp failure is reported in the response rather than failing the request.
const notifyAdmin = async (variables) => {
  const adminPhone = process.env.ADMIN_PHONE;

  if (!adminPhone) {
    console.warn('[booking] ADMIN_PHONE not set; admin alert skipped');
    return { sent: false, error: 'ADMIN_PHONE not configured' };
  }

  try {
    const { messageId } = await sendTemplateMessage(adminPhone, ADMIN_ALERT_TEMPLATE, variables);
    return { sent: true, messageId };
  } catch (err) {
    console.error(`[booking] Admin alert failed: ${err.message}${err.hint ? ` | hint: ${err.hint}` : ''}`);
    return { sent: false, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// 3. Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/bookings
 * Body: { clientName, clientPhone, serviceType, scheduledTime, pickupAddress?, businessId?, externalId? }
 * Header (alternative to externalId): Idempotency-Key
 *
 * Idempotent when externalId / Idempotency-Key is sent:
 *   first request            -> 201, booking created, admin alerted
 *   retry, same details      -> 200, existing booking, duplicate: true, no second alert
 *   same key, other details  -> 409
 */
const createNewBooking = async (req, res, next) => {
  try {
    const body = req.body ?? {};

    // --- Validate input ---------------------------------------------------
    const errors = validateBookingInput(body);
    const { key: externalId, error: keyError } = resolveExternalId(req);
    if (keyError) errors.push(keyError);

    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: 'Validation failed', details: errors });
    }

    // Single-tenant for now: fall back to the default business.
    const businessId = body.businessId || process.env.DEFAULT_BUSINESS_ID;
    if (!businessId) {
      return res.status(400).json({
        success: false,
        error: 'businessId is required (or set DEFAULT_BUSINESS_ID on the server)',
      });
    }

    const scheduledDate = new Date(body.scheduledTime);
    const clientName = body.clientName.trim();
    const serviceType = body.serviceType.trim();

    const bookingData = {
      clientName,
      clientPhone: body.clientPhone.replace(/\D/g, ''), // same format as webhook `from`
      serviceType,
      pickupAddress: typeof body.pickupAddress === 'string' ? body.pickupAddress.trim() : null,
      scheduledTime: scheduledDate.toISOString(),
      externalId,
    };

    // --- Save booking -------------------------------------------------------
    const booking = await createBooking(businessId, bookingData);

    // --- Duplicate request (same externalId) ---------------------------------
    if (!booking) {
      const existing = await findBookingByExternalId(businessId, externalId);

      if (!existing) {
        // Conflicting row vanished between INSERT and SELECT (deleted); let the caller retry.
        return res.status(409).json({ success: false, error: 'Concurrent change, please retry' });
      }

      if (!sameBookingDetails(existing, bookingData)) {
        console.warn(`[booking] externalId reused with different details (booking ${existing.id})`);
        return res.status(409).json({
          success: false,
          error: 'externalId already used for a booking with different details',
          bookingId: existing.id,
        });
      }

      console.log(`[booking] Duplicate request for booking ${existing.id}; returning existing`);
      return res.status(200).json({
        success: true,
        duplicate: true,
        data: existing,
        notification: { sent: false, skipped: 'duplicate request' },
      });
    }

    console.log(`[booking] Created booking ${booking.id} for business ${businessId}`);

    // --- Alert admin ---------------------------------------------------------
    const notification = await notifyAdmin([clientName, serviceType, formatForHumans(scheduledDate)]);

    // --- Respond ---------------------------------------------------------------
    return res.status(201).json({
      success: true,
      duplicate: false,
      data: booking,
      notification,
    });
  } catch (err) {
    // Database errors carry a status (400/404/500) from bookingModel.
    // Hand them to the centralized error handler in server.js.
    return next(err);
  }
};

module.exports = {
  createNewBooking,
};
