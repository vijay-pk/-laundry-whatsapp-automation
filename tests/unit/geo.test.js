/**
 * Unit tests: src/utils/geo.js (no database needed)
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { haversineKm, parseCoordinates, getServiceArea, checkServiceArea, mapsLink } = require('../../src/utils/geo');

const STORE = { latitude: 12.9716, longitude: 77.5946 }; // Bengaluru

describe('haversineKm', () => {
  it('is 0 for the same point', () => {
    assert.equal(haversineKm(12.9716, 77.5946, 12.9716, 77.5946), 0);
  });

  it('measures one degree of latitude as ~111.2 km', () => {
    assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.2) < 0.1);
  });

  it('matches a known city distance (Bengaluru -> Mysuru ≈ 128 km)', () => {
    const km = haversineKm(12.9716, 77.5946, 12.2958, 76.6394);
    assert.ok(km > 125 && km < 131, `${km}`);
  });

  it('is symmetric', () => {
    assert.equal(haversineKm(12.97, 77.59, 13.01, 77.62), haversineKm(13.01, 77.62, 12.97, 77.59));
  });
});

describe('parseCoordinates', () => {
  it('accepts numbers and numeric strings', () => {
    assert.deepEqual(parseCoordinates(12.5, '77.25'), { latitude: 12.5, longitude: 77.25 });
  });

  it('rejects missing, non-numeric and out-of-range values', () => {
    assert.equal(parseCoordinates(undefined, 77), null);
    assert.equal(parseCoordinates('', 77), null);
    assert.equal(parseCoordinates('abc', 77), null);
    assert.equal(parseCoordinates(91, 77), null);
    assert.equal(parseCoordinates(12, -181), null);
    assert.equal(parseCoordinates(NaN, 77), null);
  });
});

describe('getServiceArea', () => {
  const keys = ['BUSINESS_LAT', 'BUSINESS_LNG', 'MAX_DELIVERY_RADIUS_KM'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is disabled when the store location is not configured', () => {
    process.env.BUSINESS_LAT = '';
    process.env.BUSINESS_LNG = '';
    assert.equal(getServiceArea().enabled, false);
  });

  it('reads the store location and radius', () => {
    process.env.BUSINESS_LAT = '12.9716';
    process.env.BUSINESS_LNG = '77.5946';
    process.env.MAX_DELIVERY_RADIUS_KM = '7.5';
    assert.deepEqual(getServiceArea(), { enabled: true, latitude: 12.9716, longitude: 77.5946, radiusKm: 7.5 });
  });

  it('defaults the radius to 5 km when missing or invalid', () => {
    process.env.BUSINESS_LAT = '12.9716';
    process.env.BUSINESS_LNG = '77.5946';
    process.env.MAX_DELIVERY_RADIUS_KM = 'abc';
    assert.equal(getServiceArea().radiusKm, 5);
    process.env.MAX_DELIVERY_RADIUS_KM = '-3';
    assert.equal(getServiceArea().radiusKm, 5);
  });
});

describe('checkServiceArea', () => {
  const area = { enabled: true, ...STORE, radiusKm: 5 };

  it('accepts a location ~2 km away', () => {
    const result = checkServiceArea(STORE.latitude + 0.018, STORE.longitude, area);
    assert.equal(result.withinRadius, true);
    assert.ok(result.distanceKm > 1.9 && result.distanceKm < 2.1, `${result.distanceKm}`);
  });

  it('rejects a location ~10 km away', () => {
    const result = checkServiceArea(STORE.latitude + 0.09, STORE.longitude, area);
    assert.equal(result.withinRadius, false);
    assert.ok(result.distanceKm > 9.9 && result.distanceKm < 10.1);
  });

  it('includes a location exactly on the boundary (<= radius)', () => {
    const edge = { ...area, radiusKm: haversineKm(STORE.latitude, STORE.longitude, STORE.latitude + 0.04, STORE.longitude) };
    assert.equal(checkServiceArea(STORE.latitude + 0.04, STORE.longitude, edge).withinRadius, true);
  });

  it('rounds the distance to 2 decimals', () => {
    const { distanceKm } = checkServiceArea(STORE.latitude + 0.0123, STORE.longitude + 0.0077, area);
    assert.equal(distanceKm, Math.round(distanceKm * 100) / 100);
  });
});

describe('mapsLink', () => {
  it('builds a Google Maps search link', () => {
    assert.equal(mapsLink(12.9716, 77.5946), 'https://www.google.com/maps/search/?api=1&query=12.9716,77.5946');
  });
});
