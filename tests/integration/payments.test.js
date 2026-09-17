/**
 * End-to-end tests: optional payments in the WhatsApp booking flow
 * (real server + test database + mock Graph API + mock Razorpay API).
 * Covers the required TEST 1-9 scenarios plus failure/recovery cases.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { startMockRazorpay } = require('../helpers/mockRazorpay');
const { TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, waitFor, sleep } = require('../helpers/server');
const { savePaymentSettings } = require('../../src/models/paymentSettingsModel');

const PUBLIC_BASE_URL = 'https://pay.example.test';
let counter = 0;

describe('Optional payments (WhatsApp booking + Razorpay)', () => {
  let graph;
  let rzp;
  let server;
  let business;

  // ---- chat helpers ----
  const say = async (phone, message, profileName = 'Rahul') => {
    const before = graph.sentTo(phone).length;
    await server.postWebhook(webhookPayload([message], { profileName }));
    const row = await waitFor(async () => {
      const { rows } = await query('SELECT status, last_error FROM webhook_events WHERE wa_message_id = $1', [message.id]);
      return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
    });
    assert.equal(row?.status, 'done', `message failed: ${row?.last_error}`);
    return graph.sentTo(phone).slice(before).map((r) => r.body);
  };
  const id = () => `wamid.pay.${++counter}`;
  const text = (phone, body) => say(phone, textMessage(id(), phone, body));
  const tap = (phone, replyId, kind = 'button_reply') => say(phone, tapMessage(id(), phone, replyId, replyId, kind));
  const rowIds = (reply) => reply.interactive.action.sections[0].rows.map((r) => r.id);
  const buttonIds = (reply) => reply.interactive.action.buttons.map((b) => b.reply.id);

  /** Book Wash & Fold (₹50/kg) through chat up to the summary. Returns the summary message. */
  const bookUntilSummary = async (phone, { quantity = '10', expectQuantity = true } = {}) => {
    await text(phone, 'book');
    const [next] = await tap(phone, 'svc_wash_fold', 'list_reply');
    let slots = next;
    if (expectQuantity) {
      assert.equal(next.type, 'text', 'asks for quantity');
      assert.match(next.text.body, /how many kg/i);
      [slots] = await text(phone, quantity);
    }
    assert.equal(slots.interactive.type, 'list', 'pickup slots');
    await tap(phone, rowIds(slots)[0], 'list_reply');
    await text(phone, '12 MG Road, Indiranagar, Bengaluru');
    const [summary] = await tap(phone, 'notes_skip');
    return summary;
  };

  const tokenFrom = (message) => message.text.body.match(/\/pay\/([a-f0-9]{64})/)?.[1];
  const bookingFor = async (phone) => (await query('SELECT * FROM bookings WHERE client_phone = $1 ORDER BY created_at DESC LIMIT 1', [phone])).rows[0];
  const paymentsFor = async (bookingId) => (await query('SELECT * FROM payments WHERE booking_id = $1', [bookingId])).rows;
  const adminMessages = (from) => graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(from).map((r) => r.body);

  const createOrder = (token, body = {}) => server.request('POST', `/pay/${token}/order`, { body: JSON.stringify(body) });
  const verify = (token, callback) => server.request('POST', `/pay/${token}/verify`, { body: JSON.stringify(callback) });
  const postRazorpayWebhook = ({ body, headers }) => server.request('POST', '/webhooks/razorpay', { body, headers });

  const setSettings = (settings) => savePaymentSettings(business.id, settings);

  /** Book with online payment and return { token, booking }. */
  const bookOnline = async (phone, opts) => {
    const summary = await bookUntilSummary(phone, opts);
    const [linkMessage] = await tap(phone, 'confirm_pay');
    const token = tokenFrom(linkMessage);
    assert.ok(token, `payment link in: ${linkMessage.text?.body}`);
    return { summary, linkMessage, token };
  };

  before(async () => {
    await resetDb();
    business = await createBusiness('Sparkle Laundry');
    graph = await startMockGraph();
    rzp = await startMockRazorpay();
    server = await startServer({
      graphUrl: graph.url,
      env: { DEFAULT_BUSINESS_ID: business.id, RAZORPAY_API_BASE_URL: rzp.url, PUBLIC_BASE_URL, ...rzp.env },
    });
  });

  after(async () => {
    await server?.stop();
    await rzp?.close();
    await graph?.close();
    await closeDb();
  });

  it('TEST 1: payment OFF - no quantity or payment, booking confirmed as before', async () => {
    const phone = '919800000001';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const summary = await bookUntilSummary(phone, { expectQuantity: false });

    assert.doesNotMatch(summary.interactive.body.text, /Total|Pay|₹/);
    assert.deepEqual(buttonIds(summary), ['confirm_yes', 'confirm_restart', 'confirm_no']);

    const [confirmation] = await tap(phone, 'confirm_yes');
    assert.match(confirmation.text.body, /✅ Booking confirmed!/);
    assert.doesNotMatch(confirmation.text.body, /pay/i);

    const b = await bookingFor(phone);
    assert.equal(b.status, 'Confirmed');
    assert.equal(b.payment_status, 'not_required');
    assert.equal(b.payment_method, null);
    assert.equal(b.total_amount, null);
    assert.equal(adminMessages(adminBefore)[0].template.name, 'laundry_booking_alert', 'admin alerted immediately');
  });

  it('TEST 2: payment ON + full payment - pays ₹500, remaining ₹0, status Paid', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'full' });
    const phone = '919800000002';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;

    const { summary, linkMessage, token } = await bookOnline(phone);
    assert.match(summary.interactive.body.text, /Quantity: 10 kg × ₹50/);
    assert.match(summary.interactive.body.text, /Total: ₹500/);
    assert.match(summary.interactive.body.text, /Pay online: ₹500 now/);
    assert.match(linkMessage.text.body, new RegExp(`${PUBLIC_BASE_URL}/pay/${token}`));

    let b = await bookingFor(phone);
    assert.equal(b.status, 'Pending', 'not confirmed before payment');
    assert.equal(b.booking_state, 'awaiting_payment');
    assert.equal(b.payment_status, 'pending');
    assert.equal(adminMessages(adminBefore).length, 0, 'no booking alert before payment');

    const page = await server.request('GET', `/pay/${token}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Payment Required/);
    assert.match(page.text, /Pay ₹500 now/);
    assert.match(page.headers.get('content-security-policy'), /checkout\.razorpay\.com/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

    // Browser-supplied amount is ignored: the order uses the DB amount.
    const order = await createOrder(token, { amount: 1 });
    assert.equal(order.status, 200);
    assert.equal(order.json.amountPaise, 50000);
    assert.equal(rzp.orders.get(order.json.orderId).amount, 50000);
    assert.equal(order.json.keyId, rzp.env.RAZORPAY_KEY_ID);
    assert.doesNotMatch(JSON.stringify(order.json), new RegExp(rzp.env.RAZORPAY_KEY_SECRET), 'secret never sent to browser');

    const payment = rzp.pay(order.json.orderId);
    const result = await verify(token, rzp.checkoutCallback(payment));
    assert.equal(result.status, 200);
    assert.equal(result.json.result, 'paid');

    b = await bookingFor(phone);
    assert.equal(b.status, 'Confirmed');
    assert.equal(b.payment_status, 'paid');
    assert.equal(Number(b.total_amount), 500);
    assert.equal(Number(b.amount_paid), 500);
    assert.equal(Number(b.amount_remaining), 0);

    const [record] = await paymentsFor(b.id);
    assert.equal(record.status, 'paid');
    assert.equal(record.razorpay_order_id, order.json.orderId);
    assert.equal(record.razorpay_payment_id, payment.id);
    assert.equal(record.payment_type, 'full');
    assert.equal(record.amount_paise, 50000);

    const receipt = graph.sentTo(phone).at(-1).body.text.body;
    assert.match(receipt, /Payment received - booking confirmed/);
    assert.match(receipt, /Total: ₹500\nPaid: ₹500\nRemaining: ₹0\nPayment status: Paid/);
    assert.match(receipt, new RegExp(`Payment ref: ${payment.id}`));

    const admin = adminMessages(adminBefore);
    assert.equal(admin[0].template.name, 'laundry_booking_alert', 'approved template unchanged');
    assert.equal(admin[0].template.components[0].parameters.length, 3);
    assert.match(admin[1].text.body, /Payment status: Paid/);

    const receiptPage = await server.request('GET', `/pay/${token}`);
    assert.match(receiptPage.text, /Payment receipt/);
    assert.match(receiptPage.text, new RegExp(payment.id));
    assert.doesNotMatch(receiptPage.text, /id="pay"/, 'no pay button after payment');
  });

  it('TEST 3: 30% advance - pays ₹150, remaining ₹350, status Partially Paid', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phone = '919800000003';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;

    const { summary, token } = await bookOnline(phone);
    assert.match(summary.interactive.body.text, /Pay online: ₹150 now \(advance\), ₹350 later/);

    const order = await createOrder(token);
    assert.equal(order.json.amountPaise, 15000);
    await verify(token, rzp.checkoutCallback(rzp.pay(order.json.orderId)));

    const b = await bookingFor(phone);
    assert.deepEqual([Number(b.amount_paid), Number(b.amount_remaining), b.payment_status, b.status], [150, 350, 'partially_paid', 'Confirmed']);
    assert.equal(b.payment_mode, 'advance');
    assert.deepEqual([b.payment_terms.mode, b.payment_terms.advanceType, b.payment_terms.advanceValue], ['advance', 'percentage', 30]);
    assert.equal((await paymentsFor(b.id))[0].payment_type, 'advance');

    assert.match(graph.sentTo(phone).at(-1).body.text.body, /Total: ₹500\nPaid: ₹150\nRemaining: ₹350\nPayment status: Partially Paid/);
    assert.match(adminMessages(adminBefore)[1].text.body, /Paid: ₹150\nRemaining: ₹350\nPayment status: Partially Paid/);
  });

  it('TEST 4: fixed ₹100 advance - pays ₹100, remaining ₹400', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'fixed', advanceValue: 100 });
    const phone = '919800000004';
    const { token } = await bookOnline(phone);

    const order = await createOrder(token);
    assert.equal(order.json.amountPaise, 10000);
    await verify(token, rzp.checkoutCallback(rzp.pay(order.json.orderId)));

    const b = await bookingFor(phone);
    assert.deepEqual([Number(b.amount_paid), Number(b.amount_remaining), b.payment_status], [100, 400, 'partially_paid']);
  });

  it('TEST 5: failed payment - status Failed, booking not paid/confirmed; retry succeeds on the same order', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'full' });
    const phone = '919800000005';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const { token } = await bookOnline(phone);

    const order = await createOrder(token);
    const failed = rzp.pay(order.json.orderId, { status: 'failed' });
    const hook = await postRazorpayWebhook(rzp.webhook('payment.failed', { payment: failed }));
    assert.equal(hook.status, 200);

    let b = await bookingFor(phone);
    assert.equal(b.payment_status, 'failed');
    assert.equal(b.status, 'Pending');
    assert.equal(Number(b.amount_paid), 0);
    assert.equal((await paymentsFor(b.id))[0].status, 'failed');
    assert.equal(adminMessages(adminBefore).length, 0);

    const retryPage = await server.request('GET', `/pay/${token}`);
    assert.match(retryPage.text, /last payment attempt failed/);

    const retryOrder = await createOrder(token);
    assert.equal(retryOrder.json.orderId, order.json.orderId, 'same Razorpay order reused for the retry');
    await verify(token, rzp.checkoutCallback(rzp.pay(order.json.orderId)));

    b = await bookingFor(phone);
    assert.equal(b.payment_status, 'paid');
    assert.equal((await paymentsFor(b.id)).length, 1);
  });

  it('TEST 6: customer closes checkout - payment stays Pending, nothing confirmed', async () => {
    const phone = '919800000006';
    const { token } = await bookOnline(phone);
    const order = await createOrder(token);
    assert.equal(order.status, 200);

    const sync = await server.request('POST', `/pay/${token}/sync`);
    assert.equal(sync.json.paymentStatus, 'pending');

    const b = await bookingFor(phone);
    assert.deepEqual([b.payment_status, b.status, Number(b.amount_paid)], ['pending', 'Pending', 0]);
    assert.equal((await paymentsFor(b.id))[0].status, 'created');

    // Clicking Pay again reuses the order instead of creating a new one.
    const before = rzp.ordersCreated().length;
    await createOrder(token);
    assert.equal(rzp.ordersCreated().length, before);
  });

  it('TEST 7: duplicate callbacks and webhooks record exactly one payment', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phone = '919800000007';
    const { token } = await bookOnline(phone);
    const order = await createOrder(token);
    const payment = rzp.pay(order.json.orderId);
    const callback = rzp.checkoutCallback(payment);
    const captured = rzp.webhook('payment.captured', { payment, eventId: 'evt_dup_1' });

    const results = await Promise.all([
      verify(token, callback),
      verify(token, callback),
      postRazorpayWebhook(captured),
      postRazorpayWebhook(captured), // same event id
      postRazorpayWebhook(rzp.webhook('order.paid', { payment })),
    ]);
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    await sleep(300);

    const b = await bookingFor(phone);
    assert.equal(Number(b.amount_paid), 150, 'amount counted once');
    assert.equal(b.payment_status, 'partially_paid');
    const records = await paymentsFor(b.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'paid');
    assert.equal(graph.sentTo(phone).filter((r) => /Payment received/.test(r.body.text?.body || '')).length, 1, 'one receipt');
  });

  it('rejects an invalid checkout signature without recording payment', async () => {
    const phone = '919800000008';
    const { token } = await bookOnline(phone);
    const order = await createOrder(token);
    const payment = rzp.pay(order.json.orderId);

    const res = await verify(token, rzp.checkoutCallback(payment, { tamper: true }));
    assert.equal(res.status, 400);
    const b = await bookingFor(phone);
    assert.equal(b.payment_status, 'pending');

    const wrongBooking = await verify(token, { ...rzp.checkoutCallback(payment), razorpay_order_id: 'order_notours123' });
    assert.equal(wrongBooking.status, 400);
  });

  it('rejects webhooks with a bad signature', async () => {
    const hook = rzp.webhook('payment.captured', { payment: { id: 'pay_fake12345', order_id: 'order_fake12345' }, secret: 'wrong-secret' });
    assert.equal((await postRazorpayWebhook(hook)).status, 401);
  });

  it('recovers a payment whose browser callback was lost (webhook arrives later / page reload)', async () => {
    const phoneA = '919800000009';
    const a = await bookOnline(phoneA);
    const orderA = await createOrder(a.token);
    const paymentA = rzp.pay(orderA.json.orderId);
    // No /verify call. Customer reloads the page: server checks Razorpay.
    const page = await server.request('GET', `/pay/${a.token}`);
    assert.match(page.text, /Payment receipt/);
    assert.equal((await bookingFor(phoneA)).payment_status, 'partially_paid');

    // Webhook arriving afterwards is a no-op.
    assert.equal((await postRazorpayWebhook(rzp.webhook('payment.captured', { payment: paymentA }))).json.outcome, 'already_paid');

    const phoneB = '919800000010';
    const b = await bookOnline(phoneB);
    const orderB = await createOrder(b.token);
    const paymentB = rzp.pay(orderB.json.orderId);
    const hook = await postRazorpayWebhook(rzp.webhook('payment.captured', { payment: paymentB }));
    assert.equal(hook.json.outcome, 'paid_now', 'webhook alone confirms the payment');
    assert.equal((await bookingFor(phoneB)).status, 'Confirmed');
  });

  it('handles Razorpay being unavailable when creating the order', async () => {
    const phone = '919800000011';
    const { token } = await bookOnline(phone);
    rzp.failNextRequests(1, 500);

    const res = await createOrder(token);
    assert.equal(res.status, 503);
    assert.match(res.json.error, /temporarily unavailable/);
    assert.equal((await paymentsFor((await bookingFor(phone)).id)).length, 0);

    assert.equal((await createOrder(token)).status, 200, 'works again once Razorpay is back');
  });

  it('sends the admin the pickup location after an online payment for a geofenced booking', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'full' });
    const phone = '919800000030';
    const { token } = await bookOnline(phone);
    // Same columns the geofencing step fills in (tests run without BUSINESS_LAT/LNG)
    await query(
      `UPDATE bookings SET latitude = 12.9716, longitude = 77.5946, distance_km = 2.1, location_precision = 'approximate',
       location_link = 'https://maps.app.goo.gl/abc' WHERE payment_token = $1`,
      [token]
    );
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;

    const order = await createOrder(token);
    await verify(token, rzp.checkoutCallback(rzp.pay(order.json.orderId)));

    const notice = adminMessages(adminBefore).find((m) => /inside service area/.test(m.text?.body || ''));
    assert.ok(notice, 'location notice sent');
    assert.match(notice.text.body, /query=12\.9716,77\.5946/);
    assert.match(notice.text.body, /Distance: 2\.1 km \(approximate/);
    assert.match(notice.text.body, /Customer's link: https:\/\/maps\.app\.goo\.gl\/abc/);
  });

  it('does not confirm an unpaid booking when the customer replies "yes"', async () => {
    const phone = '919800000012';
    const { token } = await bookOnline(phone);
    const [reply] = await text(phone, 'yes');
    assert.match(reply.text.body, /confirmed once the payment is received/);
    assert.match(reply.text.body, new RegExp(token));
    assert.equal((await bookingFor(phone)).status, 'Pending');
  });

  it('flags a refund when a cancelled booking is paid later', async () => {
    const phone = '919800000013';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const { token } = await bookOnline(phone);
    const order = await createOrder(token);
    await text(phone, 'cancel');
    await tap(phone, `cxl_yes_${(await bookingFor(phone)).id}`);

    const payment = rzp.pay(order.json.orderId);
    await postRazorpayWebhook(rzp.webhook('payment.captured', { payment }));

    const b = await bookingFor(phone);
    assert.equal(b.status, 'Cancelled');
    assert.equal(b.refund_required, true);
    assert.ok(adminMessages(adminBefore).some((m) => /refund needed/.test(m.text?.body || '')));
  });

  it('records Razorpay refunds from webhooks (idempotent)', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'full' });
    const phone = '919800000014';
    const { token } = await bookOnline(phone);
    const order = await createOrder(token);
    const payment = rzp.pay(order.json.orderId);
    await verify(token, rzp.checkoutCallback(payment));

    const refund = { id: 'rfnd_test12345', entity: 'refund', payment_id: payment.id, amount: 50000, status: 'processed' };
    await postRazorpayWebhook(rzp.webhook('refund.processed', { refund }));
    await postRazorpayWebhook(rzp.webhook('refund.processed', { refund })); // new event id, same refund

    const b = await bookingFor(phone);
    const [record] = await paymentsFor(b.id);
    assert.equal(record.status, 'refunded');
    assert.equal(record.razorpay_refund_id, 'rfnd_test12345');
    assert.equal(Number(record.refunded_amount), 500);
    assert.equal(b.payment_status, 'refunded');
  });

  it('cash on delivery: booking confirmed now, payment pending until cash is recorded', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30, allowCashOnDelivery: true });
    const phone = '919800000015';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const summary = await bookUntilSummary(phone);
    assert.deepEqual(buttonIds(summary), ['confirm_pay', 'confirm_cod', 'confirm_no']);
    assert.match(summary.interactive.body.text, /Or pay ₹500 cash on delivery/);

    const [confirmation] = await tap(phone, 'confirm_cod');
    assert.match(confirmation.text.body, /Booking confirmed!/);
    assert.match(confirmation.text.body, /cash on delivery/);

    const b = await bookingFor(phone);
    assert.deepEqual([b.status, b.payment_method, b.payment_status, Number(b.amount_remaining)], ['Confirmed', 'cod', 'pending', 500]);
    assert.equal(adminMessages(adminBefore)[0].template.name, 'laundry_booking_alert');
  });

  it('TEST 9: disabling payment affects only new bookings; existing terms and amounts are kept', async () => {
    await setSettings({ paymentEnabled: true, paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phoneA = '919800000016';
    const a = await bookOnline(phoneA);
    const before = await bookingFor(phoneA);

    await setSettings({ paymentEnabled: false, paymentMode: 'full' });
    const phoneB = '919800000017';
    await bookUntilSummary(phoneB, { expectQuantity: false });
    await tap(phoneB, 'confirm_yes');
    assert.equal((await bookingFor(phoneB)).payment_status, 'not_required');

    // Existing booking still charges its original 30% advance.
    const order = await createOrder(a.token);
    assert.equal(order.json.amountPaise, 15000);
    const after = await bookingFor(phoneA);
    assert.deepEqual(
      [Number(after.amount_due_now), Number(after.total_amount), after.payment_terms.advanceValue],
      [Number(before.amount_due_now), Number(before.total_amount), 30]
    );
  });

  it('returns 404 for unknown payment links', async () => {
    const res = await server.request('GET', `/pay/${'a'.repeat(64)}`);
    assert.equal(res.status, 404);
    assert.equal((await server.request('POST', `/pay/${'b'.repeat(64)}/order`)).status, 404);
    assert.equal((await server.request('GET', '/pay/not-a-token')).status, 404);
  });
});
