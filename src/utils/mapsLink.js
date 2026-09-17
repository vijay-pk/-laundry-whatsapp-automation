/**
 * src/utils/mapsLink.js
 * Pure helpers for Google Maps links customers paste instead of sharing a
 * WhatsApp location: find the link, read coordinates from it, or build a
 * place-name search when the link has no coordinates.
 */

const { parseCoordinates } = require('./geo');

// Only these hosts are ever fetched or trusted (prevents requests to arbitrary servers).
const ALLOWED_HOST = /^(maps\.app\.goo\.gl|goo\.gl|(www\.|maps\.)?google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2}))$/i;

const MAPS_URL_IN_TEXT =
  // Must start the message, or follow a space/bracket (not be embedded inside another URL)
  /(?<=^|[\s(])https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6})[^\s<>"]*/i;

const isAllowedMapsUrl = (value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && ALLOWED_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

// First Google Maps link in a message, or null.
const extractMapsUrl = (text) => {
  const match = String(text ?? '').match(MAPS_URL_IN_TEXT);
  return match && isAllowedMapsUrl(match[0]) ? match[0] : null;
};

// Decode repeatedly: consent/redirect pages wrap the real URL in encoded parameters.
const fullyDecode = (value) => {
  let current = String(value);
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(current.replace(/\+/g, ' '));
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
};

// 13°01'24.6"N 77°38'15.0"E -> decimal degrees
const dmsToDecimal = (deg, min, sec, hemisphere) => {
  const value = Number(deg) + Number(min) / 60 + Number(sec) / 3600;
  return /[SW]/i.test(hemisphere) ? -value : value;
};

const NUM = '(-?\\d{1,3}\\.\\d+)';
const COORDINATE_PATTERNS = [
  // Exact place pin inside the data parameter
  new RegExp(`!3d${NUM}!4d${NUM}`),
  // ?q=13.02,77.63  ?query=  ?ll=  ?center=  ?destination=
  new RegExp(`[?&](?:q|query|ll|center|destination|daddr|sll)=(?:loc:)?\\s*${NUM}\\s*,\\s*\\+?\\s*${NUM}`),
  // /maps/search/13.02,+77.63  /maps/place/13.02,77.63  /maps/dir//13.02,77.63
  new RegExp(`/(?:search|place|dir/)/?${NUM}\\s*,\\s*\\+?\\s*${NUM}`),
  // Map viewport centre: /@13.02,77.63,17z (least precise, last)
  new RegExp(`/@${NUM},${NUM}`),
];

/**
 * Coordinates embedded in a Google Maps URL, or null.
 * @returns {{latitude: number, longitude: number} | null}
 */
const parseCoordinatesFromUrl = (value) => {
  const decoded = fullyDecode(value);

  for (const pattern of COORDINATE_PATTERNS) {
    const match = decoded.match(pattern);
    if (match) {
      const coords = parseCoordinates(match[1], match[2]);
      if (coords) return coords;
    }
  }

  const dms = decoded.match(/(\d{1,3})°(\d{1,2})'(\d{1,2}(?:\.\d+)?)"?\s*([NS])[\s,+]*(\d{1,3})°(\d{1,2})'(\d{1,2}(?:\.\d+)?)"?\s*([EW])/i);
  if (dms) {
    return parseCoordinates(dmsToDecimal(dms[1], dms[2], dms[3], dms[4]), dmsToDecimal(dms[5], dms[6], dms[7], dms[8]));
  }
  return null;
};

// Address parts that confuse geocoders ("near X", "Building No 12", "post", bare numbers).
const NOISE_SEGMENT = /^(near |opp\.? |opposite |behind |building|bldg|no\.? ?\d|post$|\d+$)/i;

/**
 * Place-name search queries from a place link without coordinates, most specific first.
 * e.g. /maps/place/Olive+Cafe+-+Kammanahalli,+Papaiah+Road,+Bengaluru,+Karnataka+560084/data=...
 * @returns {string[]} up to `max` queries
 */
// Place name from /maps/place/<name>/... or ?q=<name>. Taken from the still-encoded
// path so names containing "/" ("Building No 12/3" = %2F) aren't cut short.
const placeNameFromUrl = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/');
  const index = parts.findIndex((p) => p.toLowerCase() === 'place');
  if (index >= 0 && parts[index + 1]) return fullyDecode(parts[index + 1]);

  const q = url.searchParams.get('q') || url.searchParams.get('query');
  return q ? q.trim() : null;
};

const placeQueriesFromUrl = (value, max = 5) => {
  const name = placeNameFromUrl(value);
  if (!name || /^-?\d/.test(name.trim())) return [];

  const segments = name
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !NOISE_SEGMENT.test(s));
  if (segments.length === 0) return [];

  const queries = [];
  const add = (parts) => {
    const q = parts.join(', ');
    if (q && !queries.includes(q)) queries.push(q);
  };

  // Full name, then progressively drop the most specific leading parts
  // (keeping at least 3 parts: "Bengaluru, Karnataka" alone is a whole city).
  const tails = [];
  for (let i = 0; i <= segments.length - 3; i += 1) tails.push(segments.slice(i));
  tails.slice(0, 2).forEach(add);

  // "Business - Area" in the first segment: try "Area, <city, state>".
  const area = segments[0].split(/\s+-\s+/)[1];
  if (area && segments.length > 2) add([area, ...segments.slice(-2)]);

  tails.slice(2).forEach(add);

  if (segments.length === 1) add(segments);
  return queries.slice(0, max);
};

module.exports = {
  ALLOWED_HOST,
  isAllowedMapsUrl,
  extractMapsUrl,
  parseCoordinatesFromUrl,
  placeQueriesFromUrl,
};
