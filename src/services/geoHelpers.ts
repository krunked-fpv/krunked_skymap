import type { TopocentricCoords } from '../types/sky-contracts';

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);
export const EARTH_MEAN_RADIUS_KM = 6371.0088;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Wrap longitude into [-180, 180] degrees cleanly.
 */
export function normalizeLonDeg(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  if (lon >= -180 && lon <= 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180 && lon > 0) return 180;
  return wrapped;
}

/**
 * Wrap azimuth/bearing into [0, 360) degrees cleanly.
 */
export function normalizeAzimuthDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}

/**
 * Convert WGS-84 geodetic coordinates (deg, deg, meters) to ECEF (meters).
 */
export function geodeticToEcef(
  latDeg: number,
  lonDeg: number,
  altM: number
): { x: number; y: number; z: number } {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + altM) * cosLat * cosLon,
    y: (n + altM) * cosLat * sinLon,
    z: (n * (1 - WGS84_E2) + altM) * sinLat,
  };
}

/**
 * Rotate ECEF delta vector into local East-North-Up (ENU) frame at observer.
 */
export function ecefToEnu(
  dx: number,
  dy: number,
  dz: number,
  obsLatDeg: number,
  obsLonDeg: number
): { e: number; n: number; u: number } {
  const lat = obsLatDeg * DEG_TO_RAD;
  const lon = obsLonDeg * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon);
  const cosLon = Math.cos(lon);

  return {
    e: -sinLon * dx + cosLon * dy,
    n: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
    u: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
  };
}

/**
 * Compute great-circle surface distance in kilometers using the Haversine formula.
 */
export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return 0;
  }

  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const a = sinDLat * sinDLat + Math.cos(phi1) * Math.cos(phi2) * sinDLon * sinDLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_MEAN_RADIUS_KM * c;
}

/**
 * Compute forward initial bearing in degrees [0, 360) from point 1 to point 2.
 */
export function computeBearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return 0;
  }
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return normalizeAzimuthDeg(Math.atan2(y, x) * RAD_TO_DEG);
}

/**
 * Compute destination latitude/longitude along a great circle from start point.
 */
export function greatCircleDestination(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distKm: number
): { lat: number; lon: number } {
  if (
    !Number.isFinite(latDeg) ||
    !Number.isFinite(lonDeg) ||
    !Number.isFinite(bearingDeg) ||
    !Number.isFinite(distKm) ||
    distKm === 0
  ) {
    return { lat: latDeg || 0, lon: normalizeLonDeg(lonDeg || 0) };
  }

  const delta = distKm / EARTH_MEAN_RADIUS_KM;
  const theta = bearingDeg * DEG_TO_RAD;
  const phi1 = latDeg * DEG_TO_RAD;
  const lambda1 = lonDeg * DEG_TO_RAD;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);

  const sinPhi2 = Math.max(-1, Math.min(1, sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta)));
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(theta) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  return {
    lat: phi2 * RAD_TO_DEG,
    lon: normalizeLonDeg(lambda2 * RAD_TO_DEG),
  };
}

/**
 * Compute WGS-84 topocentric look angles (azimuth, elevation, slant range, ground dist).
 * Self-contained WGS-84 ellipsoidal ECEF->ENU implementation for standalone service compilation.
 */
export function computeTopocentricLookAngles(
  observer: { lat: number; lon: number; altM: number },
  target: { lat: number; lon: number; altM: number },
  applyRefraction = false
): TopocentricCoords {
  if (
    !Number.isFinite(observer.lat) ||
    !Number.isFinite(observer.lon) ||
    !Number.isFinite(target.lat) ||
    !Number.isFinite(target.lon)
  ) {
    return {
      azimuthDeg: 0,
      elevationDeg: 0,
      slantRangeKm: 0,
      groundDistKm: 0,
      belowHorizon: false,
    };
  }

  const obsAltM = Number.isFinite(observer.altM) ? observer.altM : 0;
  const tgtAltM = Number.isFinite(target.altM) ? target.altM : 0;

  const obsEcef = geodeticToEcef(observer.lat, observer.lon, obsAltM);
  const tgtEcef = geodeticToEcef(target.lat, target.lon, tgtAltM);
  const dx = tgtEcef.x - obsEcef.x;
  const dy = tgtEcef.y - obsEcef.y;
  const dz = tgtEcef.z - obsEcef.z;

  const slantM = Math.hypot(dx, dy, dz);
  const groundDistKm = haversineDistanceKm(observer.lat, observer.lon, target.lat, target.lon);

  if (slantM < 1e-6) {
    return {
      azimuthDeg: 0,
      elevationDeg: 0,
      slantRangeKm: 0,
      groundDistKm: 0,
      belowHorizon: false,
    };
  }

  const { e, n, u } = ecefToEnu(dx, dy, dz, observer.lat, observer.lon);
  const horizM = Math.hypot(e, n);
  const azimuthDeg = horizM < 1e-9 ? 0 : normalizeAzimuthDeg(Math.atan2(e, n) * RAD_TO_DEG);
  let elevationDeg = Math.atan2(u, horizM) * RAD_TO_DEG;

  if (applyRefraction && elevationDeg > -1 && elevationDeg < 89.9) {
    const argDeg = elevationDeg + 10.3 / (elevationDeg + 5.11);
    const refrArcMin = 1.02 / Math.tan(argDeg * DEG_TO_RAD);
    elevationDeg = Math.min(90, elevationDeg + refrArcMin / 60);
  }

  return {
    azimuthDeg,
    elevationDeg,
    slantRangeKm: slantM / 1000,
    groundDistKm,
    belowHorizon: elevationDeg < 0,
  };
}

function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ptI = ring[i];
    const ptJ = ring[j];
    if (!ptI || !ptJ) continue;
    const xi = ptI[0];
    const yi = ptI[1];
    const xj = ptJ[0];
    const yj = ptJ[1];
    if (
      !Number.isFinite(xi) ||
      !Number.isFinite(yi) ||
      !Number.isFinite(xj) ||
      !Number.isFinite(yj)
    ) {
      continue;
    }

    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lon: number, lat: number, rings: number[][][]): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) return false;
  }
  return true;
}

/**
 * Check if [lon, lat] lies inside a GeoJSON Polygon or MultiPolygon (respecting holes).
 */
export function pointInGeoJsonPolygon(
  lon: number,
  lat: number,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lon, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) {
      if (pointInPolygonCoords(lon, lat, poly)) return true;
    }
  }
  return false;
}

/**
 * Check if [lon, lat] lies inside a GeoJSON Feature geometry.
 */
export function pointInGeoJsonFeature(
  lon: number,
  lat: number,
  feature: GeoJSON.Feature
): boolean {
  if (!feature || !feature.geometry) return false;
  const geom = feature.geometry;
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    return pointInGeoJsonPolygon(lon, lat, geom);
  }
  if (geom.type === 'GeometryCollection') {
    return geom.geometries.some(
      (g) =>
        (g.type === 'Polygon' || g.type === 'MultiPolygon') &&
        pointInGeoJsonPolygon(lon, lat, g)
    );
  }
  return false;
}

/**
 * Convert compass bearing [0, 360) to 8-point cardinal direction string.
 */
export function bearingToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(normalizeAzimuthDeg(deg) / 45) % 8;
  return dirs[idx];
}
