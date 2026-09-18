/**
 * src/views/adminPages.js
 * Admin dashboard pages: login, bookings (booking status vs payment status), payment settings, AI answers.
 */

const { esc, page } = require('./html');
const { formatINR, calculatePaymentTerms } = require('../utils/money');
const { formatDateTime } = require('../utils/formatDate');
const { PAYMENT_STATUS_LABELS } = require('../services/paymentService');
const { isQrChannel } = require('../config/channel');

const PAYMENT_BADGE = { paid: 'ok', partially_paid: 'info', pending: 'warn', failed: 'bad', refunded: 'info', not_required: '' };
const BOOKING_BADGE = { Confirmed: 'info', Delivered: 'ok', Cancelled: 'bad', Pending: 'warn' };
const PREVIEW_TOTAL = 500;

const money = (value) => (value === null || value === undefined ? '-' : esc(formatINR(value)));

const nav = (admin, csrf) => `
<nav><div class="inner">
  <b>Laundry Admin</b>
  <a href="/admin/bookings">Bookings</a>
  <a href="/admin/payment-settings">Payment Settings</a>
  <a href="/admin/ai-answers">AI Answers</a>
  ${isQrChannel() && admin.role === 'admin' ? '<a href="/admin/whatsapp">WhatsApp</a>' : ''}
  <span class="spacer"></span>
  <span class="small">${esc(admin.email)}${admin.role === 'super_admin' ? ' (super admin)' : ` · ${esc(admin.business_name || '')}`}</span>
  <form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button class="btn small secondary" type="submit">Log out</button></form>
</div></nav>`;

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
const renderLogin = ({ nonce, error = '' }) =>
  page({
    title: 'Admin login',
    nonce,
    body: `
<main class="narrow">
  <div class="card">
    <h1>Admin login</h1>
    ${error ? `<div class="notice bad">${esc(error)}</div>` : ''}
    <form method="post" action="/admin/login" autocomplete="on">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocomplete="username">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <p></p>
      <button class="btn" type="submit">Log in</button>
    </form>
  </div>
</main>`,
  });

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------
const paymentModeLabel = (b) => {
  if (!b.payment_method) return 'No payment';
  if (b.payment_method === 'cod') return 'Cash on delivery';
  const via = b.payment_method === 'whatsapp_pay' ? 'WhatsApp Pay' : 'Razorpay';
  const t = b.payment_terms || {};
  if (b.payment_mode === 'advance') {
    return `${via} advance (${t.advanceType === 'percentage' ? `${Number(t.advanceValue)}%` : formatINR(t.advanceValue)})`;
  }
  return `${via} full`;
};

const canRecordCash = (b) =>
  b.total_amount !== null &&
  Number(b.amount_remaining) > 0 &&
  b.status !== 'Cancelled' &&
  (b.payment_status === 'partially_paid' || (b.payment_method === 'cod' && b.payment_status === 'pending'));

const renderBookings = ({ nonce, admin, csrf, bookings, flash = '' }) => {
  const superAdmin = admin.role === 'super_admin';
  const rows = bookings.map((b) => `
    <tr>
      <td data-label="Booking"><b>#${esc(b.id.slice(0, 8).toUpperCase())}</b><br><span class="muted small">${esc(formatDateTime(new Date(b.created_at)))}</span></td>
      ${superAdmin ? `<td data-label="Business">${esc(b.business_name)}</td>` : ''}
      <td data-label="Customer">${esc(b.client_name || '-')}<br><span class="muted small">+${esc(b.client_phone)}</span></td>
      <td data-label="Services">${esc(b.service_type || '-')}${b.quantity ? `<br><span class="muted small">${esc(Number(b.quantity))} ${b.unit === 'kg' ? 'kg' : 'pcs'}</span>` : ''}</td>
      <td data-label="Booking status"><span class="badge ${BOOKING_BADGE[b.status] || 'info'}">${esc(b.status)}</span></td>
      <td data-label="Payment status"><span class="badge ${PAYMENT_BADGE[b.payment_status] ?? ''}">${esc(PAYMENT_STATUS_LABELS[b.payment_status] || b.payment_status)}</span>${b.refund_required ? '<br><span class="badge bad">Refund needed</span>' : ''}</td>
      <td data-label="Payment mode">${esc(paymentModeLabel(b))}</td>
      <td data-label="Total">${money(b.total_amount)}</td>
      <td data-label="Paid">${b.total_amount === null ? '-' : money(b.amount_paid)}</td>
      <td data-label="Remaining">${money(b.amount_remaining)}</td>
      <td data-label="Order / reference"><code>${esc(b.razorpay_order_id || b.wa_reference_id || '-')}</code></td>
      <td data-label="Payment ID"><code>${esc(b.razorpay_payment_id || b.pg_transaction_id || '-')}</code></td>
      <td data-label="Action">${!superAdmin && canRecordCash(b) ? `
        <form method="post" action="/admin/bookings/${esc(b.id)}/cash" class="cash-form">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn small secondary" type="submit" data-amount="${esc(formatINR(b.amount_remaining))}">Cash received ${esc(formatINR(b.amount_remaining))}</button>
        </form>` : ''}</td>
    </tr>`).join('');

  return page({
    title: 'Bookings',
    nonce,
    nav: nav(admin, csrf),
    body: `
<main>
  <h1>Bookings</h1>
  ${flash}
  <p class="muted small"><b>Booking status</b> tracks the laundry order. <b>Payment status</b> tracks money and changes only through verified Razorpay / WhatsApp Pay payments or recorded cash.</p>
  <div class="card">
    ${bookings.length === 0 ? '<p class="muted">No bookings yet.</p>' : `
    <table>
      <thead><tr>
        <th>Booking</th>${superAdmin ? '<th>Business</th>' : ''}<th>Customer</th><th>Services</th>
        <th>Booking status</th><th>Payment status</th><th>Payment mode</th>
        <th>Total</th><th>Paid</th><th>Remaining</th><th>Order / reference</th><th>Payment ID</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`}
  </div>
</main>
<script nonce="${nonce}">
document.querySelectorAll('.cash-form').forEach(function (form) {
  form.addEventListener('submit', function (e) {
    var amount = form.querySelector('button').getAttribute('data-amount');
    if (!confirm('Record ' + amount + ' cash received for this booking? This cannot be undone.')) e.preventDefault();
  });
});
</script>`,
  });
};

// ---------------------------------------------------------------------------
// Payment settings
// ---------------------------------------------------------------------------
const previewText = (s) => {
  if (!s.paymentEnabled) return 'No payment will be collected during booking.';
  try {
    const t = calculatePaymentTerms(PREVIEW_TOTAL, { mode: s.paymentMode, advanceType: s.advanceType, advanceValue: s.advanceValue });
    const online = `${s.onlineProvider === 'whatsapp_pay' ? 'WhatsApp Pay. ' : 'Razorpay link. '}${formatINR(PREVIEW_TOTAL)} booking → Customer pays ${formatINR(t.dueNow)} now → ${formatINR(t.remaining)} remaining`;
    return s.allowCashOnDelivery ? `${online} (or ${formatINR(PREVIEW_TOTAL)} cash on delivery)` : online;
  } catch {
    return 'Enter a valid advance amount to see the preview.';
  }
};

const renderSettings = ({ nonce, admin, csrf, settings, razorpayConfigured, flash = '' }) => {
  const s = settings;
  const checked = (on) => (on ? 'checked' : '');
  return page({
    title: 'Payment Settings',
    nonce,
    nav: nav(admin, csrf),
    body: `
<main class="narrow">
  <h1>Payment Settings</h1>
  ${flash}
  ${razorpayConfigured || s.onlineProvider === 'whatsapp_pay' ? '' : '<div class="notice warn">Razorpay keys are not configured on the server, so the Razorpay link is unavailable. Choose WhatsApp Pay or enable Cash on delivery.</div>'}
  <form method="post" action="/admin/payment-settings" class="card" id="settings">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">

    <label class="choice"><input type="checkbox" name="paymentEnabled" value="on" ${checked(s.paymentEnabled)}> Enable payment during booking</label>

    <fieldset id="options">
      <label>Payment mode</label>
      <label class="choice"><input type="radio" name="paymentMode" value="full" ${checked(s.paymentMode !== 'advance')}> Full payment</label>
      <label class="choice"><input type="radio" name="paymentMode" value="advance" ${checked(s.paymentMode === 'advance')}> Advance payment</label>

      <div id="advance">
        <label>Advance type</label>
        <label class="choice"><input type="radio" name="advanceType" value="percentage" ${checked(s.advanceType !== 'fixed')}> Percentage</label>
        <label class="choice"><input type="radio" name="advanceType" value="fixed" ${checked(s.advanceType === 'fixed')}> Fixed amount (₹)</label>
        <label for="advanceValue">Advance amount</label>
        <input id="advanceValue" name="advanceValue" type="number" min="0.01" step="0.01" value="${esc(s.advanceValue ?? '')}" placeholder="e.g. 30 or 100">
      </div>

      <label>Online payment method</label>
      <label class="choice"><input type="radio" name="onlineProvider" value="whatsapp_pay" ${checked(s.onlineProvider === 'whatsapp_pay')}> WhatsApp Pay (customer pays inside WhatsApp)</label>
      <label class="choice"><input type="radio" name="onlineProvider" value="razorpay_link" ${checked(s.onlineProvider !== 'whatsapp_pay')}> Razorpay payment link (opens a secure web page)</label>

      <div id="whatsapp-pay">
        <label for="whatsappPayConfiguration">WhatsApp Pay configuration name</label>
        <input id="whatsappPayConfiguration" name="whatsappPayConfiguration" type="text" maxlength="60" value="${esc(s.whatsappPayConfiguration ?? '')}" placeholder="Exactly as in WhatsApp Manager → Payment configurations">
        <label for="whatsappPayGateway">Payment gateway linked to it</label>
        <select id="whatsappPayGateway" name="whatsappPayGateway">
          ${['razorpay', 'payu', 'billdesk', 'zaakpay'].map((g) => `<option value="${g}" ${s.whatsappPayGateway === g ? 'selected' : ''}>${{ razorpay: 'Razorpay', payu: 'PayU', billdesk: 'BillDesk', zaakpay: 'Zaakpay' }[g]}</option>`).join('')}
        </select>
        <p class="muted small">WhatsApp Pay works only in India, on a verified business number with a payment configuration set up in WhatsApp Manager.</p>
      </div>

      <label class="choice"><input type="checkbox" name="allowCashOnDelivery" value="on" ${checked(s.allowCashOnDelivery)}> Also allow cash on delivery</label>
    </fieldset>

    <div class="card">
      <b>Preview</b>
      <div class="row"><span class="muted">Payment enabled</span><b id="pv-enabled">${s.paymentEnabled ? 'ON' : 'OFF'}</b></div>
      <p id="pv-text">${esc(previewText(s))}</p>
    </div>

    <button class="btn" type="submit">Save settings</button>
  </form>
  <p class="muted small">Changes apply to new bookings only. Existing bookings keep the payment terms they were created with.</p>
</main>
<script nonce="${nonce}">
(function () {
  var form = document.getElementById('settings');
  function inr(n) { return '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN'); }
  function update() {
    var enabled = form.paymentEnabled.checked;
    var mode = form.paymentMode.value;
    var type = form.advanceType.value;
    var value = parseFloat(form.advanceValue.value);
    document.getElementById('options').className = enabled ? '' : 'muted'; // still submitted, so settings are kept when turned off
    document.getElementById('advance').hidden = mode !== 'advance';
    var provider = form.onlineProvider.value;
    document.getElementById('whatsapp-pay').hidden = provider !== 'whatsapp_pay';
    document.getElementById('pv-enabled').textContent = enabled ? 'ON' : 'OFF';
    var text;
    if (!enabled) text = 'No payment will be collected during booking.';
    else {
      var total = ${PREVIEW_TOTAL}, due = total;
      if (mode === 'advance') {
        if (!(value > 0) || (type === 'percentage' && value > 100)) { text = 'Enter a valid advance amount to see the preview.'; }
        else due = Math.min(Math.max(type === 'percentage' ? total * value / 100 : value, 1), total);
      }
      if (!text) {
        text = (provider === 'whatsapp_pay' ? 'WhatsApp Pay. ' : 'Razorpay link. ') + 'Payment mode: ' + (mode === 'advance' ? 'Advance (' + (type === 'percentage' ? value + '%' : inr(value)) + ')' : 'Full payment') +
          '. ' + inr(total) + ' booking → Customer pays ' + inr(due) + ' now → ' + inr(total - due) + ' remaining';
        if (form.allowCashOnDelivery.checked) text += ' (or ' + inr(total) + ' cash on delivery)';
      }
    }
    document.getElementById('pv-text').textContent = text;
  }
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
})();
</script>`,
  });
};

// Super admin: read-only overview of every business's payment configuration.
const renderSettingsOverview = ({ nonce, admin, csrf, businesses }) =>
  page({
    title: 'Payment Settings (all businesses)',
    nonce,
    nav: nav(admin, csrf),
    body: `
<main>
  <h1>Payment Settings - all businesses</h1>
  <p class="muted small">Read-only. Each business admin manages their own settings.</p>
  <div class="card"><table>
    <thead><tr><th>Business</th><th>Payment</th><th>Online method</th><th>Mode</th><th>Advance</th><th>Cash on delivery</th><th>Updated</th></tr></thead>
    <tbody>${businesses.map((b) => `
      <tr>
        <td data-label="Business">${esc(b.name)}</td>
        <td data-label="Payment"><span class="badge ${b.payment_enabled ? 'ok' : ''}">${b.payment_enabled ? 'ON' : 'OFF'}</span></td>
        <td data-label="Online method">${esc(b.online_provider === 'whatsapp_pay' ? `WhatsApp Pay (${b.whatsapp_pay_gateway || '-'})` : 'Razorpay link')}</td>
        <td data-label="Mode">${esc(b.payment_enabled ? (b.payment_mode === 'advance' ? 'Advance' : 'Full') : '-')}</td>
        <td data-label="Advance">${esc(b.payment_mode === 'advance' ? (b.advance_type === 'percentage' ? `${Number(b.advance_value)}%` : formatINR(b.advance_value)) : '-')}</td>
        <td data-label="Cash on delivery">${b.allow_cash_on_delivery ? 'Yes' : 'No'}</td>
        <td data-label="Updated">${esc(b.updated_at ? formatDateTime(new Date(b.updated_at)) : '-')}</td>
      </tr>`).join('')}</tbody>
  </table></div>
</main>`,
  });

// ---------------------------------------------------------------------------
// AI answers (approve which answers the assistant may reuse)
// ---------------------------------------------------------------------------
const renderAiAnswers = ({ nonce, admin, csrf, answers, flash = '' }) => {
  const canReview = admin.role === 'admin';
  const rows = answers.map((a) => `
    <tr>
      <td data-label="Customer asked">${esc(a.question || '-')}<br><span class="muted small">***${esc(String(a.client_phone || '').slice(-4))} · ${esc(formatDateTime(new Date(a.created_at)))}</span></td>
      <td data-label="Assistant answered">${esc(a.answer)}</td>
      <td data-label="Status"><span class="badge ${a.approved_at ? 'ok' : 'warn'}">${a.approved_at ? 'Approved' : 'Not approved'}</span></td>
      <td data-label="Action">${canReview ? `
        <form method="post" action="/admin/ai-answers/${esc(a.id)}/${a.approved_at ? 'unapprove' : 'approve'}">
          <input type="hidden" name="_csrf" value="${esc(csrf)}">
          <button class="btn small ${a.approved_at ? 'secondary' : ''}" type="submit">${a.approved_at ? 'Remove approval' : 'Approve'}</button>
        </form>` : ''}</td>
    </tr>`).join('');

  return page({
    title: 'AI Answers',
    nonce,
    nav: nav(admin, csrf),
    body: `
<main>
  <h1>AI Answers</h1>
  ${flash}
  <p class="muted small">The assistant reuses an answer for other customers' similar questions <b>only after you approve it</b>. Approve answers that are correct and contain nothing customer-specific.</p>
  <div class="card">
    ${answers.length === 0 ? '<p class="muted">No AI answers yet.</p>' : `
    <table>
      <thead><tr><th>Customer asked</th><th>Assistant answered</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`}
  </div>
</main>`,
  });
};

module.exports = { nav, renderLogin, renderBookings, renderSettings, renderSettingsOverview, renderAiAnswers, previewText };
