/**
 * src/services/whatsappService.js
 * Outbound messaging via the Meta WhatsApp Cloud API (Graph API).
 */

require('dotenv').config({ quiet: true });
const axios = require('axios');

const baileysChannel = require('../channels/baileysChannel');

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------
const GRAPH_API_VERSION = 'v22.0';
// WHATSAPP_API_BASE_URL overrides the Graph API host (tests point it at a local mock).
const GRAPH_API_BASE = process.env.WHATSAPP_API_BASE_URL || `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 4096;

// Plain-language hints for common Graph API error codes.
const ERROR_HINTS = {
  190: 'Access token is invalid or expired. Generate a new GRAPH_API_TOKEN.',
  131026: 'Message undeliverable. Recipient may not have WhatsApp or has blocked the number.',
  131030: 'Recipient not in allowed list. Add the number in the Meta App Dashboard (test mode).',
  131047: 'Outside the 24-hour customer service window. Use a template message instead.',
  131056: 'Too many messages to this recipient. Slow down.',
  130429: 'Rate limit hit. Throughput exceeded for this phone number.',
  132000: 'Template variable count does not match the approved template.',
  132001: 'Template does not exist, is not approved, or language code is wrong.',
};

// ---------------------------------------------------------------------------
// 2. HTTP client (created lazily so importing this module never throws)
// ---------------------------------------------------------------------------
let client = null;

const getClient = () => {
  if (client) return client;

  const { GRAPH_API_TOKEN, PHONE_NUMBER_ID } = process.env;
  if (!GRAPH_API_TOKEN || !PHONE_NUMBER_ID) {
    throw createError('[whatsapp] GRAPH_API_TOKEN and PHONE_NUMBER_ID must be set', 500);
  }

  client = axios.create({
    baseURL: `${GRAPH_API_BASE}/${PHONE_NUMBER_ID}`,
    timeout: REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${GRAPH_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  return client;
};

// ---------------------------------------------------------------------------
// 3. Helpers
// ---------------------------------------------------------------------------
function createError(message, status = 500, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

// Meta expects digits only, with country code: "+91 98765-43210" -> "919876543210"
const normalizePhone = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) {
    throw createError('toPhone must be a valid international number with country code', 400);
  }
  return digits;
};

// Only log the last 4 digits. Phone numbers are customer PII.
const maskPhone = (phone) => `***${phone.slice(-4)}`;

// ---------------------------------------------------------------------------
// 4. Core sender: every outbound message goes through here
// ---------------------------------------------------------------------------
const sendMessage = async (payload, context) => {
  // QR login (WHATSAPP_CHANNEL=baileys): same payloads, sent as text over the linked device.
  if (baileysChannel.isEnabled()) {
    try {
      const result = await baileysChannel.sendPayload(payload);
      console.log(`[whatsapp] Sent ${context} to ${maskPhone(payload.to)} via QR login | messageId=${result.messageId}`);
      return result;
    } catch (err) {
      console.error(`[whatsapp] ${context} to ${maskPhone(payload.to)} failed via QR login: ${err.message}`);
      throw err.status ? err : createError(`WhatsApp send failed: ${err.message}`, 502);
    }
  }

  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...payload,
  };

  try {
    const { data } = await getClient().post('/messages', body);

    const result = {
      messageId: data?.messages?.[0]?.id ?? null,
      waId: data?.contacts?.[0]?.wa_id ?? null,
      raw: data,
    };

    console.log(`[whatsapp] Sent ${context} to ${maskPhone(payload.to)} | messageId=${result.messageId}`);
    return result;
  } catch (err) {
    // Case A: Graph API responded with an error
    if (err.response) {
      const apiError = err.response.data?.error ?? {};
      const hint = ERROR_HINTS[apiError.code] ?? 'See Meta error code reference.';

      console.error(
        `[whatsapp] ${context} to ${maskPhone(payload.to)} failed | ` +
          `http=${err.response.status} code=${apiError.code} subcode=${apiError.error_subcode} ` +
          `fbtrace_id=${apiError.fbtrace_id}\n  message: ${apiError.message}\n  hint: ${hint}`
      );

      throw createError(`WhatsApp API error: ${apiError.message ?? 'Unknown error'}`, err.response.status, {
        code: apiError.code,
        subcode: apiError.error_subcode,
        fbtraceId: apiError.fbtrace_id,
        hint,
      });
    }

    // Case B: Request sent, no response (timeout, DNS, network down)
    if (err.request) {
      console.error(`[whatsapp] ${context} to ${maskPhone(payload.to)} failed | no response: ${err.code || err.message}`);
      throw createError('WhatsApp API unreachable', 502, { code: err.code });
    }

    // Case C: Failed before sending (config error, bad request setup)
    console.error(`[whatsapp] ${context} failed before sending: ${err.message}`);
    throw err.status ? err : createError(err.message, 500);
  }
};

// ---------------------------------------------------------------------------
// 5. Public API
// ---------------------------------------------------------------------------

/**
 * Send a pre-approved template message. Works outside the 24-hour window.
 *
 * @param {string}   toPhone       Recipient number with country code
 * @param {string}   templateName  Approved template name, e.g. 'booking_cancelled'
 * @param {Array}    variables     Body variables in order, mapped to {{1}}, {{2}}, ...
 * @param {string}   languageCode  Template language, must match approval (default 'en_US')
 * @returns {Promise<{messageId: string, waId: string, raw: object}>}
 */
const sendTemplateMessage = async (toPhone, templateName, variables = [], languageCode = 'en_US') => {
  const to = normalizePhone(toPhone);

  if (typeof templateName !== 'string' || templateName.trim() === '') {
    throw createError('templateName is required', 400);
  }
  if (!Array.isArray(variables)) {
    throw createError('variables must be an array', 400);
  }

  // Meta rejects empty parameter values, so catch them before sending.
  const parameters = variables.map((value, index) => {
    const text = String(value ?? '').trim();
    if (text === '') {
      throw createError(`Template variable {{${index + 1}}} is empty`, 400);
    }
    return { type: 'text', text };
  });

  const template = {
    name: templateName.trim(),
    language: { code: languageCode },
  };

  // Templates with no variables (e.g. 'hello_world') must omit components.
  if (parameters.length > 0) {
    template.components = [{ type: 'body', parameters }];
  }

  return sendMessage({ to, type: 'template', template }, `template "${template.name}"`);
};

/**
 * Send a free-form text message.
 * NOTE: Only delivered within 24 hours of the recipient's last inbound message.
 * Outside that window Meta returns error 131047. Use sendTemplateMessage instead.
 *
 * @param {string} toPhone  Recipient number with country code
 * @param {string} text     Message body (max 4096 characters)
 * @returns {Promise<{messageId: string, waId: string, raw: object}>}
 */
const sendTextMessage = async (toPhone, text) => {
  const to = normalizePhone(toPhone);

  if (typeof text !== 'string' || text.trim() === '') {
    throw createError('text is required', 400);
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw createError(`text exceeds ${MAX_TEXT_LENGTH} characters`, 400);
  }

  return sendMessage(
    { to, type: 'text', text: { preview_url: false, body: text } },
    'text message'
  );
};

// WhatsApp interactive message limits
const LIMITS = { body: 1024, buttonTitle: 20, maxButtons: 3, listButton: 20, rowTitle: 24, rowDescription: 72, maxRows: 10, id: 200 };

const truncate = (text, max) => {
  const value = String(text ?? '').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const requireBody = (text) => {
  if (typeof text !== 'string' || text.trim() === '') throw createError('body text is required', 400);
  return truncate(text, LIMITS.body);
};

/**
 * Send up to 3 reply buttons. Customer taps arrive as interactive.button_reply { id, title }.
 * Only delivered within the 24-hour customer service window.
 *
 * @param {string} toPhone
 * @param {string} bodyText
 * @param {Array<{id: string, title: string}>} buttons  1-3 buttons, titles cut to 20 chars
 */
const sendButtonsMessage = async (toPhone, bodyText, buttons) => {
  const to = normalizePhone(toPhone);
  const body = requireBody(bodyText);

  if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > LIMITS.maxButtons) {
    throw createError(`buttons must be an array of 1-${LIMITS.maxButtons} items`, 400);
  }

  return sendMessage(
    {
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: truncate(b.id, LIMITS.id), title: truncate(b.title, LIMITS.buttonTitle) },
          })),
        },
      },
    },
    'buttons message'
  );
};

/**
 * Send a list (menu) of up to 10 rows. Customer picks arrive as interactive.list_reply { id, title }.
 * Only delivered within the 24-hour customer service window.
 *
 * @param {string} toPhone
 * @param {string} bodyText
 * @param {string} buttonText  label of the button that opens the list (max 20 chars)
 * @param {Array<{id: string, title: string, description?: string}>} rows
 * @param {string} [sectionTitle]
 */
const sendListMessage = async (toPhone, bodyText, buttonText, rows, sectionTitle = 'Options') => {
  const to = normalizePhone(toPhone);
  const body = requireBody(bodyText);

  if (!Array.isArray(rows) || rows.length === 0 || rows.length > LIMITS.maxRows) {
    throw createError(`rows must be an array of 1-${LIMITS.maxRows} items`, 400);
  }

  return sendMessage(
    {
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: body },
        action: {
          button: truncate(buttonText, LIMITS.listButton),
          sections: [
            {
              title: truncate(sectionTitle, LIMITS.rowTitle),
              rows: rows.map((r) => ({
                id: truncate(r.id, LIMITS.id),
                title: truncate(r.title, LIMITS.rowTitle),
                ...(r.description ? { description: truncate(r.description, LIMITS.rowDescription) } : {}),
              })),
            },
          ],
        },
      },
    },
    'list message'
  );
};

/**
 * Text asking the customer to share their location with WhatsApp's native
 * Location attachment (used for the pickup service-area check).
 * @param {number} [radiusKm] service radius shown to the customer
 */
const locationRequestText = (radiusKm = Number(process.env.MAX_DELIVERY_RADIUS_KM) || 5) =>
  `Please share your pickup location so we can check if you are within our ${radiusKm}km service area. ` +
  'Click the 📎 attachment icon -> Location -> Send your current location.';

/**
 * Ask the customer to share their pickup location.
 * Only delivered within the 24-hour customer service window.
 * @param {string} toPhone
 */
const sendLocationRequest = (toPhone) => sendTextMessage(toPhone, locationRequestText());

// ---------------------------------------------------------------------------
// WhatsApp Pay (India): order_details message + payment lookup
// ---------------------------------------------------------------------------

/**
 * Send an order_details message with a "Review and pay" button (WhatsApp Pay).
 * Amounts are integer paise (offset 100). Only within the 24-hour window.
 *
 * @param {string} toPhone
 * @param {{ referenceId: string, configuration: string, gateway: string, bodyText: string, footerText?: string,
 *           totalPaise: number, items: Array<{retailerId: string, name: string, amountPaise: number, quantity: number}>,
 *           expiresAt?: Date, notes?: object, receipt?: string }} order
 */
const sendOrderDetailsMessage = async (toPhone, order) => {
  const to = normalizePhone(toPhone);
  const body = requireBody(order.bodyText);
  const money = (value) => ({ value: Math.round(value), offset: 100 });

  const gatewayDetails = {
    type: order.gateway,
    configuration_name: order.configuration,
    ...(order.gateway === 'razorpay' ? { razorpay: { receipt: String(order.receipt || order.referenceId).slice(0, 40), notes: order.notes || {} } } : {}),
  };

  const subtotal = order.items.reduce((sum, item) => sum + item.amountPaise * item.quantity, 0);

  return sendMessage(
    {
      to,
      type: 'interactive',
      interactive: {
        type: 'order_details',
        body: { text: body },
        ...(order.footerText ? { footer: { text: truncate(order.footerText, 60) } } : {}),
        action: {
          name: 'review_and_pay',
          parameters: {
            reference_id: order.referenceId,
            type: 'digital-goods',
            payment_settings: [{ type: 'payment_gateway', payment_gateway: gatewayDetails }],
            currency: 'INR',
            total_amount: money(order.totalPaise),
            order: {
              status: 'pending',
              ...(order.expiresAt
                ? { expiration: { timestamp: String(Math.floor(order.expiresAt.getTime() / 1000)), description: 'This payment request has expired.' } }
                : {}),
              items: order.items.map((item) => ({
                retailer_id: item.retailerId,
                name: truncate(item.name, 60),
                amount: money(item.amountPaise),
                quantity: item.quantity,
              })),
              subtotal: money(subtotal),
            },
          },
        },
      },
    },
    'WhatsApp Pay order'
  );
};

/**
 * Look up a WhatsApp Pay payment by reference id (reconcile missed webhooks).
 * GET /<PHONE_NUMBER_ID>/payments/<configuration>/<reference_id>
 * @returns {Promise<Array<object>>} payments array (status 'pending' | 'captured', transactions[])
 */
const lookupWhatsAppPayment = async (configuration, referenceId) => {
  try {
    const { data } = await getClient().get(`/payments/${encodeURIComponent(configuration)}/${encodeURIComponent(referenceId)}`);
    return data?.payments || [];
  } catch (err) {
    const status = err.response?.status;
    console.error(`[whatsapp] Payment lookup failed for ${referenceId}: http=${status ?? 'none'} ${err.response?.data?.error?.message || err.message}`);
    throw createError('WhatsApp payment lookup failed', status && status < 500 ? 502 : 503);
  }
};

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
  sendOrderDetailsMessage,
  lookupWhatsAppPayment,
  sendLocationRequest,
  locationRequestText,
  sendButtonsMessage,
  sendListMessage,
};
