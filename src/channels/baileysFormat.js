/**
 * src/channels/baileysFormat.js
 * Pure conversions between the app's WhatsApp Cloud API shapes and Baileys (QR login):
 *   - outbound Cloud payloads -> plain text (buttons/lists become numbered options)
 *   - inbound Baileys messages -> Cloud-style webhook messages, so the rest of the app is unchanged
 *   - menu memory: a typed "2" or option title after a numbered menu becomes that option's tap
 */

const { templateText } = require('../config/messageTemplates');

// ---------------------------------------------------------------------------
// 1. Outbound: Cloud API payload -> text
// ---------------------------------------------------------------------------

const numbered = (options) => options.map((o, i) => `*${i + 1}.* ${o.title}${o.description ? ` — ${o.description}` : ''}`);

const unsupported = (what) => {
  const err = new Error(`${what} is not available with WhatsApp QR login (WHATSAPP_CHANNEL=baileys)`);
  err.status = 501;
  return err;
};

/**
 * @param {object} payload body the app would POST to Graph /messages
 * @returns {{ text: string, options: Array<{id: string, title: string}>|null }}
 *   options = choices shown as numbers (null = plain message, forgets the previous menu)
 */
const toOutbound = (payload) => {
  switch (payload.type) {
    case 'text':
      return { text: payload.text.body, options: null };

    case 'template': {
      const params = (payload.template.components || [])
        .flatMap((c) => c.parameters || [])
        .map((p) => p.text);
      return { text: templateText(payload.template.name, params), options: null };
    }

    case 'interactive': {
      const { interactive } = payload;
      if (interactive.type === 'button') {
        const options = interactive.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }));
        return { text: [interactive.body.text, '', ...numbered(options), '', '_Reply with a number._'].join('\n'), options };
      }
      if (interactive.type === 'list') {
        const rows = interactive.action.sections.flatMap((s) => s.rows);
        const options = rows.map((r) => ({ id: r.id, title: r.title }));
        return { text: [interactive.body.text, '', ...numbered(rows), '', '_Reply with a number._'].join('\n'), options };
      }
      throw unsupported(`Interactive "${interactive.type}" message`);
    }

    default:
      throw unsupported(`"${payload.type}" message`);
  }
};

// ---------------------------------------------------------------------------
// 2. Inbound: Baileys message -> Cloud-style webhook message
// ---------------------------------------------------------------------------

/** '919876543210:12@s.whatsapp.net' -> '919876543210'; groups, LIDs, broadcasts -> null */
const phoneFromJid = (jid) => {
  const match = /^(\d{8,15})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/.exec(String(jid || ''));
  return match ? match[1] : null;
};

// Newer WhatsApp clients address chats by LID (…@lid); the phone JID is then in remoteJidAlt.
const senderPhone = (key = {}) =>
  [key.remoteJid, key.remoteJidAlt, key.senderPn].map(phoneFromJid).find(Boolean) || null;

// Disappearing / view-once / captioned-document wrappers hold the real message inside.
// (Edits arrive as protocol messages and are ignored: the original was already answered.)
const unwrap = (content) => {
  let msg = content;
  for (let i = 0; i < 5 && msg; i += 1) {
    const inner =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg.viewOnceMessageV2Extension?.message ||
      msg.documentWithCaptionMessage?.message;
    if (!inner) break;
    msg = inner;
  }
  return msg || {};
};

// Message kinds the app answers with "text only" (never silently dropped).
const MEDIA_KINDS = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  contactMessage: 'contacts',
  contactsArrayMessage: 'contacts',
};

/**
 * @param {object} waMessage Baileys WAMessage from messages.upsert
 * @returns {{ message: object, profileName: string|null } | null} null = ignore (own, group, status, reaction, protocol…)
 */
const toCloudMessage = (waMessage) => {
  const key = waMessage?.key;
  if (!key?.id || key.fromMe) return null;
  const from = senderPhone(key);
  if (!from) return null; // groups, broadcasts, status updates, unresolvable LIDs

  const content = unwrap(waMessage.message);
  const base = { id: `bl_${key.id}`, from, timestamp: String(waMessage.messageTimestamp ?? '') };
  const profileName = typeof waMessage.pushName === 'string' ? waMessage.pushName.trim().slice(0, 60) || null : null;

  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof text === 'string') return { message: { ...base, type: 'text', text: { body: text } }, profileName };

  const loc = content.locationMessage || content.liveLocationMessage;
  if (loc) {
    const location = { latitude: loc.degreesLatitude, longitude: loc.degreesLongitude, name: loc.name || undefined, address: loc.address || undefined };
    return { message: { ...base, type: 'location', location }, profileName };
  }

  const kind = Object.keys(MEDIA_KINDS).find((k) => content[k]);
  if (kind) return { message: { ...base, type: MEDIA_KINDS[kind] }, profileName };

  return null; // reactions, receipts, protocol and history messages
};

/** A remembered option as the Cloud API would deliver a list tap. */
const choiceMessage = (message, option) => ({
  id: message.id,
  from: message.from,
  timestamp: message.timestamp,
  type: 'interactive',
  interactive: { type: 'list_reply', list_reply: { id: option.id, title: option.title } },
});

// ---------------------------------------------------------------------------
// 3. Menu memory: the options of the last message sent to each customer
// ---------------------------------------------------------------------------

/**
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
const createMenuMemory = ({ ttlMs = 24 * 60 * 60 * 1000, maxEntries = 5000, now = Date.now } = {}) => {
  const menus = new Map(); // phone -> { options, at }

  return {
    /** Any plain message clears the menu, so a later "5" (e.g. a quantity) stays text. */
    remember(phone, options) {
      menus.delete(phone);
      if (!options?.length) return;
      menus.set(phone, { options, at: now() });
      if (menus.size > maxEntries) menus.delete(menus.keys().next().value);
    },

    /** @returns {{id: string, title: string}|null} option picked by number or exact title */
    resolve(phone, text) {
      const entry = menus.get(phone);
      if (!entry || now() - entry.at > ttlMs) return null;
      const typed = String(text || '').trim().replace(/[.)]$/, '').toLowerCase();
      if (/^\d{1,2}$/.test(typed)) return entry.options[Number(typed) - 1] || null;
      return entry.options.find((o) => o.title.trim().toLowerCase() === typed) || null;
    },
  };
};

module.exports = { toOutbound, toCloudMessage, choiceMessage, phoneFromJid, senderPhone, createMenuMemory };
