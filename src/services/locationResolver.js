/**
 * src/services/locationResolver.js
 * Turn a Google Maps link pasted in chat into coordinates:
 *   1. read coordinates straight from the link, else
 *   2. follow short-link redirects (maps.app.goo.gl -> google.com/maps/...) and read them there, else
 *   3. geocode the place name from the link with OpenStreetMap Nominatim (approximate).
 *
 * Network access is restricted to Google Maps hosts (redirects) and the geocoder.
 * Never throws: returns null when no location can be determined.
 */

const { extractMapsUrl, isAllowedMapsUrl, parseCoordinatesFromUrl, placeQueriesFromUrl } = require('../utils/mapsLink');
const { parseCoordinates } = require('../utils/geo');

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 6000;
// Nominatim usage policy: max 1 request per second (overridable for tests against a mock geocoder)
const geocodeIntervalMs = () => {
  const value = Number(process.env.GEOCODER_MIN_INTERVAL_MS);
  return Number.isFinite(value) && value >= 0 ? value : 1100;
};

// Short links carry no location themselves; only these are expanded over the network.
const SHORT_LINK_HOST = /^(maps\.app\.goo\.gl|goo\.gl)$/i;
const isShortLink = (link) => SHORT_LINK_HOST.test(new URL(link).hostname);

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

// Geocoder results too coarse to decide a 5 km radius (a whole city or bigger).
const TOO_COARSE = new Set(['country', 'state', 'state_district', 'region', 'county', 'city', 'municipality', 'postcode']);

// Uncertainty of geocoded points by result type, in km (street/building-level vs area-level).
const PRECISE_TYPES = new Set(['amenity', 'building', 'shop', 'office', 'tourism', 'leisure', 'house', 'road', 'place']);
const approximationKm = (addressType) => (PRECISE_TYPES.has(addressType) ? 0.5 : 2);

const geocoderBaseUrl = () => process.env.GEOCODER_BASE_URL || 'https://nominatim.openstreetmap.org';
const geocoderUserAgent = () =>
  process.env.GEOCODER_USER_AGENT || 'laundry-whatsapp-automation/1.0 (+https://github.com/vijay-pk/-laundry-whatsapp-automation)';

// ---------------------------------------------------------------------------
// 2. Helpers
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> { value, expires }

const cached = async (key, compute) => {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const value = await compute();
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
};

const fetchWithTimeout = async (fetchImpl, url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Follow redirects manually so every hop can be checked against the Google Maps host allowlist.
 * @returns {Promise<string[]>} every URL visited, starting with the original
 */
const followRedirects = async (startUrl, fetchImpl) => {
  const visited = [startUrl];
  let current = startUrl;

  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const response = await fetchWithTimeout(fetchImpl, current, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; laundry-whatsapp-automation)' },
    });
    await response.body?.cancel?.().catch(() => {}); // only the Location header matters

    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;

    const next = new URL(location, current).toString();
    if (!isAllowedMapsUrl(next)) break; // never leave Google Maps hosts
    visited.push(next);
    // Stop once we reach a full Google Maps URL: its page doesn't reliably contain the place.
    if (parseCoordinatesFromUrl(next) || !isShortLink(next)) break;
    current = next;
  }
  return visited;
};

// Serialize geocoder calls to respect the 1 request/second policy.
let geocodeQueue = Promise.resolve();
let lastGeocodeAt = 0;

const geocode = (query, fetchImpl) =>
  cached(`geocode:${query}`, () => {
    const run = async () => {
      const wait = lastGeocodeAt + geocodeIntervalMs() - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastGeocodeAt = Date.now();

      const url = new URL('/search', geocoderBaseUrl());
      url.search = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', addressdetails: '0' }).toString();

      const response = await fetchWithTimeout(fetchImpl, url.toString(), {
        headers: { 'User-Agent': geocoderUserAgent(), 'Accept-Language': 'en' },
      });
      if (!response.ok) throw new Error(`geocoder HTTP ${response.status}`);

      const [result] = await response.json();
      if (!result || TOO_COARSE.has(result.addresstype)) return null;

      const coords = parseCoordinates(result.lat, result.lon);
      return coords ? { ...coords, addressType: result.addresstype, label: result.display_name } : null;
    };
    const job = geocodeQueue.then(run, run);
    geocodeQueue = job.catch(() => {});
    return job;
  });

// ---------------------------------------------------------------------------
// 3. Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the first Google Maps link in a message.
 * @param {string} text  customer message
 * @param {{fetchImpl?: typeof fetch}} [options]  injectable fetch (tests)
 * @returns {Promise<null | {
 *   latitude: number, longitude: number, link: string,
 *   precision: 'exact' | 'approximate', uncertaintyKm: number, label?: string
 * }>}
 */
const resolveMapsLink = async (text, { fetchImpl = fetch } = {}) => {
  const link = extractMapsUrl(text);
  if (!link) return null;

  try {
    // 1. Coordinates in the pasted link itself
    const direct = parseCoordinatesFromUrl(link);
    if (direct) return { ...direct, link, precision: 'exact', uncertaintyKm: 0 };

    // 2. Short link -> expanded Google Maps URL (full links are not fetched: their pages
    //    show a map around the requester, not the place, so they add nothing reliable)
    const urls = isShortLink(link)
      ? await cached(`redirects:${link}`, () => followRedirects(link, fetchImpl))
      : [link];
    for (const url of urls) {
      const coords = parseCoordinatesFromUrl(url);
      if (coords) return { ...coords, link, precision: 'exact', uncertaintyKm: 0 };
    }

    // 3. Place link without coordinates -> geocode its name (approximate)
    const queries = [...new Set(urls.flatMap((url) => placeQueriesFromUrl(url)))].slice(0, 5);
    for (const query of queries) {
      const result = await geocode(query, fetchImpl);
      if (result) {
        return {
          latitude: result.latitude,
          longitude: result.longitude,
          link,
          precision: 'approximate',
          uncertaintyKm: approximationKm(result.addressType),
          label: result.label,
        };
      }
    }
  } catch (err) {
    console.error(`[location] Could not resolve maps link: ${err.message}`);
  }
  return null;
};

// Tests only: forget cached lookups.
const clearLocationCache = () => cache.clear();

module.exports = { resolveMapsLink, clearLocationCache };
