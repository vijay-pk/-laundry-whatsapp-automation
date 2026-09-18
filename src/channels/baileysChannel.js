/**
 * src/channels/baileysChannel.js
 * WhatsApp over QR login (linked device, Baileys) instead of the Meta Cloud API.
 * Enabled with WHATSAPP_CHANNEL=baileys. Unofficial: WhatsApp may ban the number.
 *
 *   - Session (creds + keys) lives in Postgres (whatsapp_auth), so deploys keep the login.
 *   - Only ONE socket per account may run: a Postgres advisory lock picks the instance
 *     (during a Render deploy the new instance waits until the old one has stopped).
 *   - Inbound messages are converted to Cloud-style messages and go through the normal
 *     webhook pipeline (idempotency, per-customer lock, flows).
 *   - Outbound Cloud payloads become text; buttons/lists become numbered options.
 */

const { Client } = require('pg');
const pino = require('pino');

const { pgConnectionConfig } = require('../config/pgConfig');
const { isQrChannel } = require('../config/channel');
const { usePostgresAuthState } = require('./baileysAuthState');
const { toOutbound, toCloudMessage, choiceMessage, createMenuMemory } = require('./baileysFormat');

// ---------------------------------------------------------------------------
// 1. State
// ---------------------------------------------------------------------------
const LOCK_KEY = 'whatsapp:baileys';
const LOCK_RETRY_MS = 15000;
const MAX_BACKOFF_MS = 60000;
const MAX_MESSAGE_AGE_S = 24 * 60 * 60; // don't answer messages older than a day (after long downtime)

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'error' });
const menus = createMenuMemory();

const state = { status: 'stopped', qr: null, me: null, lastError: null, since: null };
let baileys = null;     // the ESM module, imported once
let sock = null;
let auth = null;
let lockClient = null;
let onMessages = null;  // (items) => Promise, set by start()
let backoffMs = 2000;
let reconnectTimer = null;
let stopping = false;
let inbound = Promise.resolve(); // processes batches in arrival order

const setStatus = (status, extra = {}) => {
  Object.assign(state, { status, since: new Date().toISOString(), ...extra });
  console.log(`[baileys] ${status}${extra.lastError ? `: ${extra.lastError}` : ''}`);
};

const createError = (message, status) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------------------
// 2. Single-instance lock
// ---------------------------------------------------------------------------
const acquireLock = async () => {
  while (!stopping) {
    const client = new Client(pgConnectionConfig(process.env.DATABASE_URL));
    try {
      await client.connect();
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY]);
      if (rows[0].ok) {
        // Losing the connection loses the lock: stop the socket, then compete again.
        client.on('error', (err) => lockLost(err));
        client.on('end', () => lockLost(new Error('lock connection ended')));
        lockClient = client;
        return true;
      }
      await client.end();
    } catch (err) {
      await client.end().catch(() => {});
      console.error(`[baileys] Lock check failed: ${err.message}`);
    }
    setStatus('waiting_for_other_instance');
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS).unref());
  }
  return false;
};

const lockLost = (err) => {
  if (stopping || !lockClient) return;
  lockClient = null;
  console.error(`[baileys] Lost instance lock (${err.message}); reconnecting`);
  closeSocket();
  scheduleReconnect(true);
};

// ---------------------------------------------------------------------------
// 3. Socket lifecycle
// ---------------------------------------------------------------------------
const closeSocket = () => {
  if (!sock) return;
  sock.ev.removeAllListeners();
  try {
    sock.end(undefined);
  } catch {
    // already closed
  }
  sock = null;
};

const scheduleReconnect = (needsLock = false) => {
  if (stopping || reconnectTimer) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect({ needsLock }).catch((err) => {
      setStatus('error', { lastError: err.message });
      scheduleReconnect(needsLock);
    });
  }, delay);
  reconnectTimer.unref();
};

const handleConnectionUpdate = async ({ connection, lastDisconnect, qr }) => {
  if (qr) setStatus('qr', { qr });

  if (connection === 'open') {
    backoffMs = 2000;
    setStatus('open', { qr: null, lastError: null, me: sock?.user?.id?.split(':')[0] || null });
    return;
  }

  if (connection !== 'close') return;
  const code = lastDisconnect?.error?.output?.statusCode;
  const { DisconnectReason } = baileys;
  closeSocket();

  if (code === DisconnectReason.loggedOut) {
    // Unlinked from the phone (or banned): forget the session and show a fresh QR.
    await auth?.clear().catch((err) => console.error(`[baileys] Could not clear session: ${err.message}`));
    setStatus('logged_out', { qr: null, me: null, lastError: 'Logged out from the phone. Scan a new QR code.' });
    backoffMs = 2000;
    scheduleReconnect();
    return;
  }
  if (code === DisconnectReason.connectionReplaced) {
    // Another socket took over this account; don't fight it (reconnect from /admin/whatsapp).
    setStatus('replaced', { lastError: 'Another session opened this WhatsApp account.' });
    return;
  }
  if (code === DisconnectReason.restartRequired) backoffMs = 500; // normal right after scanning the QR

  setStatus('reconnecting', { lastError: lastDisconnect?.error?.message || `closed (${code})` });
  scheduleReconnect();
};

const handleUpsert = ({ messages, type }) => {
  if (type !== 'notify') return; // history sync / own devices
  const nowS = Math.floor(Date.now() / 1000);
  const items = messages
    .filter((m) => !m.messageTimestamp || nowS - Number(m.messageTimestamp) <= MAX_MESSAGE_AGE_S)
    .map(toCloudMessage)
    .filter(Boolean)
    .map((item) => {
      if (item.message.type !== 'text') return item;
      const option = menus.resolve(item.message.from, item.message.text.body);
      return option ? { ...item, message: choiceMessage(item.message, option) } : item;
    });
  if (!items.length) return;

  inbound = inbound
    .then(() => onMessages(items))
    .catch((err) => console.error(`[baileys] Inbound processing failed: ${err.message}`));
};

const connect = async ({ needsLock = true } = {}) => {
  if (stopping) return;
  if (needsLock || !lockClient) {
    setStatus('waiting_for_lock');
    if (!(await acquireLock())) return;
  }

  setStatus('connecting');
  auth = await usePostgresAuthState(baileys);
  const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
  const { version } = await baileys.fetchLatestBaileysVersion().catch(() => ({}));

  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.state.creds, keys: baileys.makeCacheableSignalKeyStore(auth.state.keys, logger) },
    logger,
    browser: baileys.Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', () => auth.saveCreds().catch((err) => console.error(`[baileys] Saving session failed: ${err.message}`)));
  sock.ev.on('connection.update', (update) => handleConnectionUpdate(update).catch((err) => console.error(`[baileys] ${err.message}`)));
  sock.ev.on('messages.upsert', handleUpsert);
};

// ---------------------------------------------------------------------------
// 4. Public API
// ---------------------------------------------------------------------------

/** @returns {boolean} true when WHATSAPP_CHANNEL=baileys */
const isEnabled = isQrChannel;

/**
 * Start the linked-device connection (never throws; retries in the background).
 * @param {(items: Array<{message: object, profileName: string|null}>) => Promise<void>} handler
 */
const start = async (handler) => {
  onMessages = handler;
  stopping = false;
  try {
    baileys = await import('@whiskeysockets/baileys');
    await connect();
  } catch (err) {
    setStatus('error', { lastError: err.message });
    scheduleReconnect(!lockClient);
  }
};

/** Close the socket and release the instance lock (shutdown). */
const stop = async () => {
  stopping = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeSocket();
  const client = lockClient;
  lockClient = null;
  await client?.end().catch(() => {});
  setStatus('stopped');
};

/**
 * Send what the app would POST to Graph /messages.
 * @param {object} payload Cloud API message body ({ to, type, ... })
 * @returns {Promise<{messageId: string|null, waId: string, raw: null}>}
 */
const sendPayload = async (payload) => {
  if (!sock || state.status !== 'open') {
    throw createError('WhatsApp is not connected. Scan the QR code at /admin/whatsapp.', 503);
  }
  const { text, options } = toOutbound(payload);
  const jid = `${payload.to}@s.whatsapp.net`;

  // Look less like a bot: "typing…" for a moment before replying.
  await sock.sendPresenceUpdate('composing', jid).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, Math.min(400 + text.length * 8, 1800)));

  const sent = await sock.sendMessage(jid, { text });
  sock.sendPresenceUpdate('paused', jid).catch(() => {});
  menus.remember(payload.to, options);
  return { messageId: sent?.key?.id ?? null, waId: payload.to, raw: null };
};

/**
 * Link by phone number instead of QR: returns the 8-character code to type in
 * WhatsApp → Linked devices → Link with phone number.
 * @param {string} phone digits with country code
 */
const requestPairingCode = async (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!/^\d{8,15}$/.test(digits)) throw createError('Enter the WhatsApp number with country code, digits only', 400);
  if (!sock || state.status === 'open') throw createError('Pairing is only possible while waiting for a QR scan', 409);
  return sock.requestPairingCode(digits);
};

/** Unlink this server from the WhatsApp account; a new QR code follows. */
const logout = async () => {
  if (sock && state.status === 'open') await sock.logout().catch(() => {});
  closeSocket();
  await auth?.clear();
  setStatus('logged_out', { qr: null, me: null, lastError: null });
  backoffMs = 1000;
  scheduleReconnect();
};

/** Reconnect after 'replaced' or an error. */
const reconnect = () => {
  closeSocket();
  backoffMs = 500;
  scheduleReconnect(!lockClient);
};

/** @returns {{ status: string, qr: string|null, me: string|null, lastError: string|null, since: string|null }} */
const getStatus = () => ({ ...state });

module.exports = { isEnabled, start, stop, sendPayload, requestPairingCode, logout, reconnect, getStatus };
