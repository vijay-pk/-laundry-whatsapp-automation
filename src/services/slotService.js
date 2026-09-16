/**
 * src/services/slotService.js
 * Pickup time slots offered in chat, computed in the business timezone.
 */

const { businessKnowledge } = require('../config/businessKnowledge');
const { getTimeZone } = require('../utils/formatDate');

const DAY_MS = 24 * 60 * 60 * 1000;

// WhatsApp list messages allow at most 10 rows.
const MAX_SLOTS = 10;

// ---------------------------------------------------------------------------
// Timezone helpers (no external libraries)
// ---------------------------------------------------------------------------

// "YYYY-MM-DD" of an instant in the given timezone.
const localDate = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// UTC offset like "+05:30" of the timezone at an instant.
const offsetAt = (date, timeZone) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // "GMT+05:30" or "GMT"
  return name.match(/GMT([+-]\d{2}:\d{2})/)?.[1] ?? '+00:00';
};

// Instant for a local date + "HH:MM" wall-clock time in the timezone.
const toInstant = (ymd, hhmm, timeZone) =>
  new Date(`${ymd}T${hhmm}:00${offsetAt(new Date(`${ymd}T12:00:00Z`), timeZone)}`);

const addDays = (ymd, days) => new Date(Date.parse(`${ymd}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// "10:00" -> "10 AM", "16:30" -> "4:30 PM"
const timeLabel = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return m ? `${hour}:${String(m).padStart(2, '0')} ${suffix}` : `${hour} ${suffix}`;
};

const dayLabel = (ymd, dayOffset) => {
  if (dayOffset === 0) return 'Today';
  if (dayOffset === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric' })
    .format(new Date(`${ymd}T12:00:00Z`)); // "Fri 19"
};

const longDate = (ymd) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(`${ymd}T12:00:00Z`)); // "Friday 19 September"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upcoming pickup slots, soonest first.
 * @returns {Array<{id, start, end, title, description}>}  start/end are ISO instants
 */
const listSlots = ({ now = new Date(), kb = businessKnowledge, timeZone = getTimeZone(), max = MAX_SLOTS } = {}) => {
  const today = localDate(now, timeZone);
  const earliest = now.getTime() + (kb.minLeadMinutes ?? 60) * 60 * 1000;
  const slots = [];

  for (let dayOffset = 0; dayOffset < (kb.slotDaysAhead ?? 3); dayOffset += 1) {
    const ymd = addDays(today, dayOffset);
    const weekday = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    if ((kb.closedWeekdays ?? []).includes(weekday)) continue;

    for (const window of kb.pickupSlots ?? []) {
      const start = toInstant(ymd, window.start, timeZone);
      if (start.getTime() < earliest) continue;

      slots.push({
        id: `slot_${ymd}_${window.start.replace(':', '')}`,
        start: start.toISOString(),
        end: toInstant(ymd, window.end, timeZone).toISOString(),
        title: `${dayLabel(ymd, dayOffset)}, ${timeLabel(window.start)}-${timeLabel(window.end)}`,
        description: longDate(ymd),
      });
      if (slots.length >= max) return slots;
    }
  }

  return slots;
};

// A slot id is only valid while it is still offered (not in the past, not closed).
const findSlot = (id, options) => listSlots(options).find((slot) => slot.id === id) || null;

module.exports = { listSlots, findSlot, timeLabel };
