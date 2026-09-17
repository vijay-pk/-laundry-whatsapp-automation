/**
 * src/utils/geo.js
 * Geofencing helpers: distance between coordinates and service-area config.
 */

const EARTH_RADIUS_KM = 6371.0088; // mean Earth radius

const DEFAULT_RADIUS_KM = 5;

const toRadians = (degrees) => (degrees * Math.PI) / 180;

/**
 * Great-circle distance between two points using the Haversine formula.
 * Accurate to well under 1% at city scale, which is plenty for a 5 km radius.
 * @returns {number} distance in kilometres
 */
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

/**
 * Validate and normalize a coordinate pair (numbers or numeric strings).
 * @returns {{latitude: number, longitude: number} | null}
 */
const parseCoordinates = (latitude, longitude) => {
  if (latitude === null || latitude === undefined || latitude === '') return null;
  if (longitude === null || longitude === undefined || longitude === '') return null;

  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { latitude: lat, longitude: lng };
};

/**
 * Service-area config from the environment (read on every call so .env changes apply).
 * Geofencing is enabled only when BUSINESS_LAT and BUSINESS_LNG are valid.
 * @returns {{enabled: boolean, latitude?: number, longitude?: number, radiusKm: number}}
 */
const getServiceArea = () => {
  const center = parseCoordinates(process.env.BUSINESS_LAT, process.env.BUSINESS_LNG);
  const radius = Number(process.env.MAX_DELIVERY_RADIUS_KM);
  const radiusKm = Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_RADIUS_KM;

  return center ? { enabled: true, ...center, radiusKm } : { enabled: false, radiusKm };
};

/**
 * Check a customer's location against the service area.
 * @returns {{distanceKm: number, withinRadius: boolean, radiusKm: number}}
 */
const checkServiceArea = (latitude, longitude, area = getServiceArea()) => {
  const distanceKm = haversineKm(area.latitude, area.longitude, latitude, longitude);
  return {
    distanceKm: Math.round(distanceKm * 100) / 100, // 2 decimals, matches distance_km column
    withinRadius: distanceKm <= area.radiusKm,
    radiusKm: area.radiusKm,
  };
};

// Google Maps link that opens a pin at the coordinates.
const mapsLink = (latitude, longitude) =>
  `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

module.exports = { haversineKm, parseCoordinates, getServiceArea, checkServiceArea, mapsLink };
