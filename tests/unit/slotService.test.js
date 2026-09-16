/**
 * Unit tests: src/services/slotService.js (no database needed)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { listSlots, findSlot, timeLabel } = require('../../src/services/slotService');

const kb = {
  pickupSlots: [
    { start: '10:00', end: '12:00' },
    { start: '16:00', end: '18:00' },
  ],
  slotDaysAhead: 3,
  closedWeekdays: [0], // Sunday
  minLeadMinutes: 60,
};

const IST = 'Asia/Kolkata';

describe('timeLabel', () => {
  it('formats 12-hour labels', () => {
    assert.equal(timeLabel('10:00'), '10 AM');
    assert.equal(timeLabel('12:00'), '12 PM');
    assert.equal(timeLabel('00:00'), '12 AM');
    assert.equal(timeLabel('16:30'), '4:30 PM');
  });
});

describe('listSlots', () => {
  it('offers today, tomorrow and the day after with timezone-correct instants', () => {
    // Thursday 17 Sep 2026, 08:00 IST
    const slots = listSlots({ now: new Date('2026-09-17T02:30:00Z'), kb, timeZone: IST });

    assert.deepEqual(slots.map((s) => s.id), [
      'slot_2026-09-17_1000', 'slot_2026-09-17_1600',
      'slot_2026-09-18_1000', 'slot_2026-09-18_1600',
      'slot_2026-09-19_1000', 'slot_2026-09-19_1600',
    ]);
    assert.equal(slots[0].start, '2026-09-17T04:30:00.000Z', '10:00 IST = 04:30 UTC');
    assert.equal(slots[0].end, '2026-09-17T06:30:00.000Z');
    assert.equal(slots[0].title, 'Today, 10 AM-12 PM');
    assert.equal(slots[2].title, 'Tomorrow, 10 AM-12 PM');
    assert.equal(slots[4].title, 'Sat 19, 10 AM-12 PM');
    assert.equal(slots[4].description, 'Saturday, 19 September');
  });

  it('skips slots starting within the lead time', () => {
    // 09:30 IST: the 10:00 slot starts in 30 minutes (< 60)
    const slots = listSlots({ now: new Date('2026-09-17T04:00:00Z'), kb, timeZone: IST });
    assert.equal(slots[0].id, 'slot_2026-09-17_1600');
  });

  it('skips closed weekdays', () => {
    // Saturday 19 Sep, 20:00 IST: Sunday closed -> Monday only
    const slots = listSlots({ now: new Date('2026-09-19T14:30:00Z'), kb, timeZone: IST });
    assert.deepEqual(slots.map((s) => s.id), ['slot_2026-09-21_1000', 'slot_2026-09-21_1600']);
  });

  it('uses the local date, not the UTC date', () => {
    // 23:30 UTC on 16 Sep is already 05:00 IST on 17 Sep
    const slots = listSlots({ now: new Date('2026-09-16T23:30:00Z'), kb, timeZone: IST });
    assert.equal(slots[0].id, 'slot_2026-09-17_1000');
    assert.equal(slots[0].title, 'Today, 10 AM-12 PM');
  });

  it('works in UTC', () => {
    const slots = listSlots({ now: new Date('2026-09-17T00:00:00Z'), kb, timeZone: 'UTC' });
    assert.equal(slots[0].start, '2026-09-17T10:00:00.000Z');
  });

  it('respects the max limit (WhatsApp lists allow 10 rows)', () => {
    const many = { ...kb, slotDaysAhead: 30, closedWeekdays: [] };
    assert.equal(listSlots({ now: new Date('2026-09-17T00:00:00Z'), kb: many, timeZone: IST }).length, 10);
  });

  it('keeps titles within the 24-character list row limit', () => {
    const slots = listSlots({ now: new Date('2026-09-17T00:00:00Z'), kb: { ...kb, slotDaysAhead: 10, closedWeekdays: [] }, timeZone: IST });
    for (const slot of slots) assert.ok(slot.title.length <= 24, slot.title);
  });

  it('returns [] when nothing is configured', () => {
    assert.deepEqual(listSlots({ kb: { ...kb, pickupSlots: [] }, timeZone: IST }), []);
  });
});

describe('findSlot', () => {
  const now = new Date('2026-09-17T02:30:00Z');

  it('finds a currently offered slot', () => {
    assert.equal(findSlot('slot_2026-09-18_1600', { now, kb, timeZone: IST }).start, '2026-09-18T10:30:00.000Z');
  });

  it('rejects past, closed-day, unknown or forged ids', () => {
    const later = new Date('2026-09-17T12:00:00Z'); // 17:30 IST
    assert.equal(findSlot('slot_2026-09-17_1000', { now: later, kb, timeZone: IST }), null, 'past');
    assert.equal(findSlot('slot_2026-09-20_1000', { now, kb, timeZone: IST }), null, 'Sunday');
    assert.equal(findSlot('slot_2026-09-18_0300', { now, kb, timeZone: IST }), null, 'not a window');
    assert.equal(findSlot('slot_2030-01-01_1000', { now, kb, timeZone: IST }), null, 'too far');
  });
});
