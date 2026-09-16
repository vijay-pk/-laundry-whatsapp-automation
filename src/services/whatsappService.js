/**
 * src/services/whatsappService.js
 * Outbound messaging via the Meta WhatsApp Cloud API (Graph API).
 */

require('dotenv').config({ quiet: true });
const axios = require('axios');

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

module.exports = {
  sendTemplateMessage,
  sendTextMessage,
};
