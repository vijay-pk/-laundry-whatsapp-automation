/**
 * End-to-end tests: GET/POST /webhook on the real server
 * (test database + mock Graph API, OpenAI disabled so intents use keywords).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { TEST_ENV, startServer, webhookPayload, textMessage, waitFor, sleep } = require('../helpers/server');
const { createBooking } = require('../../src/models/bookingModel');

const eventRow = async (id) =>
  (await query('SELECT * FROM webhook_events WHERE wa_message_id = $1', [id])).rows[0];

const waitForEventStatus = (id, statuses = ['done', 'failed']) =>
  waitFor(async () => {
    const row = await eventRow(id);
    return row && statuses.includes(row.status) ? row : null;
  });

const inboundMessages = async (phone) =>
  (await query(`SELECT * FROM messages WHERE direction = 'inbound' AND client_phone = $1`, [phone])).rows;

describe('POST/GET /webhook', () => {
  let graph;
  let server;
  let business;

  before(async () => {
    await resetDb();
    business = await createBusiness();
    graph = await startMockGraph();
    server = await startServer({ graphUrl: graph.url });
  });

  after(async () => {
    await server?.stop();
    await graph?.close();
    await closeDb();
  });

  describe('verification (GET)', () => {
    it('echoes the challenge for the right token', async () => {
      const res = await server.request(
        'GET',
        `/webhook?hub.mode=subscribe&hub.verify_token=${TEST_ENV.WEBHOOK_VERIFY_TOKEN}&hub.challenge=12345`
      );
      assert.equal(res.status, 200);
      assert.equal(res.text, '12345');
    });

    it('returns 403 for a wrong token', async () => {
      const res = await server.request('GET', '/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1');
      assert.equal(res.status, 403);
    });
  });

  describe('signature', () => {
    it('rejects unsigned events with 401 and does not process them', async () => {
      const payload = webhookPayload([textMessage('wamid.unsigned', '919200000001', 'hello')]);
      const res = await server.request('POST', '/webhook', { body: JSON.stringify(payload) });
      assert.equal(res.status, 401);
      await sleep(300);
      assert.equal(await eventRow('wamid.unsigned'), undefined);
    });
  });

  describe('idempotency', () => {
    it('processes concurrent duplicate deliveries exactly once', async () => {
      const phone = '919200000010';
      const payload = webhookPayload([textMessage('wamid.dup', phone, 'what are your prices?')]);

      const responses = await Promise.all([1, 2, 3, 4, 5].map(() => server.postWebhook(payload)));
      assert.deepEqual(responses.map((r) => r.status), [200, 200, 200, 200, 200]);

      const row = await waitForEventStatus('wamid.dup');
      assert.equal(row.status, 'done');
      assert.equal(row.attempts, 1);
      await sleep(300); // give any (wrong) duplicate processing time to show up

      assert.equal((await inboundMessages(phone)).length, 1);
      assert.equal(graph.sentTo(phone).length, 1, 'customer replied once');
      assert.equal(graph.sentTo(TEST_ENV.ADMIN_PHONE).filter((r) => r.body.text?.body.includes(phone)).length, 1, 'admin notified once');
    });

    it('skips a later redelivery of a processed message', async () => {
      const phone = '919200000010';
      await server.postWebhook(webhookPayload([textMessage('wamid.dup', phone, 'what are your prices?')]));
      await sleep(500);

      assert.equal((await inboundMessages(phone)).length, 1);
      assert.equal(graph.sentTo(phone).length, 1);
      assert.equal((await eventRow('wamid.dup')).attempts, 1);
    });

    it('retries a failed message when Meta redelivers it', async () => {
      const phone = '919200000020';
      const payload = webhookPayload([textMessage('wamid.retry', phone, 'hi')]);

      graph.failNextRequests(1); // customer reply fails on first attempt
      await server.postWebhook(payload);
      const failed = await waitForEventStatus('wamid.retry');
      assert.equal(failed.status, 'failed');
      assert.match(failed.last_error, /WhatsApp API error/);

      await server.postWebhook(payload);
      const done = await waitFor(async () => {
        const row = await eventRow('wamid.retry');
        return row?.status === 'done' ? row : null;
      });
      assert.equal(done.attempts, 2);
      assert.equal(graph.sentTo(phone).length, 2, 'one failed + one successful send');
    });

    it('processes every message in a batched delivery', async () => {
      const phone = '919200000030';
      await server.postWebhook(
        webhookPayload([textMessage('wamid.batch1', phone, 'hello'), textMessage('wamid.batch2', phone, 'good morning')])
      );

      assert.equal((await waitForEventStatus('wamid.batch1')).status, 'done');
      assert.equal((await waitForEventStatus('wamid.batch2')).status, 'done');
      assert.equal((await inboundMessages(phone)).length, 2);
    });
  });

  describe('intents', () => {
    it('cancel: cancels the booking and sends the template once', async () => {
      const phone = '919200000040';
      const booking = await createBooking(business.id, {
        clientPhone: phone, clientName: 'Asha', serviceType: 'Dry Cleaning',
      });
      const payload = webhookPayload([textMessage('wamid.cancel', phone, 'please cancel my booking')]);

      await server.postWebhook(payload);
      await server.postWebhook(payload);
      assert.equal((await waitForEventStatus('wamid.cancel')).status, 'done');
      await sleep(300);

      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
      assert.equal(rows[0].status, 'Cancelled');

      const sent = graph.sentTo(phone);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.type, 'template');
      assert.equal(sent[0].body.template.name, TEST_ENV.TEMPLATE_BOOKING_CANCELLED);
      assert.deepEqual(sent[0].body.template.components[0].parameters.map((p) => p.text), ['Asha', 'Dry Cleaning']);
      assert.equal(sent[0].auth, `Bearer ${TEST_ENV.GRAPH_API_TOKEN}`);
      assert.equal(sent[0].url, `/${TEST_ENV.PHONE_NUMBER_ID}/messages`);
    });

    it('cancel without a booking: explains by text', async () => {
      const phone = '919200000041';
      await server.postWebhook(webhookPayload([textMessage('wamid.cancel.none', phone, 'cancel')]));
      await waitForEventStatus('wamid.cancel.none');

      const sent = graph.sentTo(phone);
      assert.equal(sent.length, 1);
      assert.match(sent[0].body.text.body, /couldn't find an active booking/);
    });

    it('confirm: marks the booking Confirmed without messaging', async () => {
      const phone = '919200000050';
      const booking = await createBooking(business.id, { clientPhone: phone });
      await server.postWebhook(webhookPayload([textMessage('wamid.confirm', phone, 'yes')]));
      await waitForEventStatus('wamid.confirm');

      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
      assert.equal(rows[0].status, 'Confirmed');
      assert.equal(graph.sentTo(phone).length, 0);
    });

    it('reschedule without an active booking: suggests booking', async () => {
      const phone = '919200000060';
      await server.postWebhook(webhookPayload([textMessage('wamid.resched', phone, 'can I reschedule to friday')]));
      await waitForEventStatus('wamid.resched');

      const sent = graph.sentTo(phone);
      assert.equal(sent.length, 1);
      assert.match(sent[0].body.text.body, /don't have an active booking to reschedule/);
    });

    it('cancel after pickup: tells the customer and alerts the admin instead of cancelling', async () => {
      const phone = '919200000061';
      const booking = await createBooking(business.id, { clientPhone: phone, status: 'Processing' });
      await server.postWebhook(webhookPayload([textMessage('wamid.cancel.late', phone, 'cancel')]));
      await waitForEventStatus('wamid.cancel.late');

      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [booking.id]);
      assert.equal(rows[0].status, 'Processing');
      assert.match(graph.sentTo(phone)[0].body.text.body, /already been picked up/);
      assert.equal(graph.sentTo(TEST_ENV.ADMIN_PHONE).filter((r) => r.body.text?.body.includes(phone)).length, 1);
    });

    it('logs inbound and outbound messages with the client phone and intent', async () => {
      const phone = '919200000041';
      const { rows } = await query(
        'SELECT direction, intent FROM messages WHERE client_phone = $1 ORDER BY created_at',
        [phone]
      );
      assert.deepEqual(rows, [
        { direction: 'inbound', intent: 'cancel' },
        { direction: 'outbound', intent: 'cancel' },
      ]);
    });
  });

  describe('ignored payloads', () => {
    it('acknowledges status updates without processing', async () => {
      const res = await server.postWebhook({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.x', status: 'read' }] } }] }] });
      assert.equal(res.status, 200);
    });

    it('skips messages without an id', async () => {
      const phone = '919200000070';
      const res = await server.postWebhook(webhookPayload([{ from: phone, type: 'text', text: { body: 'hello' } }]));
      assert.equal(res.status, 200);
      await sleep(500);
      assert.equal((await inboundMessages(phone)).length, 0);
    });

    it('replies that only text is supported for unsupported message types', async () => {
      const phone = '919200000080';
      await server.postWebhook(webhookPayload([{ id: 'wamid.image', from: phone, type: 'image', image: { id: 'm1' } }]));
      assert.equal((await waitForEventStatus('wamid.image')).status, 'done');

      const sent = graph.sentTo(phone);
      assert.equal(sent.length, 1);
      assert.match(sent[0].body.text.body, /only read text messages/);
    });
  });
});
