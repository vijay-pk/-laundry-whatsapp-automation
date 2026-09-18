/**
 * Unit tests: src/utils/mapsLink.js (no network, no database)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowedMapsUrl, extractMapsUrl, parseCoordinatesFromUrl, placeQueriesFromUrl } = require('../../src/utils/mapsLink');

const HERE = { latitude: 13.0235, longitude: 77.6375 };

describe('extractMapsUrl', () => {
  it('finds Google Maps links inside a message', () => {
    assert.equal(extractMapsUrl('my place https://maps.app.goo.gl/Ay7yM8DajPXUUmTh9?g_st=aw thanks'), 'https://maps.app.goo.gl/Ay7yM8DajPXUUmTh9?g_st=aw');
    assert.equal(extractMapsUrl('https://goo.gl/maps/abc123'), 'https://goo.gl/maps/abc123');
    assert.equal(extractMapsUrl('https://www.google.com/maps/search/13.0235,+77.6375'), 'https://www.google.com/maps/search/13.0235,+77.6375');
    assert.equal(extractMapsUrl('https://maps.google.co.in/?q=13.0235,77.6375'), 'https://maps.google.co.in/?q=13.0235,77.6375');
  });

  it('ignores other links and look-alike hosts', () => {
    assert.equal(extractMapsUrl('see https://example.com/maps/place/x'), null);
    assert.equal(extractMapsUrl('https://maps.app.goo.gl.evil.com/abc'), null);
    assert.equal(extractMapsUrl('https://evil.com/?u=https://maps.google.com'), null);
    assert.equal(extractMapsUrl('no link here'), null);
    assert.equal(extractMapsUrl(undefined), null);
  });
});

describe('isAllowedMapsUrl', () => {
  it('allows only Google Maps hosts over http(s)', () => {
    assert.equal(isAllowedMapsUrl('https://www.google.com/maps/place/x'), true);
    assert.equal(isAllowedMapsUrl('https://google.co.in/maps'), true);
    assert.equal(isAllowedMapsUrl('https://127.0.0.1/maps'), false);
    assert.equal(isAllowedMapsUrl('http://localhost:5433/'), false);
    assert.equal(isAllowedMapsUrl('file:///C:/secrets'), false);
    assert.equal(isAllowedMapsUrl('not a url'), false);
  });
});

describe('parseCoordinatesFromUrl', () => {
  const cases = [
    ['?q=lat,lng', 'https://maps.google.com/?q=13.0235,77.6375'],
    ['?q=lat,+lng (space)', 'https://maps.google.com/maps?q=13.0235,+77.6375&z=17'],
    ['?query=', 'https://www.google.com/maps/search/?api=1&query=13.0235,77.6375'],
    ['?ll=', 'https://maps.google.com/?ll=13.0235,77.6375&z=15'],
    ['/search/lat,+lng', 'https://www.google.com/maps/search/13.0235,+77.6375?entry=tts'],
    ['/place/lat,lng', 'https://www.google.com/maps/place/13.0235,77.6375'],
    ['!3d!4d pin', 'https://www.google.com/maps/place/Shop/@13.1,77.1,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d13.0235!4d77.6375'],
    ['@viewport', 'https://www.google.com/maps/@13.0235,77.6375,15z'],
    ['DMS', "https://www.google.com/maps/place/13%C2%B001'24.6%22N+77%C2%B038'15.0%22E"],
    ['encoded consent redirect', 'https://consent.google.com/ml?continue=https://www.google.com/maps/search/13.0235,%2B77.6375%3Fentry%3Dtts'],
  ];

  for (const [name, url] of cases) {
    it(`reads ${name}`, () => {
      const coords = parseCoordinatesFromUrl(url);
      assert.ok(coords, 'coordinates found');
      assert.ok(Math.abs(coords.latitude - HERE.latitude) < 0.001 && Math.abs(coords.longitude - HERE.longitude) < 0.001, JSON.stringify(coords));
    });
  }

  it('prefers the exact pin (!3d!4d) over the viewport (@)', () => {
    const coords = parseCoordinatesFromUrl('https://www.google.com/maps/place/Shop/@12.9,77.5,17z/data=!3d13.0235!4d77.6375');
    assert.deepEqual(coords, HERE);
  });

  it('returns null for links without coordinates or with invalid ones', () => {
    assert.equal(parseCoordinatesFromUrl('https://www.google.com/maps/place/Olive+Cafe/data=!4m2!3m1!1s0x3bae:0x1'), null);
    assert.equal(parseCoordinatesFromUrl('https://maps.google.com/?q=95.1,77.1'), null);
  });
});

describe('placeQueriesFromUrl', () => {
  it('builds geocoder queries from a place name, most specific first, without noise', () => {
    const url =
      'https://www.google.com/maps/place/Olive+Street+Food+Cafe+-+Kammanahalli,+Building+No+%2012%2F3,Papaiah+Road,Kamanahalli,+near+Dr+Raj+Kumar+Park,+St+Thomas+Town,+post,+Bengaluru,+Karnataka+560084/data=!4m2';

    assert.deepEqual(placeQueriesFromUrl(url), [
      'Olive Street Food Cafe - Kammanahalli, Papaiah Road, Kamanahalli, St Thomas Town, Bengaluru, Karnataka 560084',
      'Papaiah Road, Kamanahalli, St Thomas Town, Bengaluru, Karnataka 560084',
      'Kammanahalli, Bengaluru, Karnataka 560084',
      'Kamanahalli, St Thomas Town, Bengaluru, Karnataka 560084',
      'St Thomas Town, Bengaluru, Karnataka 560084',
    ]);
  });

  it('handles an encoded "/" inside the place name', () => {
    const queries = placeQueriesFromUrl('https://www.google.com/maps/place/Shop+12%2F3,+MG+Road,+Bengaluru,+Karnataka/data=!4m2');
    assert.equal(queries[0], 'Shop 12/3, MG Road, Bengaluru, Karnataka');
  });

  it('uses the q parameter and never whole-city-only queries', () => {
    assert.deepEqual(placeQueriesFromUrl('https://maps.google.com/?q=Indiranagar,+Bengaluru,+Karnataka'), ['Indiranagar, Bengaluru, Karnataka']);
    assert.deepEqual(placeQueriesFromUrl('https://maps.google.com/?q=Bengaluru'), ['Bengaluru']);
  });

  it('returns [] for coordinate links and links without a place', () => {
    assert.deepEqual(placeQueriesFromUrl('https://maps.google.com/?q=13.0235,77.6375'), []);
    assert.deepEqual(placeQueriesFromUrl('https://www.google.com/maps/@13.02,77.63,15z'), []);
    assert.deepEqual(placeQueriesFromUrl('garbage'), []);
  });
});
