/**
 * src/utils/formatDate.js
 * Human-readable dates in the business timezone (TIMEZONE env, default UTC).
 */

const getTimeZone = () => process.env.TIMEZONE || 'UTC';

// "20 Sept 2026, 3:00 pm"
const formatDateTime = (date) => {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: getTimeZone(),
    }).format(date);
  } catch {
    return date.toISOString(); // invalid TIMEZONE value
  }
};

module.exports = { getTimeZone, formatDateTime };
