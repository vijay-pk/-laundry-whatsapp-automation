/**
 * Unit tests: src/services/locationResolver.js with an injected fetch (no network, no database)
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.GEOCODER_MIN_INTERVAL_MS = '0';
process.env.GEOCODER_BASE_URL = 'https://geocoder.test';

const { resolveMapsLink, clearLocationCache } = require('../../src/services/locationResolver');

// Fake fetch: routes by URL, records calls.
const fakeFetch = (routes) => {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = routes.find(([match]) => (typeof match === 'string' ? url.startsWith(match) : match.test(url)));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    const { status = 200, location, json } = route[1](url);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? location ?? null : null) },
      body: { cancel: async () => {} },
      json: async () => json,
    };
  };
  impl.calls = calls;
  return impl;
};

const geocoderQuery = (url) => new URL(url).searchParams.get('q');

describe('resolveMapsLink', () => {
  beforeEach(() => clearLocationCache());

  it('returns null when the text has no Google Maps link', async () => {
    const fetchImpl = fakeFetch([]);
    assert.equal(await resolveMapsLink('12 MG Road', { fetchImpl }), null);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('reads coordinates from a full link without any network call', async () => {
    const fetchImpl = fakeFetch([]);
    const result = await resolveMapsLink('https://www.google.com/maps/search/13.0235,+77.6375', { fetchImpl });
    assert.deepEqual(result, {
      latitude: 13.0235, longitude: 77.6375, link: 'https://www.google.com/maps/search/13.0235,+77.6375', precision: 'exact', uncertaintyKm: 0,
    });
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('expands a short link through redirects and reads the coordinates', async () => {
    const fetchImpl = fakeFetch([
      ['https://maps.app.goo.gl/abc', () => ({ status: 302, location: 'https://www.google.com/maps/search/13.0235,+77.6375?entry=tts' })],
    ]);
    const result = await resolveMapsLink('https://maps.app.goo.gl/abc?g_st=aw', { fetchImpl });

    assert.equal(result.precision, 'exact');
    assert.equal(result.latitude, 13.0235);
    assert.equal(fetchImpl.calls[0].options.redirect, 'manual');
  });

  it('never follows a redirect to a non-Google host', async () => {
    const fetchImpl = fakeFetch([
      ['https://maps.app.goo.gl/evil', () => ({ status: 302, location: 'http://169.254.169.254/latest/meta-data/' })],
    ]);
    assert.equal(await resolveMapsLink('https://maps.app.goo.gl/evil', { fetchImpl }), null);
    assert.equal(fetchImpl.calls.length, 1, 'only the short link was requested');
  });

  it('geocodes a place link without coordinates as approximate', async () => {
    const fetchImpl = fakeFetch([
      ['https://maps.app.goo.gl/place', () => ({
        status: 302,
        location: 'https://www.google.com/maps/place/Olive+Cafe+-+Kammanahalli,+Papaiah+Road,+Kamanahalli,+Bengaluru,+Karnataka+560084/data=!4m2',
      })],
      ['https://geocoder.test/search', (url) => {
        const q = geocoderQuery(url);
        return q.startsWith('Olive Cafe')
          ? { json: [] } // first, most specific query: not found
          : { json: [{ lat: '13.0150', lon: '77.6380', addresstype: 'road', display_name: 'Papaiah Road, Kammanahalli' }] };
      }],
    ]);

    const result = await resolveMapsLink('https://maps.app.goo.gl/place', { fetchImpl });
    assert.equal(result.precision, 'approximate');
    assert.equal(result.uncertaintyKm, 0.5, 'street-level result');
    assert.equal(result.latitude, 13.015);
    assert.equal(result.label, 'Papaiah Road, Kammanahalli');

    const geocoderCalls = fetchImpl.calls.filter((c) => c.url.startsWith('https://geocoder.test'));
    assert.equal(geocoderCalls.length, 2);
    assert.match(geocoderCalls[0].options.headers['User-Agent'], /laundry-whatsapp-automation/);
  });

  it('uses a larger uncertainty for area-level results', async () => {
    const fetchImpl = fakeFetch([
      ['https://geocoder.test/search', () => ({ json: [{ lat: '13.015', lon: '77.638', addresstype: 'suburb', display_name: 'Kammanahalli' }] })],
    ]);
    const result = await resolveMapsLink('https://www.google.com/maps/place/Kammanahalli,+Bengaluru,+Karnataka', { fetchImpl });
    assert.equal(result.uncertaintyKm, 2);
  });

  it('rejects city-level results as too coarse', async () => {
    const fetchImpl = fakeFetch([
      ['https://geocoder.test/search', () => ({ json: [{ lat: '12.97', lon: '77.59', addresstype: 'city', display_name: 'Bengaluru' }] })],
    ]);
    assert.equal(await resolveMapsLink('https://maps.google.com/?q=Somewhere,+Bengaluru,+Karnataka', { fetchImpl }), null);
  });

  it('returns null (never throws) when the network fails', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    assert.equal(await resolveMapsLink('https://maps.app.goo.gl/down', { fetchImpl }), null);
    assert.equal(await resolveMapsLink('https://www.google.com/maps/place/Shop,+Road,+Bengaluru,+Karnataka', { fetchImpl }), null);
  });

  it('caches lookups for the same link', async () => {
    const fetchImpl = fakeFetch([
      ['https://maps.app.goo.gl/cache', () => ({ status: 302, location: 'https://maps.google.com/?q=13.0235,77.6375' })],
    ]);
    await resolveMapsLink('https://maps.app.goo.gl/cache', { fetchImpl });
    await resolveMapsLink('https://maps.app.goo.gl/cache', { fetchImpl });
    assert.equal(fetchImpl.calls.length, 1);
  });
});
