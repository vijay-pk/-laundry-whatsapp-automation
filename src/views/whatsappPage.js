/**
 * src/views/whatsappPage.js
 * Admin page for the QR-login WhatsApp connection (WHATSAPP_CHANNEL=baileys).
 */

const { esc, page } = require('./html');
const { nav } = require('./adminPages');

const STATUS_TEXT = {
  open: ['ok', 'Connected'],
  qr: ['warn', 'Waiting for QR scan'],
  connecting: ['info', 'Connecting…'],
  reconnecting: ['warn', 'Reconnecting…'],
  waiting_for_lock: ['info', 'Starting…'],
  waiting_for_other_instance: ['warn', 'Waiting for the previous server instance to stop'],
  logged_out: ['bad', 'Logged out'],
  replaced: ['bad', 'Disconnected: WhatsApp was opened by another session'],
  error: ['bad', 'Error'],
  stopped: ['bad', 'Not running'],
};

/**
 * @param {{ nonce: string, admin: object, csrf: string, status: object, qrDataUrl: string|null,
 *           pairingCode?: string|null, flash?: string }} options
 */
const renderWhatsApp = ({ nonce, admin, csrf, status, qrDataUrl, pairingCode = null, flash = '' }) => {
  const [badge, label] = STATUS_TEXT[status.status] || ['', status.status];
  const hidden = `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
  // Refresh while waiting so a new QR (they rotate every ~20s) or the connection shows up.
  const refresh = status.status !== 'open' && !pairingCode ? '<meta http-equiv="refresh" content="15">' : '';

  const connected = `
  <div class="card">
    <p>WhatsApp number <b>+${esc(status.me || '')}</b> is linked. Customers' messages are answered automatically.</p>
    <form method="post" action="/admin/whatsapp/logout">${hidden}
      <button class="btn small secondary" type="submit">Unlink this number</button></form>
  </div>`;

  const linking = `
  <div class="card">
    <h2>Link your WhatsApp number</h2>
    <ol>
      <li>Open WhatsApp on the business phone.</li>
      <li>Settings → <b>Linked devices</b> → <b>Link a device</b>.</li>
      <li>Scan this code. It changes every ~20 seconds; this page refreshes by itself.</li>
    </ol>
    ${qrDataUrl ? `<p class="center"><img src="${esc(qrDataUrl)}" width="280" height="280" alt="WhatsApp QR code"></p>` : '<p class="muted">Waiting for a QR code…</p>'}
    ${pairingCode ? `<div class="notice ok center">Pairing code: <b>${esc(pairingCode)}</b><br>
      On the phone: Linked devices → Link a device → <b>Link with phone number instead</b> → enter this code.</div>` : ''}
    <form method="post" action="/admin/whatsapp/pair">${hidden}
      <label for="phone">No second screen? Link with a code instead</label>
      <input type="number" id="phone" name="phone" inputmode="numeric" placeholder="WhatsApp number with country code, e.g. 919876543210">
      <p><button class="btn small" type="submit">Get pairing code</button></p>
    </form>
  </div>`;

  const other = `
  <div class="card">
    ${status.lastError ? `<p class="muted">${esc(status.lastError)}</p>` : ''}
    <form method="post" action="/admin/whatsapp/reconnect">${hidden}
      <button class="btn small" type="submit">Reconnect</button></form>
  </div>`;

  let body = other;
  if (status.status === 'open') body = connected;
  else if (['qr', 'logged_out', 'connecting'].includes(status.status) || pairingCode) body = linking;

  return page({
    title: 'WhatsApp',
    nonce,
    head: refresh,
    nav: nav(admin, csrf),
    body: `
<main class="narrow">
  <h1>WhatsApp <span class="badge ${badge}">${esc(label)}</span></h1>
  ${flash}
  ${body}
  <div class="notice warn small">QR login is not the official WhatsApp Business API. WhatsApp can block numbers that send automated messages. Use a number you can afford to lose, answer only people who message you first, and never send bulk messages.</div>
</main>`,
  });
};

module.exports = { renderWhatsApp };
