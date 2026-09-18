/**
 * src/controllers/whatsappAdminController.js
 * /admin/whatsapp: link, check and unlink the QR-login WhatsApp connection.
 * Business admins only (linking a device gives control of the business WhatsApp).
 */

const QRCode = require('qrcode');

const channel = require('../channels/baileysChannel');
const { isQrChannel } = require('../config/channel');
const { renderWhatsApp } = require('../views/whatsappPage');
const { esc, newNonce, setPageHeaders } = require('../views/html');

const flash = (kind, text) => `<div class="notice ${kind}">${esc(text)}</div>`;

const show = async (req, res, next, { status = 200, pairingCode = null, message = '' } = {}) => {
  if (!isQrChannel()) return res.status(404).send('QR login is off (set WHATSAPP_CHANNEL=baileys).');
  const nonce = newNonce();
  try {
    const current = channel.getStatus();
    const qrDataUrl = current.status === 'qr' && current.qr ? await QRCode.toDataURL(current.qr, { margin: 1, width: 280 }) : null;
    setPageHeaders(res, nonce);
    return res.status(status).send(renderWhatsApp({
      nonce, admin: req.admin, csrf: req.admin.csrf_token, status: current, qrDataUrl, pairingCode, flash: message,
    }));
  } catch (err) {
    return next(err);
  }
};

const showWhatsApp = (req, res, next) => show(req, res, next);

const pair = async (req, res, next) => {
  if (!isQrChannel()) return show(req, res, next);
  try {
    const code = await channel.requestPairingCode(req.body?.phone);
    console.log(`[admin] WhatsApp pairing code requested by ${req.admin.id}`);
    return show(req, res, next, { pairingCode: code });
  } catch (err) {
    const message = err.status ? err.message : 'Could not get a pairing code. Try again.';
    return show(req, res, next, { status: err.status || 500, message: flash('bad', message) });
  }
};

const logout = async (req, res, next) => {
  if (!isQrChannel()) return show(req, res, next);
  try {
    await channel.logout();
    console.log(`[admin] WhatsApp unlinked by ${req.admin.id}`);
    return show(req, res, next, { message: flash('ok', 'Number unlinked. Scan the new QR code to link again.') });
  } catch (err) {
    return next(err);
  }
};

const reconnect = (req, res, next) => {
  if (!isQrChannel()) return show(req, res, next);
  channel.reconnect();
  return show(req, res, next, { message: flash('ok', 'Reconnecting…') });
};

module.exports = { showWhatsApp, pair, logout, reconnect };
