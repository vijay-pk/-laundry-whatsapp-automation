/**
 * Integration tests: src/models/bookingModel.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { query, resetDb, createBusiness, closeDb } = require('../helpers/db');
const bookings = require('../../src/models/bookingModel');

describe('bookingModel', () => {
  let business;
  let otherBusiness;

  before(async () => {
    await resetDb();
    business = await createBusiness('Laundry A');
    otherBusiness = await createBusiness('Laundry B');
  });
  after(closeDb);

  describe('createBooking', () => {
    it('creates a Pending booking', async () => {
      const b = await bookings.createBooking(business.id, {
        clientPhone: '919000000001',
        clientName: 'Asha',
        serviceType: 'Wash & Iron',
        pickupAddress: '12 MG Road',
        scheduledTime: '2026-09-20T09:30:00.000Z',
      });
      assert.equal(b.status, 'Pending');
      assert.equal(b.business_id, business.id);
      assert.equal(b.client_name, 'Asha');
      assert.equal(b.external_id, null);
      assert.equal(new Date(b.scheduled_time).toISOString(), '2026-09-20T09:30:00.000Z');
    });

    it('allows many bookings without externalId', async () => {
      const a = await bookings.createBooking(business.id, { clientPhone: '919000000002' });
      const b = await bookings.createBooking(business.id, { clientPhone: '919000000002' });
      assert.ok(a && b);
      assert.notEqual(a.id, b.id);
    });

    it('returns null for a duplicate externalId in the same business', async () => {
      const first = await bookings.createBooking(business.id, { clientPhone: '919000000003', externalId: 'EXT-1' });
      const dup = await bookings.createBooking(business.id, { clientPhone: '919000000003', externalId: 'EXT-1' });
      assert.ok(first);
      assert.equal(dup, null);
    });

    it('scopes externalId per business', async () => {
      const other = await bookings.createBooking(otherBusiness.id, { clientPhone: '919000000003', externalId: 'EXT-1' });
      assert.ok(other);
    });

    it('validates required fields with status 400', async () => {
      await assert.rejects(bookings.createBooking('', { clientPhone: '91900' }), { status: 400 });
      await assert.rejects(bookings.createBooking(business.id, {}), { status: 400 });
    });

    it('maps a malformed UUID to 400 and an unknown business to 404', async () => {
      await assert.rejects(bookings.createBooking('not-a-uuid', { clientPhone: '91900' }), { status: 400 });
      await assert.rejects(bookings.createBooking(crypto.randomUUID(), { clientPhone: '91900' }), { status: 404 });
    });

    it('maps an invalid date to 400', async () => {
      await assert.rejects(
        bookings.createBooking(business.id, { clientPhone: '91900', scheduledTime: 'not a date' }),
        { status: 400 }
      );
    });
  });

  describe('findBookingByExternalId', () => {
    it('finds by business + externalId', async () => {
      const found = await bookings.findBookingByExternalId(business.id, 'EXT-1');
      assert.equal(found.client_phone, '919000000003');
      assert.equal(found.business_id, business.id);
    });

    it('returns null when not found', async () => {
      assert.equal(await bookings.findBookingByExternalId(business.id, 'NOPE'), null);
    });
  });

  describe('getLatestBookingForClient', () => {
    it('returns the most recent booking', async () => {
      const phone = '919000000010';
      await bookings.createBooking(business.id, { clientPhone: phone, clientName: 'old' });
      const newer = await bookings.createBooking(business.id, { clientPhone: phone, clientName: 'new' });
      await query(`UPDATE bookings SET created_at = NOW() - INTERVAL '1 day' WHERE client_name = 'old'`);

      assert.equal((await bookings.getLatestBookingForClient(phone)).id, newer.id);
    });

    it('scopes by business when businessId is given', async () => {
      const phone = '919000000011';
      const inA = await bookings.createBooking(business.id, { clientPhone: phone });
      await bookings.createBooking(otherBusiness.id, { clientPhone: phone });

      assert.equal((await bookings.getLatestBookingForClient(phone, business.id)).id, inA.id);
    });

    it('returns null for unknown clients', async () => {
      assert.equal(await bookings.getLatestBookingForClient('919999999999'), null);
    });
  });

  describe('updateBookingStatus', () => {
    it('updates and returns the booking', async () => {
      const b = await bookings.createBooking(business.id, { clientPhone: '919000000020' });
      const updated = await bookings.updateBookingStatus(b.id, 'Confirmed');
      assert.equal(updated.status, 'Confirmed');
    });

    it('returns null for an unknown booking', async () => {
      assert.equal(await bookings.updateBookingStatus(crypto.randomUUID(), 'Confirmed'), null);
    });

    it('rejects statuses longer than 50 characters', async () => {
      const b = await bookings.createBooking(business.id, { clientPhone: '919000000021' });
      await assert.rejects(bookings.updateBookingStatus(b.id, 'x'.repeat(51)), { status: 400 });
    });
  });

  describe('logMessage', () => {
    it('stores a message with client phone and optional booking', async () => {
      const m = await bookings.logMessage(null, 'inbound', 'hello', 'greeting', '919000000030');
      assert.equal(m.booking_id, null);
      assert.equal(m.client_phone, '919000000030');
      assert.equal(m.intent, 'greeting');
    });

    it('rejects an invalid direction or empty content', async () => {
      await assert.rejects(bookings.logMessage(null, 'sideways', 'x'), { status: 400 });
      await assert.rejects(bookings.logMessage(null, 'inbound', ''), { status: 400 });
    });
  });
});
