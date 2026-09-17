/**
 * End-to-end tests: geofenced pickup validation in the WhatsApp booking flow
 * (real server with BUSINESS_LAT/BUSINESS_LNG set + test database + mock Graph API).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const { startMockGraph } = require('../helpers/mockGraph');
const {
  TEST_ENV, startServer, webhookPayload, textMessage, tapMessage, locationMessage, waitFor,
} = require('../helpers/server');

const STORE = { lat: 12.9716, lng: 77.5946 };
const NEAR = { latitude: 12.9896, longitude: 77.5946 }; // ~2 km north
const FAR = { latitude: 13.0616, longitude: 77.5946 };  // ~10 km north

const LOCATION_REQUEST =
  'Please share your pickup location so we can check if you are within our 5km service area. ' +
  'Click the 📎 attachment icon -> Location -> Send your current location.';
const REJECTION = 'Sorry, your location is outside our 5km service radius. We cannot process this booking.';

let counter = 0;

describe('Geofenced pickup validation', () => {
  let graph;
  let server;
  let business;

  const say = async (phone, build, { profileName } = {}) => {
    const message = build(`wamid.geo.${++counter}`);
    const before = graph.sentTo(phone).length;
    await server.postWebhook(webhookPayload([message], { profileName }));
    const row = await waitFor(async () => {
      const { rows } = await query('SELECT status, last_error FROM webhook_events WHERE wa_message_id = $1', [message.id]);
      return ['done', 'failed'].includes(rows[0]?.status) ? rows[0] : null;
    });
    assert.equal(row?.status, 'done', `message failed: ${row?.last_error}`);
    return graph.sentTo(phone).slice(before).map((r) => r.body);
  };
  const text = (phone, body, opts) => say(phone, (id) => textMessage(id, phone, body), opts);
  const tap = (phone, replyId, opts) => say(phone, (id) => tapMessage(id, phone, replyId), opts);
  const pick = (phone, rowId, opts) => say(phone, (id) => tapMessage(id, phone, rowId, rowId, 'list_reply'), opts);
  const shareLocation = (phone, location, opts) => say(phone, (id) => locationMessage(id, phone, location), opts);

  const sessionFor = async (phone) =>
    (await query('SELECT * FROM conversation_sessions WHERE client_phone = $1', [phone])).rows[0];
  const bookingsFor = async (phone) =>
    (await query('SELECT * FROM bookings WHERE client_phone = $1 ORDER BY created_at', [phone])).rows;

  before(async () => {
    await resetDb();
    business = await createBusiness();
    graph = await startMockGraph();
    server = await startServer({
      graphUrl: graph.url,
      env: {
        DEFAULT_BUSINESS_ID: business.id,
        BUSINESS_LAT: String(STORE.lat),
        BUSINESS_LNG: String(STORE.lng),
        MAX_DELIVERY_RADIUS_KM: '5',
      },
    });
  });

  after(async () => {
    await server?.stop();
    await graph?.close();
    await closeDb();
  });

  it('asks for the location right after the service is chosen', async () => {
    const phone = '919700000001';
    await text(phone, 'book');
    const [request] = await pick(phone, 'svc_wash_fold');

    assert.equal(request.type, 'text');
    assert.equal(request.text.body, LOCATION_REQUEST);
    assert.equal((await sessionFor(phone)).step, 'location');
  });

  it('does not accept a typed address instead of a shared location', async () => {
    const phone = '919700000001';
    const [reprompt] = await text(phone, '12 MG Road, Bengaluru');

    assert.match(reprompt.text.body, /share your location using the 📎 attachment icon/);
    assert.equal((await sessionFor(phone)).step, 'location');
  });

  it('rejects a location outside 5 km and records the rejected request', async () => {
    const phone = '919700000002';
    await text(phone, 'book', { profileName: 'Far Away' });
    await pick(phone, 'svc_dry_clean');

    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const [reply] = await shareLocation(phone, FAR);

    assert.equal(reply.text.body, REJECTION);
    assert.equal(await sessionFor(phone), undefined, 'flow ended');
    assert.equal(graph.sentTo(TEST_ENV.ADMIN_PHONE).length, adminBefore, 'admin not notified');

    const [booking] = await bookingsFor(phone);
    assert.equal(booking.booking_state, 'rejected');
    assert.equal(booking.status, 'Cancelled');
    assert.equal(booking.service_type, 'Dry Cleaning');
    assert.equal(Number(booking.latitude), FAR.latitude);
    assert.equal(Number(booking.longitude), FAR.longitude);
    assert.ok(Number(booking.distance_km) > 9.9 && Number(booking.distance_km) < 10.1);
  });

  it('accepts a location within 5 km, completes the booking and sends the admin a map link', async () => {
    const phone = '919700000003';
    await text(phone, 'book', { profileName: 'Near Customer' });
    await pick(phone, 'svc_wash_iron');

    const [slots] = await shareLocation(phone, NEAR);
    assert.equal(slots.interactive.type, 'list', 'continues to pickup slots');
    const slotId = slots.interactive.action.sections[0].rows[0].id;

    const [addressPrompt] = await pick(phone, slotId);
    assert.match(addressPrompt.text.body, /house\/flat number, street and a landmark/);

    await text(phone, 'Flat 4B, Palm Residency, near park', { profileName: 'Near Customer' });
    const [summary] = await tap(phone, 'notes_skip');
    assert.match(summary.interactive.body.text, /📌 Distance: 2(\.\d+)? km from our store/);

    const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
    const [confirmation] = await tap(phone, 'confirm_yes');
    assert.match(confirmation.text.body, /Booking confirmed/);

    const [booking] = await bookingsFor(phone);
    assert.equal(booking.booking_state, 'confirmed');
    assert.equal(booking.status, 'Confirmed');
    assert.equal(Number(booking.latitude), NEAR.latitude);
    assert.equal(Number(booking.longitude), NEAR.longitude);
    assert.ok(Number(booking.distance_km) > 1.9 && Number(booking.distance_km) < 2.1);
    assert.equal(booking.pickup_address, 'Flat 4B, Palm Residency, near park');

    const adminMessages = graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(adminBefore).map((r) => r.body);
    assert.equal(adminMessages.length, 2, 'booking alert template + location text');
    assert.equal(adminMessages[0].template.name, 'laundry_booking_alert');

    const notice = adminMessages[1].text.body;
    assert.match(notice, /Customer: Near Customer/);
    assert.match(notice, /Phone: \+919700000003/);
    assert.match(notice, /Service: Wash & Iron/);
    assert.ok(
      notice.includes(`https://www.google.com/maps/search/?api=1&query=${NEAR.latitude},${NEAR.longitude}`),
      notice
    );
  });

  it('replies with guidance when a location is shared outside a booking', async () => {
    const [reply] = await shareLocation('919700000004', NEAR);
    assert.match(reply.text.body, /To book a pickup, send \*book\*/);
  });
});
