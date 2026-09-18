/**
 * End-to-end tests: tracking, cancelling and rescheduling when a customer has several orders
 * (real server + test database + mock Graph API, OpenAI disabled).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, waitFor } = require('../helpers/server');
const { createBooking } = require('../../src/models/bookingModel');

let messageCounter = 0;
const nextId = () => `wamid.orders.${++messageCounter}`;

const ref = (booking) => booking.id.slice(0, 8).toUpperCase();
const statusOf = async (booking) => (await query('SELECT status FROM bookings WHERE id = $1', [booking.id])).rows[0].status;
const sessionFor = async (phone) =>
  (await query('SELECT * FROM conversation_sessions WHERE client_phone = $1', [phone])).rows[0];

describe('Several orders per customer', () => {
  let graph;
  let server;
  let business;

  // Send one customer message, wait until it's processed, return the replies sent to that customer.
  const say = async (phone, message) => {
    const before = graph.sentTo(phone).length;
    await server.postWebhook(webhookPayload([message]));
    const row = await waitFor(async () => {
      const { rows } = await query('SELECT * FROM webhook_events WHERE wa_message_id = $1', [message.id]);
      return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
    });
    assert.ok(row, `message ${message.id} was not processed`);
    assert.equal(row.status, 'done', `message ${message.id} failed: ${row.last_error}`);
    return graph.sentTo(phone).slice(before).map((r) => r.body);
  };
  const text = (phone, body) => say(phone, textMessage(nextId(), phone, body));
  const tap = (phone, replyId) => say(phone, tapMessage(nextId(), phone, replyId));
  const pick = (phone, rowId) => say(phone, tapMessage(nextId(), phone, rowId, rowId, 'list_reply'));

  const rowIds = (reply) => reply.interactive.action.sections[0].rows.map((r) => r.id);
  const buttonIds = (reply) => reply.interactive.action.buttons.map((b) => b.reply.id);

  // Two open orders (older first) and one delivered order.
  const twoOrders = async (phone) => {
    const older = await createBooking(business.id, {
      clientPhone: phone, clientName: 'Asha', serviceType: 'Dry Cleaning', status: 'Confirmed', scheduledTime: '2026-01-02T04:30:00Z',
    });
    await query(`UPDATE bookings SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [older.id]);
    const newer = await createBooking(business.id, {
      clientPhone: phone, clientName: 'Asha', serviceType: 'Wash & Iron', status: 'Pending', scheduledTime: '2026-01-03T04:30:00Z',
    });
    const delivered = await createBooking(business.id, { clientPhone: phone, serviceType: 'Wash & Fold', status: 'Delivered' });
    await query(`UPDATE bookings SET created_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [delivered.id]);
    return { older, newer, delivered };
  };

  before(async () => {
    await resetDb();
    business = await createBusiness();
    graph = await startMockGraph();
    server = await startServer({ graphUrl: graph.url, env: { DEFAULT_BUSINESS_ID: business.id } });
  });

  after(async () => {
    await server?.stop();
    await graph?.close();
    await closeDb();
  });

  describe('track', () => {
    it('lists open orders and tracks the one chosen by typed number', async () => {
      const phone = '919700000001';
      const { older, newer } = await twoOrders(phone);

      const [list] = await tap(phone, 'menu_track');
      assert.deepEqual(rowIds(list), [`ord_track_${newer.id}`, `ord_track_${older.id}`], 'newest first, delivered left out');
      assert.match(list.interactive.body.text, /You have 2 open orders/);
      assert.match(list.interactive.action.sections[0].rows[1].description, /Dry Cleaning · Confirmed/);

      const [status] = await text(phone, '2');
      assert.match(status.text.body, new RegExp(`Order #${ref(older)} - Dry Cleaning`));
      assert.match(status.text.body, /Status: \*Confirmed\*/);
      assert.equal(await sessionFor(phone), undefined, 'session cleared');
    });

    it('tracks the order named by its ref without asking', async () => {
      const phone = '919700000002';
      const { older } = await twoOrders(phone);

      const [status] = await text(phone, `where is my order #${ref(older).toLowerCase()}`);
      assert.match(status.text.body, new RegExp(`Order #${ref(older)}`));
    });

    it('tracks a tapped order row even after the session is gone', async () => {
      const phone = '919700000003';
      const { older } = await twoOrders(phone);

      await tap(phone, 'menu_track');
      await query('DELETE FROM conversation_sessions WHERE client_phone = $1', [phone]);
      const [status] = await pick(phone, `ord_track_${older.id}`);
      assert.match(status.text.body, new RegExp(`Order #${ref(older)}`));
    });

    it('with no open orders shows the latest one', async () => {
      const phone = '919700000004';
      await createBooking(business.id, { clientPhone: phone, serviceType: 'Wash & Fold', status: 'Delivered' });
      const [status] = await text(phone, 'track my order');
      assert.match(status.text.body, /Status: \*Delivered\*/);
    });

    it("never shows or acts on another customer's order", async () => {
      const phone = '919700000005';
      const other = await createBooking(business.id, { clientPhone: '919700000099', status: 'Confirmed' });

      const [tapped] = await pick(phone, `ord_cancel_${other.id}`);
      assert.match(tapped.text.body, /couldn't find that order/);
      const [yes] = await tap(phone, `cxl_yes_${other.id}`);
      assert.match(yes.text.body, /couldn't find that order/);
      const [typed] = await text(phone, `status #${ref(other)}`);
      assert.match(typed.text.body, /don't have any orders yet/);

      assert.equal(await statusOf(other), 'Confirmed');
    });
  });

  describe('cancel', () => {
    it('asks which order, asks to confirm, and cancels only that one', async () => {
      const phone = '919700000010';
      const { older, newer } = await twoOrders(phone);

      const [list] = await text(phone, 'cancel');
      assert.deepEqual(rowIds(list), [`ord_cancel_${newer.id}`, `ord_cancel_${older.id}`]);

      const [question] = await pick(phone, `ord_cancel_${older.id}`);
      assert.match(question.interactive.body.text, new RegExp(`Cancel order #${ref(older)}\\?`));
      assert.deepEqual(buttonIds(question), [`cxl_yes_${older.id}`, `cxl_no_${older.id}`]);

      const [kept] = await tap(phone, `cxl_no_${older.id}`);
      assert.match(kept.text.body, /stays booked/);
      assert.equal(await statusOf(older), 'Confirmed');

      await text(phone, 'cancel');
      await text(phone, '2');
      const [done] = await text(phone, 'yes');
      assert.equal(done.template.name, TEST_ENV.TEMPLATE_BOOKING_CANCELLED);
      assert.equal(await statusOf(older), 'Cancelled');
      assert.equal(await statusOf(newer), 'Pending', 'other order untouched');
    });

    it('with one open order goes straight to the confirmation', async () => {
      const phone = '919700000011';
      const booking = await createBooking(business.id, { clientPhone: phone, serviceType: 'Wash & Iron', status: 'Confirmed' });

      const [question] = await text(phone, 'cancel my booking');
      assert.deepEqual(buttonIds(question), [`cxl_yes_${booking.id}`, `cxl_no_${booking.id}`]);
    });

    it('typing "cancel" at the confirmation stops without cancelling; wrong answers give up after 3', async () => {
      const phone = '919700000012';
      const booking = await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      await text(phone, 'cancel');
      const [stopped] = await text(phone, 'cancel');
      assert.match(stopped.text.body, /stopped/);

      await text(phone, 'cancel');
      const [reask] = await text(phone, 'maybe');
      assert.match(reask.interactive.body.text, /Please tap \*Yes, cancel\*/);
      await text(phone, 'hmm');
      const [gaveUp] = await text(phone, 'what');
      assert.match(gaveUp.text.body, /start again/);

      assert.equal(await statusOf(booking), 'Confirmed');
      assert.equal(await sessionFor(phone), undefined);
    });

    it('re-checks the status when the answer arrives (picked up meanwhile)', async () => {
      const phone = '919700000013';
      const booking = await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      await text(phone, 'cancel');
      await query(`UPDATE bookings SET status = 'Picked Up' WHERE id = $1`, [booking.id]);
      const [reply] = await tap(phone, `cxl_yes_${booking.id}`);

      assert.match(reply.text.body, /already been picked up/);
      assert.equal(await statusOf(booking), 'Picked Up');
    });
  });

  describe('confirm', () => {
    it('with several pending orders asks which one and confirms only that', async () => {
      const phone = '919700000040';
      const older = await createBooking(business.id, { clientPhone: phone, serviceType: 'Dry Cleaning' });
      await query(`UPDATE bookings SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [older.id]);
      const newer = await createBooking(business.id, { clientPhone: phone, serviceType: 'Wash & Iron' });
      await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      const [list] = await text(phone, 'yes');
      assert.deepEqual(rowIds(list), [`ord_confirm_${newer.id}`, `ord_confirm_${older.id}`], 'only Pending orders');
      assert.match(list.interactive.body.text, /2 pending orders/);

      const [done] = await pick(phone, `ord_confirm_${older.id}`);
      assert.match(done.text.body, new RegExp(`Order #${ref(older)} is confirmed`));
      assert.equal(await statusOf(older), 'Confirmed');
      assert.equal(await statusOf(newer), 'Pending');
    });

    it('with one pending order confirms it silently', async () => {
      const phone = '919700000041';
      const pending = await createBooking(business.id, { clientPhone: phone });
      const confirmed = await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      const replies = await text(phone, 'yes');
      assert.equal(replies.length, 0);
      assert.equal(await statusOf(pending), 'Confirmed');
      assert.equal(await statusOf(confirmed), 'Confirmed');
    });

    it('never moves an order back to Confirmed', async () => {
      const phone = '919700000042';
      const booking = await createBooking(business.id, { clientPhone: phone, status: 'Out for Pickup' });
      await text(phone, 'yes');
      assert.equal(await statusOf(booking), 'Out for Pickup');
    });
  });

  describe('reschedule', () => {
    it('asks which pickup, then offers slots for that order', async () => {
      const phone = '919700000020';
      const { older, newer } = await twoOrders(phone);

      const [list] = await text(phone, 'reschedule');
      assert.deepEqual(rowIds(list), [`ord_reschedule_${newer.id}`, `ord_reschedule_${older.id}`]);

      const [slots] = await pick(phone, `ord_reschedule_${older.id}`);
      assert.match(slots.interactive.body.text, /Your current pickup is/);
      const session = await sessionFor(phone);
      assert.equal(session.flow, 'reschedule');
      assert.equal(session.data.bookingId, older.id);
    });

    it('re-asks on a wrong choice', async () => {
      const phone = '919700000021';
      await twoOrders(phone);

      await text(phone, 'reschedule');
      const [reask] = await text(phone, '7');
      assert.match(reask.interactive.body.text, /Please choose an order from the list/);
    });
  });

  describe('status updates', () => {
    it('include the order ref', async () => {
      const phone = '919700000030';
      const booking = await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      const res = await server.request('PATCH', `/api/bookings/${booking.id}/status`, {
        body: JSON.stringify({ status: 'Ready' }),
        headers: { 'x-api-key': TEST_ENV.BOOKING_API_KEY },
      });
      assert.equal(res.status, 200);
      assert.match(graph.sentTo(phone).at(-1).body.text.body, new RegExp(`^Order #${ref(booking)}: Your clothes are ready`));
    });
  });
});
