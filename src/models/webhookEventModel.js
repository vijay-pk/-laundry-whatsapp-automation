/**
 * src/models/webhookEventModel.js
 * Idempotency for Meta webhook events.
 *
 * Meta can deliver the same message more than once (slow/lost 200s, retries for
 * up to 7 days). Each message has a unique id (wamid). Before processing, the
 * controller atomically "claims" the id; a duplicate delivery finds it already
 * claimed and is skipped. Works across multiple server instances.
 */

const { query } = require('../config/db');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
// A redelivered event is retried at most this many times in total.
const MAX_ATTEMPTS = 3;

// An event stuck in 'processing' this long (process crashed mid-way) can be reclaimed.
const STALE_PROCESSING_MINUTES = 10;

// Meta retries for up to 7 days; keep ids comfortably longer than that.
const DEFAULT_RETENTION_DAYS = 30;

const MAX_ERROR_LENGTH = 500;

// ---------------------------------------------------------------------------
// claimEvent
// Returns true if this caller should process the event:
//   - first time seen, or
//   - previously failed and attempts remain, or
//   - stuck in 'processing' longer than STALE_PROCESSING_MINUTES.
// Returns false for duplicates (done, or currently being processed).
// The INSERT ... ON CONFLICT row lock makes concurrent claims safe.
// ---------------------------------------------------------------------------
const claimEvent = async (waMessageId) => {
  const sql = `
    INSERT INTO webhook_events (wa_message_id, status, attempts)
    VALUES ($1, 'processing', 1)
    ON CONFLICT (wa_message_id) DO UPDATE
      SET status = 'processing',
          attempts = webhook_events.attempts + 1,
          updated_at = NOW()
      WHERE webhook_events.attempts < $2
        AND (
          webhook_events.status = 'failed'
          OR (
            webhook_events.status = 'processing'
            AND webhook_events.updated_at < NOW() - make_interval(mins => $3)
          )
        )
    RETURNING wa_message_id
  `;

  const { rowCount } = await query(sql, [waMessageId, MAX_ATTEMPTS, STALE_PROCESSING_MINUTES]);
  return rowCount === 1;
};

// ---------------------------------------------------------------------------
// markEventDone / markEventFailed
// ---------------------------------------------------------------------------
const markEventDone = async (waMessageId) => {
  await query(
    `UPDATE webhook_events
     SET status = 'done', last_error = NULL, updated_at = NOW()
     WHERE wa_message_id = $1`,
    [waMessageId]
  );
};

const markEventFailed = async (waMessageId, errorMessage) => {
  await query(
    `UPDATE webhook_events
     SET status = 'failed', last_error = $2, updated_at = NOW()
     WHERE wa_message_id = $1`,
    [waMessageId, String(errorMessage ?? '').slice(0, MAX_ERROR_LENGTH)]
  );
};

// ---------------------------------------------------------------------------
// purgeOldEvents
// Deletes event ids older than `days`. Returns number of rows removed.
// ---------------------------------------------------------------------------
const purgeOldEvents = async (days = DEFAULT_RETENTION_DAYS) => {
  const { rowCount } = await query(
    `DELETE FROM webhook_events WHERE created_at < NOW() - make_interval(days => $1)`,
    [days]
  );
  return rowCount;
};

module.exports = {
  claimEvent,
  markEventDone,
  markEventFailed,
  purgeOldEvents,
};
