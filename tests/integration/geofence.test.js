/**
 * End-to-end tests: geofenced pickup validation in the WhatsApp booking flow
 * (real server with BUSINESS_LAT/BUSINESS_LNG set + test database + mock Graph API).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

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

  // Mock geocoder (Nominatim API shape): place name -> result
  let geocoder;
  const geocodeResults = new Map();
  const startGeocoder = () =>
    new Promise((resolve) => {
      geocoder = http.createServer((req, res) => {
        const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
        const hit = [...geocodeResults.entries()].find(([key]) => q.startsWith(key));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(hit ? [hit[1]] : []));
      });
      geocoder.listen(0, () => resolve(`http://127.0.0.1:${geocoder.address().port}`));
    });

  before(async () => {
    await resetDb();
    business = await createBusiness();
    graph = await startMockGraph();
    const geocoderUrl = await startGeocoder();
    server = await startServer({
      graphUrl: graph.url,
      env: {
        DEFAULT_BUSINESS_ID: business.id,
        BUSINESS_LAT: String(STORE.lat),
        BUSINESS_LNG: String(STORE.lng),
        MAX_DELIVERY_RADIUS_KM: '5',
        GEOCODER_BASE_URL: geocoderUrl,
      },
    });
  });

  after(async () => {
    await new Promise((resolve) => (geocoder ? geocoder.close(resolve) : resolve()));
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

  describe('Google Maps links', () => {
    const startBooking = async (phone, name) => {
      await text(phone, 'book', { profileName: name });
      await pick(phone, 'svc_wash_fold');
    };

    it('accepts a pasted link that contains coordinates (exact) and shares it with the admin', async () => {
      const phone = '919700000010';
      await startBooking(phone, 'Link Exact');
      const link = `https://www.google.com/maps/search/${NEAR.latitude},+${NEAR.longitude}?entry=tts`;

      const [slots] = await text(phone, `here is my place ${link}`, { profileName: 'Link Exact' });
      assert.equal(slots.interactive.type, 'list');

      await pick(phone, slots.interactive.action.sections[0].rows[0].id);
      await text(phone, 'Flat 2A, Lake View Apartments', { profileName: 'Link Exact' });
      await tap(phone, 'notes_skip');
      const adminBefore = graph.sentTo(TEST_ENV.ADMIN_PHONE).length;
      await tap(phone, 'confirm_yes');

      const [booking] = await bookingsFor(phone);
      assert.equal(Number(booking.latitude), NEAR.latitude);
      assert.equal(booking.booking_state, 'confirmed');

      const notice = graph.sentTo(TEST_ENV.ADMIN_PHONE).slice(adminBefore).map((r) => r.body).find((b) => b.type === 'text').text.body;
      assert.ok(notice.includes(`Customer's link: ${link}`), notice);
      assert.doesNotMatch(notice, /approximate/);
    });

    it('rejects a pasted link far outside the radius', async () => {
      const phone = '919700000011';
      await startBooking(phone, 'Link Far');
      const [reply] = await text(phone, `https://maps.google.com/?q=${FAR.latitude},${FAR.longitude}`);
      assert.equal(reply.text.body, REJECTION);
      assert.equal((await bookingsFor(phone))[0].booking_state, 'rejected');
    });

    it('geocodes a place link without coordinates and accepts it when clearly inside', async () => {
      const phone = '919700000012';
      geocodeResults.set('Papaiah Road', { lat: '12.9800', lon: '77.6000', addresstype: 'road', display_name: 'Papaiah Road, Kammanahalli' });
      await startBooking(phone, 'Place Near');

      const [slots] = await text(phone, 'https://www.google.com/maps/place/Olive+Cafe,+Papaiah+Road,+Kammanahalli,+Bengaluru,+Karnataka+560084/data=!4m2');
      assert.equal(slots.interactive.type, 'list', 'accepted (~1 km, street-level)');

      const session = (await query('SELECT data FROM conversation_sessions WHERE client_phone = $1', [phone])).rows[0];
      assert.equal(session.data.geo.precision, 'approximate');
    });

    it('asks for the exact location when an approximate place is near the edge of the radius', async () => {
      const phone = '919700000013';
      // ~4.5 km north of the store, area-level (±2 km): could be inside or outside
      geocodeResults.set('Edge Area', { lat: '13.0121', lon: '77.5946', addresstype: 'suburb', display_name: 'Edge Area' });
      await startBooking(phone, 'Place Edge');

      const [reply] = await text(phone, 'https://maps.google.com/?q=Edge+Area,+Bengaluru,+Karnataka');
      assert.match(reply.text.body, /near the edge of our 5km service radius/);
      assert.equal((await sessionFor(phone)).step, 'location', 'still waiting for a location');
      assert.equal((await bookingsFor(phone)).length, 0, 'not rejected');
    });

    it("explains when a link can't be read", async () => {
      const phone = '919700000014';
      await startBooking(phone, 'Place Unknown');
      const [reply] = await text(phone, 'https://www.google.com/maps/place/Nowhere+Special,+Unknown+Street,+Atlantis/data=!4m2');
      assert.match(reply.text.body, /couldn't read a location from that link/);
    });

    it('guides the customer when a link is sent outside a booking', async () => {
      const [reply] = await text('919700000015', `https://maps.google.com/?q=${NEAR.latitude},${NEAR.longitude}`);
      assert.match(reply.text.body, /To book a pickup, send \*book\*/);
    });
  });

  it('replies with guidance when a location is shared outside a booking', async () => {
    const [reply] = await shareLocation('919700000004', NEAR);
    assert.match(reply.text.body, /To book a pickup, send \*book\*/);
  });
});
