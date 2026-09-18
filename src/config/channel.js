/**
 * src/config/channel.js
 * Which WhatsApp connection the app uses (WHATSAPP_CHANNEL):
 *   cloud   (default) Meta WhatsApp Cloud API: templates, buttons, lists, WhatsApp Pay
 *   baileys           QR login as a linked device: text only, no Meta account (unofficial, ban risk)
 */

/** @returns {boolean} true when WhatsApp runs over QR login */
const isQrChannel = () => String(process.env.WHATSAPP_CHANNEL || '').trim().toLowerCase() === 'baileys';

module.exports = { isQrChannel };
