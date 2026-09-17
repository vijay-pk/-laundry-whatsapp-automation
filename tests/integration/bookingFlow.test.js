/**
 * End-to-end tests: WhatsApp chat booking, reschedule, tracking and menus
 * (real server + test database + mock Graph API, OpenAI disabled).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const {
  TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, locationMessage, waitFor,
} = require('../helpers/server');
const { createBooking } = require('../../src/models/bookingModel');
const { listSlots } = require('../../src/services/slotService');

// listSlots() in this process must use the same timezone as the server under test.
process.env.TIMEZONE = TEST_ENV.TIMEZONE;

let messageCounter = 0;
const nextId = () => `wamid.flow.${++messageCounter}`;

const sessionFor = async (phone) =>
  (await query('SELECT * FROM conversation_sessions WHERE client_phone = $1', [phone])).rows[0];

const bookingsFor = async (phone) =>
  (await query('SELECT * FROM bookings WHERE client_phone = $1 ORDER BY created_at', [phone])).rows;

describe('WhatsApp chat flows', () => {
  let graph;
  let server;
  let business;

  // Send one customer message, wait until it's processed, return the replies sent to that customer.
  const say = async (phone, build, { profileName } = {}) => {
    const message = build(nextId());
    const before = graph.sentTo(phone).length;
    await server.postWebhook(webhookPayload([message], { profileName }));

    const row = await waitFor(async () => {
      const { rows } = await query('SELECT * FROM webhook_events WHERE wa_message_id = $1', [message.id]);
      return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
    });
    assert.ok(row, `message ${message.id} was not processed`);
    assert.equal(row.status, 'done', `message ${message.id} failed: ${row.last_error}`);
    return graph.sentTo(phone).slice(before).map((r) => r.body);
  };

  const text = (phone, body, opts) => say(phone, (id) => textMessage(id, phone, body), opts);
  const tap = (phone, replyId, opts) => say(phone, (id) => tapMessage(id, phone, replyId), opts);
  const pick = (phone, rowId, opts) => say(phone, (id) => tapMessage(id, phone, rowId, rowId, 'list_reply'), opts);

  const buttonIds = (reply) => reply.interactive.action.buttons.map((b) => b.reply.id);
  const rowIds = (reply) => reply.interactive.action.sections[0].rows.map((r) => r.id);

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

  describe('main menu', () => {
    it('greets with the WhatsApp profile name and three menu buttons', async () => {
      const [reply] = await text('919500000001', 'hi', { profileName: 'Priya' });
      assert.equal(reply.type, 'interactive');
      assert.match(reply.interactive.body.text, /^Hi Priya! 👋 Welcome to/);
      assert.deepEqual(buttonIds(reply), ['menu_book', 'menu_track', 'menu_prices']);
    });

    it('shows prices', async () => {
      const [reply] = await tap('919500000001', 'menu_prices');
      assert.match(reply.text.body, /Wash & Fold/);
      assert.match(reply.text.body, /Reply \*book\*/);
    });

    it('replies to an expired flow button and shows the menu again', async () => {
      const replies = await tap('919500000001', 'confirm_yes');
      assert.match(replies[0].text.body, /That menu has expired/);
      assert.deepEqual(buttonIds(replies[1]), ['menu_book', 'menu_track', 'menu_prices']);
    });
  });

  describe('booking by tapping', () => {
    const phone = '919500000010';

    it('completes a booking and alerts the admin', async () => {
      const [services] = await tap(phone, 'menu_book', { profileName: 'Priya Sharma' });
      assert.equal(services.interactive.type, 'list');
      assert.deepEqual(rowIds(services), ['svc_wash_fold', 'svc_wash_iron', 'svc_ironing', 'svc_dry_clean']);
      assert.equal((await sessionFor(phone)).step, 'service');

      const [slots] = await pick(phone, 'svc_wash_iron');
      const slotId = rowIds(slots)[0];
      assert.match(slotId, /^slot_\d{4}-\d{2}-\d{2}_\d{4}$/);
      assert.deepEqual(rowIds(slots), listSlots().map((s) => s.id), 'offers the current slots');

      const [addressPrompt] = await pick(phone, slotId);
      assert.match(addressPrompt.text.body, /pickup address/);

      // Name comes from the WhatsApp profile, so the next step is instructions
      const [notesPrompt] = await text(phone, '12 MG Road, Indiranagar, near metro', { profileName: 'Priya Sharma' });
      assert.deepEqual(buttonIds(notesPrompt), ['notes_skip']);

      const [summary] = await tap(phone, 'notes_skip');
      assert.match(summary.interactive.body.text, /Service: Wash & Iron/);
      assert.match(summary.interactive.body.text, /Address: 12 MG Road, Indiranagar, near metro/);
      assert.match(summary.interactive.body.text, /Name: Priya Sharma/);
      assert.match(summary.interactive.body.text, /Instructions: None/);
      assert.deepEqual(buttonIds(summary), ['confirm_yes', 'confirm_restart', 'confirm_no']);

      const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
      const [confirmation] = await tap(phone, 'confirm_yes');
      assert.match(confirmation.text.body, /✅ Booking confirmed!/);
      assert.match(confirmation.text.body, /Ref: #[0-9A-F]{8}/);

      const [booking] = await bookingsFor(phone);
      assert.equal(booking.status, 'Confirmed');
      assert.equal(booking.source, 'whatsapp');
      assert.equal(booking.service_type, 'Wash & Iron');
      assert.equal(booking.client_name, 'Priya Sharma');
      assert.equal(booking.pickup_address, '12 MG Road, Indiranagar, near metro');
      assert.equal(booking.notes, null);
      assert.equal(booking.business_id, business.id);
      assert.equal(new Date(booking.scheduled_time).toISOString(), listSlots().find((s) => s.id === slotId).start);
      assert.equal(await sessionFor(phone), undefined, 'session cleared');

      const alerts = graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(adminBefore);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].body.template.name, 'laundry_booking_alert');
      assert.equal(alerts[0].body.template.components[0].parameters[0].text, 'Priya Sharma');
    });

    it('offers the saved address and name next time', async () => {
      await text(phone, 'book');
      const [slots] = await pick(phone, 'svc_dry_clean');
      const [addressChoice] = await pick(phone, rowIds(slots)[0]);
      assert.deepEqual(buttonIds(addressChoice), ['addr_saved', 'addr_new']);
      assert.match(addressChoice.interactive.body.text, /12 MG Road/);

      const [notesPrompt] = await tap(phone, 'addr_saved');
      assert.deepEqual(buttonIds(notesPrompt), ['notes_skip'], 'name step skipped for returning customer');

      await text(phone, 'Separate whites and colors');
      await tap(phone, 'confirm_yes');

      const bookings = await bookingsFor(phone);
      assert.equal(bookings.length, 2);
      assert.equal(bookings[1].pickup_address, '12 MG Road, Indiranagar, near metro');
      assert.equal(bookings[1].notes, 'Separate whites and colors');
    });

    it('processes a duplicated Confirm tap once', async () => {
      const dupPhone = '919500000011';
      await text(dupPhone, 'book', { profileName: 'Dup Test' });
      const [slots] = await pick(dupPhone, 'svc_ironing');
      await pick(dupPhone, rowIds(slots)[0]);
      await text(dupPhone, '221B Baker Street, Bengaluru', { profileName: 'Dup Test' });
      await tap(dupPhone, 'notes_skip');

      const confirm = webhookPayload([tapMessage('wamid.flow.dup-confirm', dupPhone, 'confirm_yes')]);
      await Promise.all([server.postWebhook(confirm), server.postWebhook(confirm), server.postWebhook(confirm)]);
      await waitFor(async () => (await bookingsFor(dupPhone)).length > 0);
      await waitFor(async () => {
        const { rows } = await query(`SELECT status FROM webhook_events WHERE wa_message_id = 'wamid.flow.dup-confirm'`);
        return rows[0]?.status === 'done';
      });

      assert.equal((await bookingsFor(dupPhone)).length, 1);
    });
  });

  describe('duplicate bookings', () => {
    // Book `serviceRow` at the first slot up to the summary (returning customer: saved address + name).
    const toSummary = async (phone, serviceRow) => {
      await text(phone, 'book');
      const [slots] = await pick(phone, serviceRow);
      await pick(phone, rowIds(slots)[0]);
      await tap(phone, 'addr_saved');
      return tap(phone, 'notes_skip');
    };
    const existingBooking = (phone, extra = {}) =>
      createBooking(business.id, {
        clientPhone: phone, clientName: 'Nisha', serviceType: 'Ironing only', pickupAddress: '7 Residency Road, Bengaluru',
        scheduledTime: listSlots()[0].start, status: 'Confirmed', ...extra,
      });

    it('asks before booking the same service and time again: keep, then book another', async () => {
      const phone = '919500000050';
      const existing = await existingBooking(phone);

      await toSummary(phone, 'svc_ironing');
      const [question] = await tap(phone, 'confirm_yes');
      assert.match(question.interactive.body.text, new RegExp(`already have order #${existing.id.slice(0, 8).toUpperCase()} for Ironing only`));
      assert.deepEqual(buttonIds(question), ['dup_keep', 'dup_new']);
      assert.equal((await sessionFor(phone)).step, 'duplicate');

      const [kept] = await tap(phone, 'dup_keep');
      assert.match(kept.text.body, /no new booking/);
      assert.equal((await bookingsFor(phone)).length, 1);
      assert.equal(await sessionFor(phone), undefined);

      await toSummary(phone, 'svc_ironing');
      await text(phone, 'yes');
      const [wrong] = await text(phone, 'maybe');
      assert.match(wrong.interactive.body.text, /Please tap \*Keep existing\*/);
      const [confirmation] = await text(phone, '2');
      assert.match(confirmation.text.body, /Booking confirmed/);
      assert.equal((await bookingsFor(phone)).length, 2);
    });

    it('does not ask for a different service, or when the old order is closed', async () => {
      const phone = '919500000051';
      const existing = await existingBooking(phone);

      await toSummary(phone, 'svc_wash_fold');
      const [confirmation] = await tap(phone, 'confirm_yes');
      assert.match(confirmation.text.body, /Booking confirmed/);

      await query(`UPDATE bookings SET status = 'Cancelled' WHERE id = $1`, [existing.id]);
      await toSummary(phone, 'svc_ironing');
      const [again] = await tap(phone, 'confirm_yes');
      assert.match(again.text.body, /Booking confirmed/);
    });

    it('points to the payment link of an unpaid online order', async () => {
      const phone = '919500000052';
      await existingBooking(phone, { status: 'Pending', paymentMethod: 'razorpay', paymentStatus: 'pending', paymentToken: 'a'.repeat(64) });

      await toSummary(phone, 'svc_ironing');
      const [question] = await tap(phone, 'confirm_yes');
      assert.match(question.interactive.body.text, /waiting for payment: \/pay\/a{64}/);
      const [kept] = await tap(phone, 'dup_keep');
      assert.match(kept.text.body, /\/pay\/a{64}/);
    });
  });

  describe('booking by typing', () => {
    const phone = '919500000020';

    it('accepts numbers, a shared location, a typed name and instructions', async () => {
      const [services] = await text(phone, 'I want to book a pickup');
      assert.equal(services.interactive.type, 'list');

      const [slots] = await text(phone, '2'); // Wash & Iron
      await text(phone, '1'); // first slot

      const [namePrompt] = await say(phone, (id) =>
        locationMessage(id, phone, { latitude: 12.9716, longitude: 77.5946, name: 'Home', address: 'Koramangala' })
      );
      assert.match(namePrompt.text.body, /What name/);

      await text(phone, 'Ravi Kumar');
      const [summary] = await text(phone, 'No starch please');
      assert.match(summary.interactive.body.text, /Instructions: No starch please/);

      const [confirmation] = await text(phone, 'yes');
      assert.match(confirmation.text.body, /Booking confirmed/);

      const [booking] = await bookingsFor(phone);
      assert.equal(booking.client_name, 'Ravi Kumar');
      assert.equal(booking.notes, 'No starch please');
      assert.equal(booking.service_type, 'Wash & Iron');
      assert.equal(booking.pickup_address, 'Home, Koramangala (https://maps.google.com/?q=12.9716,77.5946)');
      assert.equal(new Date(booking.scheduled_time).toISOString(), listSlots().find((s) => s.id === rowIds(slots)[0]).start);
    });
  });

  describe('leaving and mistakes', () => {
    it('re-asks on invalid input and gives up after 3 tries', async () => {
      const phone = '919500000030';
      await text(phone, 'book');

      const [first] = await text(phone, 'banana');
      assert.match(first.interactive.body.text, /Please choose a service from the list/);
      await text(phone, '99');
      const [third] = await text(phone, 'still wrong');

      assert.match(third.text.body, /Let's start again/);
      assert.equal(await sessionFor(phone), undefined);
    });

    it('rejects too-short addresses and names', async () => {
      const phone = '919500000031';
      await text(phone, 'book');
      await text(phone, '1');
      await text(phone, '1');

      const [shortAddress] = await text(phone, 'home');
      assert.match(shortAddress.text.body, /at least 10 characters/);
      assert.equal((await sessionFor(phone)).step, 'address');

      await text(phone, '45 Brigade Road, Bengaluru');
      const [shortName] = await text(phone, 'x');
      assert.match(shortName.text.body, /between 2 and 60 characters/);
    });

    it('"stop" and "cancel" end the flow without touching existing bookings', async () => {
      const phone = '919500000032';
      const existing = await createBooking(business.id, { clientPhone: phone, status: 'Confirmed' });

      await text(phone, 'book');
      const [stopped] = await text(phone, 'cancel');
      assert.match(stopped.text.body, /I've stopped/);
      assert.equal(await sessionFor(phone), undefined);

      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [existing.id]);
      assert.equal(rows[0].status, 'Confirmed');
    });

    it('"menu" leaves the flow and shows the main menu', async () => {
      const phone = '919500000033';
      await text(phone, 'book');
      const [menu] = await text(phone, 'menu');
      assert.deepEqual(buttonIds(menu), ['menu_book', 'menu_track', 'menu_prices']);
      assert.equal(await sessionFor(phone), undefined);
    });

    it('discards the booking when the customer taps Cancel on the summary', async () => {
      const phone = '919500000034';
      await text(phone, 'book', { profileName: 'Anu' });
      await text(phone, '1');
      await text(phone, '1');
      await text(phone, '9 Residency Road, Bengaluru', { profileName: 'Anu' });
      await tap(phone, 'notes_skip');
      const [discarded] = await tap(phone, 'confirm_no');

      assert.match(discarded.text.body, /Booking discarded/);
      assert.equal((await bookingsFor(phone)).length, 0);
    });

    it('starts over after 30 minutes of silence', async () => {
      const phone = '919500000035';
      await text(phone, 'book');
      await query(`UPDATE conversation_sessions SET updated_at = NOW() - INTERVAL '31 minutes' WHERE client_phone = $1`, [phone]);

      const [menu] = await text(phone, 'hello');
      assert.deepEqual(buttonIds(menu), ['menu_book', 'menu_track', 'menu_prices'], 'handled as a fresh greeting');
    });
  });

  describe('reschedule and tracking', () => {
    const phone = '919500000040';

    it('tracks an order', async () => {
      const [none] = await text(phone, 'where is my laundry');
      assert.match(none.text.body, /don't have any orders yet/);

      await createBooking(business.id, {
        clientPhone: phone, clientName: 'Meena', serviceType: 'Dry Cleaning', status: 'Processing',
      });
      const [status] = await tap(phone, 'menu_track');
      assert.match(status.text.body, /Dry Cleaning/);
      assert.match(status.text.body, /Status: \*Processing\*/);
      assert.match(status.text.body, /being processed/);
    });

    it('moves the pickup to a new slot and tells the admin', async () => {
      const reschedulePhone = '919500000041';
      const booking = await createBooking(business.id, {
        clientPhone: reschedulePhone, clientName: 'Kiran', status: 'Confirmed', scheduledTime: '2026-01-01T04:30:00Z',
      });

      const [slots] = await text(reschedulePhone, 'please reschedule my pickup');
      assert.match(slots.interactive.body.text, /Your current pickup is/);
      const newSlot = rowIds(slots).at(-1);

      const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
      const [done] = await pick(reschedulePhone, newSlot);
      assert.match(done.text.body, /Your pickup is now/);

      const { rows } = await query('SELECT scheduled_time FROM bookings WHERE id = $1', [booking.id]);
      assert.equal(new Date(rows[0].scheduled_time).toISOString(), listSlots().find((s) => s.id === newSlot).start);

      const adminNotes = graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(adminBefore);
      assert.equal(adminNotes.length, 1);
      assert.match(adminNotes[0].body.text.body, /Pickup rescheduled/);
    });

    it('does not move a pickup that was picked up while the customer was choosing', async () => {
      const latePhone = '919500000042';
      const booking = await createBooking(business.id, {
        clientPhone: latePhone, status: 'Confirmed', scheduledTime: '2026-01-01T04:30:00Z',
      });

      const [slots] = await text(latePhone, 'reschedule');
      await query(`UPDATE bookings SET status = 'Picked Up' WHERE id = $1`, [booking.id]);
      const [reply] = await pick(latePhone, rowIds(slots).at(-1));

      assert.match(reply.text.body, /picked up now, so the pickup time can't be changed/);
      const { rows } = await query('SELECT scheduled_time FROM bookings WHERE id = $1', [booking.id]);
      assert.equal(new Date(rows[0].scheduled_time).toISOString(), '2026-01-01T04:30:00.000Z');
      assert.equal(await sessionFor(latePhone), undefined);
    });
  });
});
