/**
 * src/controllers/bookingController.js
 * Booking API: intake from third-party systems (admin alerted on WhatsApp)
 * and order status updates (customer notified on WhatsApp).
 */

const {
  createBooking,
  findBookingByExternalId,
  getBookingById,
  updateBookingStatus,
} = require('../models/bookingModel');
const { alertAdminNewBooking, notifyCustomerStatus } = require('../services/notificationService');
const { STATUS_NAMES, isValidStatus } = require('../config/orderStatuses');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 3. Route handlers
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

    const bookingData = {
      clientName: body.clientName.trim(),
      clientPhone: body.clientPhone.replace(/\D/g, ''), // same format as webhook `from`
      serviceType: body.serviceType.trim(),
      pickupAddress: typeof body.pickupAddress === 'string' ? body.pickupAddress.trim() : null,
      scheduledTime: new Date(body.scheduledTime).toISOString(),
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
    const notification = await alertAdminNewBooking(booking);

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

/**
 * PATCH /api/bookings/:id/status
 * Body: { status }  one of STATUS_NAMES (Pending, Confirmed, Out for Pickup, ... Delivered, Cancelled)
 *
 * Saves the new status, then messages the customer. A WhatsApp failure does not fail
 * the request: the status is saved and the response reports notification.sent = false.
 * Setting the same status again does not message the customer twice.
 */
const updateStatus = async (req, res, next) => {
  try {
    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
    if (!isValidStatus(status)) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: [`status must be one of: ${STATUS_NAMES.join(', ')}`],
      });
    }

    const previous = await getBookingById(req.params.id);
    if (!previous) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    if (previous.status === status) {
      return res.status(200).json({
        success: true,
        data: previous,
        notification: { sent: false, skipped: 'status unchanged' },
      });
    }

    const booking = await updateBookingStatus(previous.id, status);
    console.log(`[booking] Booking ${booking.id} status ${previous.status} -> ${status}`);

    const notification = await notifyCustomerStatus(booking);
    return res.status(200).json({ success: true, data: booking, notification });
  } catch (err) {
    return next(err);
  }
};

module.exports = {
  createNewBooking,
  updateStatus,
};
