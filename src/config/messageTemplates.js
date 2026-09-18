/**
 * src/config/messageTemplates.js
 * Plain-text versions of the Meta message templates, used when WhatsApp runs over
 * QR login (WHATSAPP_CHANNEL=baileys), which has no templates.
 * Keep the wording in sync with the templates approved in WhatsApp Manager.
 * {{1}}, {{2}}, ... are the template variables in order.
 */

const TEMPLATE_TEXTS = {
  booking_cancelled: 'Hi {{1}}, your {{2}} booking has been cancelled. Send *book* any time to schedule a new pickup.',
  laundry_booking_alert: '🧺 New booking\nCustomer: {{1}}\nService: {{2}}\nPickup: {{3}}',
};

// Status updates use TEMPLATE_ORDER_STATUS, whose name is chosen per business.
const ORDER_STATUS_TEXT = 'Hi {{1}}, {{2}}';

const patternFor = (name) => {
  if (TEMPLATE_TEXTS[name]) return TEMPLATE_TEXTS[name];
  if (name === process.env.TEMPLATE_ORDER_STATUS) return ORDER_STATUS_TEXT;
  if (name === process.env.TEMPLATE_BOOKING_CANCELLED) return TEMPLATE_TEXTS.booking_cancelled;
  return null;
};

/**
 * @param {string} name template name
 * @param {string[]} variables
 * @returns {string} text to send instead of the template (unknown template: variables, one per line)
 */
const templateText = (name, variables = []) => {
  const pattern = patternFor(name);
  if (!pattern) return variables.join('\n');
  return pattern.replace(/\{\{(\d+)\}\}/g, (_, n) => variables[Number(n) - 1] ?? '');
};

module.exports = { TEMPLATE_TEXTS, templateText };
