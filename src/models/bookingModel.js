/**
 * src/models/bookingModel.js
 * Data access for bookings and the message log.
 */

const { query } = require('../config/db');

const VALID_DIRECTIONS = ['inbound', 'outbound'];

// ---------------------------------------------------------------------------
// Error helpers
// Errors carry an HTTP-style `status` that server.js's error handler reads.
// ---------------------------------------------------------------------------
const createError = (message, status = 500, cause) => {
  const err = new Error(message);
  err.status = status;
  if (cause) err.cause = cause;
  return err;
};

// Turn common PostgreSQL error codes into meaningful errors.
const handleDbError = (operation, err) => {
  switch (err.code) {
    case '22P02': // invalid_text_representation (e.g. malformed UUID)
      return createError(`${operation}: invalid identifier format`, 400, err);
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
      return createError(`${operation}: invalid date/time value`, 400, err);
    case '23503': // foreign_key_violation
      return createError(`${operation}: referenced record does not exist`, 404, err);
    case '23514': // check_violation
      return createError(`${operation}: value violates a constraint`, 400, err);
    default:
      return createError(`${operation}: database error`, 500, err);
  }
};

const requireString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw createError(`${field} is required and must be a non-empty string`, 400);
  }
};

// ---------------------------------------------------------------------------
// createBooking
// clientData: { clientPhone, clientName, serviceType, pickupAddress, scheduledTime,
//              externalId?, notes?, source? ("api" | "whatsapp"), status? (default Pending),
//              latitude?, longitude?, distanceKm?, bookingState? (default 'pending') }
// Returns the created booking row.
// With externalId: returns null if this business already has a booking with that
// externalId (duplicate request). The unique index makes this safe under concurrency.
// Note: pg returns DECIMAL columns (latitude, longitude, distance_km) as strings.
// ---------------------------------------------------------------------------
const MAX_BOOKING_STATE_LENGTH = 30;

const validateGeoFields = (data) => {
  for (const field of ['latitude', 'longitude', 'distanceKm']) {
    const value = data[field];
    if (value !== undefined && value !== null && !Number.isFinite(Number(value))) {
      throw createError(`${field} must be a number`, 400);
    }
  }
  if (data.bookingState !== undefined && data.bookingState !== null) {
    requireString(data.bookingState, 'bookingState');
    if (data.bookingState.length > MAX_BOOKING_STATE_LENGTH) {
      throw createError(`bookingState must be ${MAX_BOOKING_STATE_LENGTH} characters or fewer`, 400);
    }
  }
};

const createBooking = async (businessId, clientData = {}) => {
  requireString(businessId, 'businessId');
  requireString(clientData.clientPhone, 'clientData.clientPhone');
  validateGeoFields(clientData);

  const sql = `
    INSERT INTO bookings
      (business_id, client_phone, client_name, service_type, pickup_address, scheduled_time,
       external_id, notes, source, status, latitude, longitude, distance_km, booking_state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'api'), COALESCE($10, 'Pending'),
            $11, $12, $13, COALESCE($14, 'pending'))
    ON CONFLICT (business_id, external_id) DO NOTHING
    RETURNING *
  `;
  const params = [
    businessId,
    clientData.clientPhone.trim(),
    clientData.clientName ?? null,
    clientData.serviceType ?? null,
    clientData.pickupAddress ?? null,
    clientData.scheduledTime ?? null,
    clientData.externalId ?? null,
    clientData.notes ?? null,
    clientData.source ?? null,
    clientData.status ?? null,
    clientData.latitude ?? null,
    clientData.longitude ?? null,
    clientData.distanceKm ?? null,
    clientData.bookingState ?? null,
  ];

  try {
    const { rows } = await query(sql, params);
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('createBooking', err);
  }
};

// ---------------------------------------------------------------------------
// findBookingByExternalId
// Returns the booking row, or null if none exists.
// ---------------------------------------------------------------------------
const findBookingByExternalId = async (businessId, externalId) => {
  requireString(businessId, 'businessId');
  requireString(externalId, 'externalId');

  try {
    const { rows } = await query(
      'SELECT * FROM bookings WHERE business_id = $1 AND external_id = $2',
      [businessId, externalId]
    );
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('findBookingByExternalId', err);
  }
};

// ---------------------------------------------------------------------------
// getBookingById
// Returns the booking row, or null if none exists. Malformed ids -> 400.
// ---------------------------------------------------------------------------
const getBookingById = async (bookingId) => {
  requireString(bookingId, 'bookingId');

  try {
    const { rows } = await query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('getBookingById', err);
  }
};

// ---------------------------------------------------------------------------
// getLatestBookingForClient
// Pass businessId in multi-tenant use: the same phone number can be a customer
// of several businesses. Leaving it out searches every tenant.
// Returns the booking row, or null if none exists.
// ---------------------------------------------------------------------------
const getLatestBookingForClient = async (clientPhone, businessId = null) => {
  requireString(clientPhone, 'clientPhone');

  const sql = businessId
    ? `SELECT * FROM bookings
       WHERE client_phone = $1 AND business_id = $2
       ORDER BY created_at DESC
       LIMIT 1`
    : `SELECT * FROM bookings
       WHERE client_phone = $1
       ORDER BY created_at DESC
       LIMIT 1`;
  const params = businessId ? [clientPhone.trim(), businessId] : [clientPhone.trim()];

  try {
    const { rows } = await query(sql, params);
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('getLatestBookingForClient', err);
  }
};

// ---------------------------------------------------------------------------
// updateBookingStatus
// Optional `extra`: { bookingState?, latitude?, longitude?, distanceKm? }
// Only fields that are provided are changed; others keep their current value.
// Returns the updated booking row, or null if the booking doesn't exist.
// ---------------------------------------------------------------------------
const updateBookingStatus = async (bookingId, status, extra = {}) => {
  requireString(bookingId, 'bookingId');
  requireString(status, 'status');
  validateGeoFields(extra);

  if (status.length > 50) {
    throw createError('status must be 50 characters or fewer', 400);
  }

  const sql = `
    UPDATE bookings
    SET status = $1,
        booking_state = COALESCE($3, booking_state),
        latitude = COALESCE($4, latitude),
        longitude = COALESCE($5, longitude),
        distance_km = COALESCE($6, distance_km),
        updated_at = NOW()
    WHERE id = $2
    RETURNING *
  `;

  try {
    const { rows } = await query(sql, [
      status.trim(),
      bookingId,
      extra.bookingState ?? null,
      extra.latitude ?? null,
      extra.longitude ?? null,
      extra.distanceKm ?? null,
    ]);
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('updateBookingStatus', err);
  }
};

// ---------------------------------------------------------------------------
// updateBookingSchedule
// Returns the updated booking row, or null if the booking doesn't exist.
// ---------------------------------------------------------------------------
const updateBookingSchedule = async (bookingId, scheduledTime) => {
  requireString(bookingId, 'bookingId');
  requireString(scheduledTime, 'scheduledTime');

  try {
    const { rows } = await query(
      'UPDATE bookings SET scheduled_time = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [scheduledTime, bookingId]
    );
    return rows[0] || null;
  } catch (err) {
    throw handleDbError('updateBookingSchedule', err);
  }
};

// ---------------------------------------------------------------------------
// logMessage
// bookingId may be null (e.g. a question sent before any booking exists).
// clientPhone links the message to the customer for AI history and learning.
// Returns the created message row.
// ---------------------------------------------------------------------------
const logMessage = async (bookingId, direction, content, intent = null, clientPhone = null) => {
  if (!VALID_DIRECTIONS.includes(direction)) {
    throw createError(`direction must be one of: ${VALID_DIRECTIONS.join(', ')}`, 400);
  }
  if (typeof content !== 'string' || content.length === 0) {
    throw createError('content is required and must be a non-empty string', 400);
  }

  const sql = `
    INSERT INTO messages (booking_id, direction, content, intent, client_phone)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `;

  try {
    const { rows } = await query(sql, [bookingId || null, direction, content, intent, clientPhone]);
    return rows[0];
  } catch (err) {
    throw handleDbError('logMessage', err);
  }
};

module.exports = {
  createBooking,
  findBookingByExternalId,
  getBookingById,
  getLatestBookingForClient,
  updateBookingStatus,
  updateBookingSchedule,
  logMessage,
};
