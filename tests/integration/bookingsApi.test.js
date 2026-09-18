/**
 * End-to-end tests: POST /api/bookings on the real server
 * (test database + mock Graph API).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const { TEST_ENV, startServer } = require('../helpers/server');

const validBooking = (overrides = {}) => ({
  clientName: 'Meena',
  clientPhone: '+91 99999 00005',
  serviceType: 'Wash & Fold',
  scheduledTime: '2026-09-21T10:00:00+05:30',
  ...overrides,
});

const countByExternalId = async (externalId) =>
  Number((await query('SELECT COUNT(*) FROM bookings WHERE external_id = $1', [externalId])).rows[0].count);

const adminAlerts = (graph) =>
  graph.sentTo(TEST_ENV.ADMIN_PHONE).filter((r) => r.body.template?.name === 'laundry_booking_alert');

describe('POST /api/bookings', () => {
  let graph;
  let server;
  let business;
  let otherBusiness;

  before(async () => {
    await resetDb();
    business = await createBusiness('Default Laundry');
    otherBusiness = await createBusiness('Other Laundry');
    graph = await startMockGraph();
    server = await startServer({ graphUrl: graph.url, env: { DEFAULT_BUSINESS_ID: business.id } });
  });

  after(async () => {
    await server?.stop();
    await graph?.close();
    await closeDb();
  });

  describe('authentication', () => {
    it('returns 401 without x-api-key', async () => {
      const res = await server.request('POST', '/api/bookings', { body: JSON.stringify(validBooking()) });
      assert.equal(res.status, 401);
    });

    it('returns 403 with a wrong key', async () => {
      const res = await server.postBooking(validBooking(), { 'x-api-key': 'wrong' });
      assert.equal(res.status, 403);
    });
  });

  describe('validation', () => {
    it('returns 400 with details for missing/invalid fields', async () => {
      const res = await server.postBooking({ clientPhone: 'abc', scheduledTime: 'nope' });
      assert.equal(res.status, 400);
      assert.equal(res.json.error, 'Validation failed');
      assert.equal(res.json.details.length, 4);
    });

    it('returns 400 for malformed JSON', async () => {
      const res = await server.request('POST', '/api/bookings', {
        body: '{bad',
        headers: { 'x-api-key': TEST_ENV.BOOKING_API_KEY },
      });
      assert.equal(res.status, 400);
    });

    it('returns 404 for an unknown businessId', async () => {
      const res = await server.postBooking(validBooking({ businessId: crypto.randomUUID() }));
      assert.equal(res.status, 404);
    });
  });

  describe('create', () => {
    it('creates the booking and alerts the admin', async () => {
      graph.reset();
      const res = await server.postBooking(validBooking({ pickupAddress: ' 12 MG Road ' }));

      assert.equal(res.status, 201);
      assert.equal(res.json.duplicate, false);
      assert.equal(res.json.data.business_id, business.id);
      assert.equal(res.json.data.client_phone, '919999900005', 'phone stored as digits');
      assert.equal(res.json.data.pickup_address, '12 MG Road');
      assert.equal(res.json.notification.sent, true);

      const alerts = adminAlerts(graph);
      assert.equal(alerts.length, 1);
      const params = alerts[0].body.template.components[0].parameters.map((p) => p.text);
      assert.equal(params[0], 'Meena');
      assert.equal(params[1], 'Wash & Fold');
      assert.doesNotMatch(params[2], /T\d\d:/, 'scheduled time is human-formatted, not ISO');
    });

    it('still returns 201 when the admin alert fails', async () => {
      graph.failNextRequests(1);
      const res = await server.postBooking(validBooking());
      assert.equal(res.status, 201);
      assert.equal(res.json.notification.sent, false);
      assert.match(res.json.notification.error, /WhatsApp API error/);
    });

    it('does not deduplicate requests without a key', async () => {
      const a = await server.postBooking(validBooking());
      const b = await server.postBooking(validBooking());
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.json.data.id, b.json.data.id);
    });
  });

  describe('PATCH /api/bookings/:id/status', () => {
    const patchStatus = (id, body, headers = { 'x-api-key': TEST_ENV.BOOKING_API_KEY }) =>
      server.request('PATCH', `/api/bookings/${id}/status`, { body: JSON.stringify(body), headers });

    let bookingId;
    before(async () => {
      const res = await server.postBooking(validBooking({ clientName: 'Status Test', clientPhone: '919600000001' }));
      bookingId = res.json.data.id;
    });

    it('requires the API key', async () => {
      assert.equal((await patchStatus(bookingId, { status: 'Ready' }, {})).status, 401);
    });

    it('updates the status and messages the customer', async () => {
      graph.reset();
      const res = await patchStatus(bookingId, { status: 'Out for Pickup' });

      assert.equal(res.status, 200);
      assert.equal(res.json.data.status, 'Out for Pickup');
      assert.equal(res.json.notification.sent, true);
      assert.equal(res.json.notification.channel, 'text');

      const sent = graph.sentTo('919600000001');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].body.text.body, `Order #${bookingId.slice(0, 8).toUpperCase()}: Our driver is on the way to pick up your clothes.`);

      const { rows } = await query(
        `SELECT intent FROM messages WHERE client_phone = '919600000001' AND direction = 'outbound'`
      );
      assert.deepEqual(rows.map((r) => r.intent), ['status_update']);
    });

    it('does not message again when the status is unchanged', async () => {
      graph.reset();
      const res = await patchStatus(bookingId, { status: 'Out for Pickup' });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.notification, { sent: false, skipped: 'status unchanged' });
      assert.equal(graph.sentTo('919600000001').length, 0);
    });

    it('saves the status even if the WhatsApp message fails', async () => {
      graph.failNextRequests(1);
      const res = await patchStatus(bookingId, { status: 'Ready' });
      assert.equal(res.status, 200);
      assert.equal(res.json.data.status, 'Ready');
      assert.equal(res.json.notification.sent, false);
    });

    it('rejects unknown statuses', async () => {
      const res = await patchStatus(bookingId, { status: 'Lost' });
      assert.equal(res.status, 400);
      assert.match(res.json.details[0], /Out for Delivery/);
    });

    it('returns 404 for an unknown booking and 400 for a malformed id', async () => {
      assert.equal((await patchStatus(crypto.randomUUID(), { status: 'Ready' })).status, 404);
      assert.equal((await patchStatus('not-a-uuid', { status: 'Ready' })).status, 400);
    });
  });

  describe('idempotency', () => {
    it('returns the existing booking for a retry and does not alert again', async () => {
      graph.reset();
      const first = await server.postBooking(validBooking({ externalId: 'EXT-1' }));
      // Same booking, different formatting of phone and time
      const retry = await server.postBooking(
        validBooking({ externalId: 'EXT-1', clientPhone: '919999900005', scheduledTime: '2026-09-21T04:30:00Z' })
      );

      assert.equal(first.status, 201);
      assert.equal(retry.status, 200);
      assert.equal(retry.json.duplicate, true);
      assert.equal(retry.json.data.id, first.json.data.id);
      assert.deepEqual(retry.json.notification, { sent: false, skipped: 'duplicate request' });
      assert.equal(adminAlerts(graph).length, 1);
      assert.equal(await countByExternalId('EXT-1'), 1);
    });

    it('returns 409 when a key is reused with different details', async () => {
      const res = await server.postBooking(validBooking({ externalId: 'EXT-1', serviceType: 'Dry Cleaning' }));
      assert.equal(res.status, 409);
      assert.ok(res.json.bookingId);
      assert.equal(await countByExternalId('EXT-1'), 1);
    });

    it('creates exactly one booking for concurrent identical requests', async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => server.postBooking(validBooking({ externalId: 'EXT-CONCURRENT' })))
      );
      const statuses = responses.map((r) => r.status);

      assert.equal(statuses.filter((s) => s === 201).length, 1);
      assert.equal(statuses.filter((s) => s === 200).length, 9);
      assert.equal(new Set(responses.map((r) => r.json.data.id)).size, 1);
      assert.equal(await countByExternalId('EXT-CONCURRENT'), 1);
    });

    it('accepts the key via Idempotency-Key header', async () => {
      const a = await server.postBooking(validBooking(), { 'Idempotency-Key': 'HDR-1' });
      const b = await server.postBooking(validBooking(), { 'Idempotency-Key': 'HDR-1' });
      assert.equal(a.status, 201);
      assert.equal(b.status, 200);
      assert.equal(a.json.data.external_id, 'HDR-1');
      assert.equal(b.json.data.id, a.json.data.id);
    });

    it('scopes keys per business', async () => {
      const res = await server.postBooking(validBooking({ externalId: 'EXT-1', businessId: otherBusiness.id }));
      assert.equal(res.status, 201);
      assert.equal(res.json.data.business_id, otherBusiness.id);
    });

    it('rejects invalid keys with 400', async () => {
      const mismatch = await server.postBooking(validBooking({ externalId: 'A' }), { 'Idempotency-Key': 'B' });
      const notString = await server.postBooking(validBooking({ externalId: 123 }));
      const tooLong = await server.postBooking(validBooking({ externalId: 'x'.repeat(256) }));

      assert.equal(mismatch.status, 400);
      assert.equal(notString.status, 400);
      assert.equal(tooLong.status, 400);
    });
  });
});
