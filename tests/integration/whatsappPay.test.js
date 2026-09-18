/**
 * End-to-end tests: WhatsApp Pay (in-chat order_details payments) as the admin-selected
 * online payment method (real server + test database + mock Graph API incl. payment lookup).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, waitFor, sleep } = require('../helpers/server');
const { savePaymentSettings } = require('../../src/models/paymentSettingsModel');
const { recordCashPayment } = require('../../src/services/paymentService');

const CONFIG = 'laundry-payments';
let counter = 0;

describe('WhatsApp Pay', () => {
  let graph;
  let server;
  let business;

  const say = async (phone, message) => {
    const before = graph.sentTo(phone).length;
    await server.postWebhook(webhookPayload([message], { profileName: 'Rahul' }));
    const row = await waitFor(async () => {
      const { rows } = await query('SELECT status, last_error FROM webhook_events WHERE wa_message_id = $1', [message.id]);
      return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
    });
    assert.equal(row?.status, 'done', `message failed: ${row?.last_error}`);
    return graph.sentTo(phone).slice(before).map((r) => r.body);
  };
  const id = () => `wamid.wapay.${++counter}`;
  const text = (phone, body) => say(phone, textMessage(id(), phone, body));
  const tap = (phone, replyId, kind = 'button_reply') => say(phone, tapMessage(id(), phone, replyId, replyId, kind));
  const rowIds = (reply) => reply.interactive.action.sections[0].rows.map((r) => r.id);

  const bookingFor = async (phone) => (await query('SELECT * FROM bookings WHERE client_phone = $1 ORDER BY created_at DESC LIMIT 1', [phone])).rows[0];
  const paymentsFor = async (bookingId) => (await query('SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at', [bookingId])).rows;
  const adminMessages = (from) => graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(from).map((r) => r.body);

  const setWhatsAppPay = (extra = {}) =>
    savePaymentSettings(business.id, {
      paymentEnabled: true, paymentMode: 'full', onlineProvider: 'whatsapp_pay',
      whatsappPayConfiguration: CONFIG, whatsappPayGateway: 'razorpay', ...extra,
    });

  /** Book 10 kg Wash & Fold (₹500) and tap Pay. Returns { summary, replies, booking, order }. */
  const bookAndPay = async (phone) => {
    await text(phone, 'book');
    await tap(phone, 'svc_wash_fold', 'list_reply');
    const [slots] = await text(phone, '10');
    await tap(phone, rowIds(slots)[0], 'list_reply');
    await text(phone, '12 MG Road, Indiranagar, Bengaluru');
    const [summary] = await tap(phone, 'notes_skip');
    const replies = await tap(phone, 'confirm_pay');
    const order = replies.find((r) => r.interactive?.type === 'order_details');
    return { summary, replies, order, booking: await bookingFor(phone) };
  };

  /** Signed WhatsApp webhook carrying a payment status update. */
  const paymentWebhook = (phone, { referenceId, amountPaise, txStatus = 'success', status = txStatus === 'success' ? 'captured' : txStatus, pgId = 'pay_WAtest12345', refunds }) =>
    server.postWebhook({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA_ID',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: TEST_ENV.PHONE_NUMBER_ID },
            statuses: [{
              id: `gBGG${++counter}`,
              recipient_id: phone,
              type: 'payment',
              status,
              payment: {
                reference_id: referenceId,
                amount: { value: amountPaise, offset: 100 },
                currency: 'INR',
                transaction: {
                  id: 'order_WAtest12345', pg_transaction_id: pgId, type: 'razorpay', status: txStatus,
                  method: { type: 'upi' }, ...(txStatus === 'failed' ? { error: { code: 'BAD_REQUEST_ERROR', reason: 'incorrect_pin' } } : {}),
                },
                ...(refunds ? { refunds } : {}),
              },
              timestamp: String(Math.floor(Date.now() / 1000)),
            }],
          },
        }],
      }],
    });

  const waitForBooking = (phone, predicate) => waitFor(async () => {
    const b = await bookingFor(phone);
    return predicate(b) ? b : null;
  });

  before(async () => {
    await resetDb();
    business = await createBusiness('Sparkle Laundry');
    graph = await startMockGraph();
    server = await startServer({ graphUrl: graph.url, env: { DEFAULT_BUSINESS_ID: business.id } });
  });

  after(async () => {
    await server?.stop();
    await graph?.close();
    await closeDb();
  });

  it('full payment: sends an order_details Pay message, confirms only after the payment webhook', async () => {
    await setWhatsAppPay();
    const phone = '919810000001';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;

    const { summary, replies, order, booking } = await bookAndPay(phone);
    assert.match(summary.interactive.body.text, /Pay in WhatsApp: ₹500 now/);
    assert.match(replies[0].text.body, /reserved - payment needed/);
    assert.doesNotMatch(replies[0].text.body, /\/pay\//, 'no Razorpay web link');

    assert.ok(order, 'order_details message sent');
    const params = order.interactive.action.parameters;
    assert.equal(order.interactive.action.name, 'review_and_pay');
    assert.match(params.reference_id, /^lb[0-9a-f]{24}-1$/);
    assert.ok(params.reference_id.length <= 35);
    assert.deepEqual(params.payment_settings[0].payment_gateway.type, 'razorpay');
    assert.equal(params.payment_settings[0].payment_gateway.configuration_name, CONFIG);
    assert.deepEqual(params.total_amount, { value: 50000, offset: 100 });
    assert.deepEqual(params.order.subtotal, { value: 50000, offset: 100 });
    assert.equal(params.order.items[0].quantity, 1);
    assert.ok(Number(params.order.expiration.timestamp) > Date.now() / 1000 + 300);

    assert.deepEqual([booking.status, booking.booking_state, booking.payment_method, booking.payment_status], ['Pending', 'awaiting_payment', 'whatsapp_pay', 'pending']);
    assert.equal(booking.payment_terms.whatsappPayConfiguration, CONFIG);
    const [record] = await paymentsFor(booking.id);
    assert.deepEqual([record.provider, record.status, record.wa_reference_id, record.amount_paise], ['whatsapp_pay', 'created', params.reference_id, 50000]);
    assert.equal(adminMessages(adminBefore).length, 0, 'no admin alert before payment');

    await paymentWebhook(phone, { referenceId: params.reference_id, amountPaise: 50000 });
    const paid = await waitForBooking(phone, (b) => b.payment_status === 'paid');
    assert.deepEqual([paid.status, Number(paid.amount_paid), Number(paid.amount_remaining)], ['Confirmed', 500, 0]);

    const [after] = await paymentsFor(booking.id);
    assert.deepEqual([after.status, after.pg_transaction_id, after.gateway_order_id], ['paid', 'pay_WAtest12345', 'order_WAtest12345']);

    await waitFor(() => graph.sentTo(phone).some((r) => /Payment received/.test(r.body.text?.body || '')));
    const receipt = graph.sentTo(phone).map((r) => r.body.text?.body || '').find((t) => /Payment received/.test(t));
    assert.match(receipt, /Total: ₹500\nPaid: ₹500\nRemaining: ₹0\nPayment status: Paid/);
    assert.match(receipt, /Payment ref: pay_WAtest12345/);

    const admin = adminMessages(adminBefore);
    assert.equal(admin[0].template.name, 'laundry_booking_alert');
    assert.match(admin[1].text.body, /Payment status: Paid/);
  });

  it('30% advance: requests ₹150 and records Partially Paid', async () => {
    await setWhatsAppPay({ paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phone = '919810000002';
    const { order, summary } = await bookAndPay(phone);
    assert.match(summary.interactive.body.text, /Pay in WhatsApp: ₹150 now \(advance\), ₹350 later/);
    assert.deepEqual(order.interactive.action.parameters.total_amount, { value: 15000, offset: 100 });

    await paymentWebhook(phone, { referenceId: order.interactive.action.parameters.reference_id, amountPaise: 15000 });
    const b = await waitForBooking(phone, (x) => x.payment_status === 'partially_paid');
    assert.deepEqual([Number(b.amount_paid), Number(b.amount_remaining), b.status], [150, 350, 'Confirmed']);
  });

  it('failed payment: status Failed, "pay" re-sends the Pay message, retry succeeds', async () => {
    await setWhatsAppPay();
    const phone = '919810000003';
    const { order, booking } = await bookAndPay(phone);
    const ref = order.interactive.action.parameters.reference_id;

    await paymentWebhook(phone, { referenceId: ref, amountPaise: 50000, txStatus: 'failed' });
    const failed = await waitForBooking(phone, (b) => b.payment_status === 'failed');
    assert.equal(failed.status, 'Pending');
    assert.equal((await paymentsFor(booking.id))[0].failure_reason, 'incorrect_pin');

    const replies = await text(phone, 'pay');
    assert.match(replies[0].text.body, /waiting for payment/);
    assert.match(replies[0].text.body, /Review and pay/);
    const resent = replies.find((r) => r.interactive?.type === 'order_details');
    assert.equal(resent.interactive.action.parameters.reference_id, ref, 'same unexpired request reused');

    await paymentWebhook(phone, { referenceId: ref, amountPaise: 50000, pgId: 'pay_WAretry1234' });
    const paid = await waitForBooking(phone, (b) => b.payment_status === 'paid');
    assert.equal(Number(paid.amount_paid), 500);
    assert.equal((await paymentsFor(booking.id)).length, 1);
  });

  it('duplicate payment webhooks count the money once', async () => {
    await setWhatsAppPay({ paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phone = '919810000004';
    const { order } = await bookAndPay(phone);
    const ref = order.interactive.action.parameters.reference_id;

    await Promise.all([1, 2, 3].map(() => paymentWebhook(phone, { referenceId: ref, amountPaise: 15000 })));
    await waitForBooking(phone, (b) => b.payment_status === 'partially_paid');
    await sleep(500);

    const b = await bookingFor(phone);
    assert.equal(Number(b.amount_paid), 150);
    assert.equal(graph.sentTo(phone).filter((r) => /Payment received/.test(r.body.text?.body || '')).length, 1);
  });

  it('ignores a success webhook with the wrong amount or an unknown reference', async () => {
    await setWhatsAppPay();
    const phone = '919810000005';
    const { order } = await bookAndPay(phone);

    await paymentWebhook(phone, { referenceId: order.interactive.action.parameters.reference_id, amountPaise: 100 });
    await paymentWebhook(phone, { referenceId: 'lbunknownreference-1', amountPaise: 50000 });
    await paymentWebhook(phone, { referenceId: 'bad reference with spaces', amountPaise: 50000 });
    await sleep(700);

    const b = await bookingFor(phone);
    assert.deepEqual([b.payment_status, b.status], ['pending', 'Pending']);
  });

  it('recovers a missed webhook via the payment lookup API when the customer tracks the order', async () => {
    await setWhatsAppPay();
    const phone = '919810000006';
    const { order } = await bookAndPay(phone);
    const ref = order.interactive.action.parameters.reference_id;

    graph.setPaymentLookup(ref, [{
      reference_id: ref, status: 'captured', currency: 'INR', amount: { value: 50000, offset: 100 },
      transactions: [{ id: 'order_lookup1234', pg_transaction_id: 'pay_lookup12345', type: 'razorpay', status: 'success', method: { type: 'upi' } }],
    }]);

    const replies = await text(phone, 'track my order');
    const track = replies.map((r) => r.text?.body || r.interactive?.body?.text || '').find((t) => /Status:/.test(t));
    assert.match(track, /Payment status: Paid/);
    const b = await bookingFor(phone);
    assert.deepEqual([b.payment_status, b.status], ['paid', 'Confirmed']);
    assert.equal((await paymentsFor(b.id))[0].pg_transaction_id, 'pay_lookup12345');
  });

  it('records refunds reported in payment webhooks', async () => {
    await setWhatsAppPay();
    const phone = '919810000007';
    const { order, booking } = await bookAndPay(phone);
    const ref = order.interactive.action.parameters.reference_id;
    await paymentWebhook(phone, { referenceId: ref, amountPaise: 50000, pgId: 'pay_refundme123' });
    await waitForBooking(phone, (b) => b.payment_status === 'paid');

    await paymentWebhook(phone, {
      referenceId: ref, amountPaise: 50000, pgId: 'pay_refundme123',
      refunds: [{ id: 'rfnd_wa12345', amount: { value: 50000, offset: 100 }, speed_processed: 'instant', status: 'success' }],
    });
    const refunded = await waitForBooking(phone, (b) => b.payment_status === 'refunded');
    assert.ok(refunded);
    const [record] = await paymentsFor(booking.id);
    assert.deepEqual([record.status, record.razorpay_refund_id, Number(record.refunded_amount)], ['refunded', 'rfnd_wa12345', 500]);
  });

  it('tells the customer and admin when the Pay message cannot be sent', async () => {
    await setWhatsAppPay();
    const phone = '919810000008';
    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    graph.failNextOrderDetails(1);

    const { replies } = await bookAndPay(phone); // the mock records the order_details attempt, then rejects it
    assert.ok(replies.some((r) => /couldn't open WhatsApp Pay/.test(r.text?.body || '')));
    assert.ok(adminMessages(adminBefore).some((m) => /WhatsApp Pay request failed/.test(m.text?.body || '')));
    assert.equal((await bookingFor(phone)).payment_status, 'pending', 'booking kept; customer can reply "pay" later');
  });

  it('keeps the WhatsApp Pay terms of existing bookings when the admin switches to the Razorpay link', async () => {
    await setWhatsAppPay();
    const phone = '919810000009';
    const { booking } = await bookAndPay(phone);

    await savePaymentSettings(business.id, { paymentEnabled: false, onlineProvider: 'razorpay_link' });
    const replies = await text(phone, 'pay');
    const resent = replies.find((r) => r.interactive?.type === 'order_details');
    assert.ok(resent, 'still WhatsApp Pay for the existing booking');
    assert.equal(resent.interactive.action.parameters.payment_settings[0].payment_gateway.configuration_name, CONFIG);
    assert.equal((await bookingFor(phone)).id, booking.id);
  });

  it('recording the advance balance at delivery keeps the booking status (no step back to Confirmed)', async () => {
    await setWhatsAppPay({ paymentMode: 'advance', advanceType: 'percentage', advanceValue: 30 });
    const phone = '919810000010';
    const { order, booking } = await bookAndPay(phone);
    await paymentWebhook(phone, { referenceId: order.interactive.action.parameters.reference_id, amountPaise: 15000 });
    await waitForBooking(phone, (b) => b.payment_status === 'partially_paid');

    await query(`UPDATE bookings SET status = 'Out for Delivery' WHERE id = $1`, [booking.id]);
    const { booking: after } = await recordCashPayment({ bookingId: booking.id, businessId: business.id });
    assert.deepEqual([after.status, after.payment_status, Number(after.amount_remaining)], ['Out for Delivery', 'paid', 0]);
  });

  it('cancelling a paid booking in chat flags a refund and alerts the admin', async () => {
    await setWhatsAppPay();
    const phone = '919810000011';
    const { order, booking } = await bookAndPay(phone);
    await paymentWebhook(phone, { referenceId: order.interactive.action.parameters.reference_id, amountPaise: 50000 });
    await waitForBooking(phone, (b) => b.payment_status === 'paid');

    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    await text(phone, 'cancel');
    await tap(phone, `cxl_yes_${booking.id}`);

    const b = await bookingFor(phone);
    assert.deepEqual([b.status, b.refund_required], ['Cancelled', true]);
    assert.ok(adminMessages(adminBefore).some((m) => /refund needed/.test(m.text?.body || '')));
  });

  it('never records cash for a pending WhatsApp Pay payment', async () => {
    const b = await bookingFor('919810000009');
    await assert.rejects(recordCashPayment({ bookingId: b.id, businessId: business.id }), { status: 409 });
  });
});
