/**
 * src/views/payPage.js
 * Customer payment page (opened from the WhatsApp payment link): summary,
 * Razorpay Checkout button, receipt after payment.
 */

const { esc, page } = require('./html');
const { formatINR } = require('../utils/money');
const { formatDateTime } = require('../utils/formatDate');
const { PAYMENT_STATUS_LABELS } = require('../services/paymentService');

const STATUS_BADGE = { paid: 'ok', partially_paid: 'info', pending: 'warn', failed: 'bad', refunded: 'info' };

const row = (label, value) => `<div class="row"><span class="muted">${esc(label)}</span><b>${value}</b></div>`;

/**
 * @param {{booking: object, businessName: string, paymentRef: string|null, nonce: string, token: string}} data
 */
const renderPayPage = ({ booking, businessName, paymentRef, nonce, token }) => {
  const ref = booking.id.slice(0, 8).toUpperCase();
  const status = booking.payment_status;
  const paid = ['paid', 'partially_paid', 'refunded'].includes(status);
  const cancelled = booking.status === 'Cancelled';
  const payable = !paid && !cancelled && ['pending', 'failed'].includes(status);
  const dueNow = Number(booking.amount_due_now);
  const remainingAfter = Math.max(Number(booking.total_amount) - dueNow, 0);

  const notice = paid
    ? `<div class="notice ok">✅ Payment received${status === 'partially_paid' ? ' (advance)' : ''}. Your booking is confirmed.</div>`
    : cancelled
      ? '<div class="notice bad">This booking was cancelled, so no payment is needed.</div>'
      : status === 'failed'
        ? '<div class="notice bad">Your last payment attempt failed. You can try again. If money was deducted for a failed attempt, your bank reverses it automatically.</div>'
        : '';

  const amounts = paid
    ? [
        row('Total', esc(formatINR(booking.total_amount))),
        row('Paid', esc(formatINR(booking.amount_paid))),
        row('Remaining', esc(formatINR(booking.amount_remaining))),
        row('Payment status', `<span class="badge ${STATUS_BADGE[status] || ''}">${esc(PAYMENT_STATUS_LABELS[status] || status)}</span>`),
        row('Payment reference', `<code>${esc(paymentRef || '-')}</code>`),
      ]
    : [
        row('Total booking amount', esc(formatINR(booking.total_amount))),
        row(booking.payment_mode === 'advance' ? 'Advance to pay now' : 'Pay now', esc(formatINR(dueNow))),
        ...(remainingAfter > 0 ? [row('Remaining (pay later)', esc(formatINR(remainingAfter)))] : []),
        row('Payment status', `<span class="badge ${STATUS_BADGE[status] || ''}">${esc(PAYMENT_STATUS_LABELS[status] || status)}</span>`),
      ];

  const body = `
<main class="narrow">
  <div class="card">
    <p class="muted small">${esc(businessName)}</p>
    <h1>${paid ? 'Payment receipt' : 'Payment Required'}</h1>
    ${notice}
    <div id="message"></div>
    ${row('Booking', `#${esc(ref)}`)}
    ${row('Service', esc(`${booking.service_type || '-'}${booking.quantity ? ` · ${Number(booking.quantity)} ${booking.unit === 'kg' ? 'kg' : 'pcs'}` : ''}`))}
    ${row('Pickup', esc(booking.scheduled_time ? formatDateTime(new Date(booking.scheduled_time)) : '-'))}
    ${amounts.join('\n    ')}
  </div>
  ${payable ? `
  <button id="pay" class="btn" type="button">Pay ${esc(formatINR(dueNow))} now</button>
  <p class="muted small center">Secure payment by Razorpay. We never see your card details.</p>
  <button id="check" class="btn secondary" type="button">I already paid - check status</button>` : ''}
</main>`;

  const script = payable
    ? `<script nonce="${nonce}" src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script nonce="${nonce}">
(function () {
  var base = '/pay/${esc(token)}';
  var payBtn = document.getElementById('pay');
  var checkBtn = document.getElementById('check');
  var msg = document.getElementById('message');

  function show(text, kind) {
    msg.innerHTML = '';
    var div = document.createElement('div');
    div.className = 'notice ' + (kind || 'warn');
    div.textContent = text;
    msg.appendChild(div);
  }
  function post(path, body) {
    return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Request failed'); return j; }); });
  }
  function busy(on) { payBtn.disabled = on; checkBtn.disabled = on; }

  checkBtn.addEventListener('click', function () {
    busy(true);
    post('/sync').then(function () { location.reload(); }).catch(function (e) { show(e.message, 'bad'); busy(false); });
  });

  payBtn.addEventListener('click', function () {
    busy(true);
    post('/order').then(function (o) {
      if (o.alreadyPaid) return location.reload();
      if (typeof Razorpay === 'undefined') throw new Error('Could not load Razorpay. Check your connection and try again.');
      var rzp = new Razorpay({
        key: o.keyId, order_id: o.orderId, amount: o.amountPaise, currency: o.currency,
        name: ${JSON.stringify(businessName).replace(/</g, '\\u003c')}, description: o.description, prefill: o.prefill,
        handler: function (resp) {
          show('Verifying your payment…', 'warn');
          post('/verify', resp).then(function () { location.reload(); })
            .catch(function () { show('We could not confirm the payment yet. If money was taken, tap "check status" in a minute.', 'bad'); busy(false); });
        },
        modal: { ondismiss: function () { show('Payment not completed. You can try again whenever you are ready.', 'warn'); busy(false); } }
      });
      rzp.on('payment.failed', function () {
        show('Payment failed. Please try again.', 'bad');
        post('/sync').catch(function () {});
      });
      rzp.open();
    }).catch(function (e) { show(e.message || 'Payment is unavailable right now. Please try again later.', 'bad'); busy(false); });
  });
})();
</script>`
    : '';

  return page({ title: `Booking #${ref} - Payment`, body: body + script, nonce });
};

const renderPayNotFound = (nonce) =>
  page({
    title: 'Payment link not found',
    nonce,
    body: '<main class="narrow"><div class="card"><h1>Link not found</h1><p class="muted">This payment link is invalid. Please use the link we sent on WhatsApp.</p></div></main>',
  });

module.exports = { renderPayPage, renderPayNotFound };
