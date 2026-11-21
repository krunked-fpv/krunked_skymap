import type { TopocentricCoords } from '../types/sky-contracts';

/** WGS-84 equatorial semi-major axis in meters. */
export const WGS84_A = 6378137.0;

/** WGS-84 flattening factor. */
export const WGS84_F = 1 / 298.257223563;

/** WGS-84 first eccentricity squared: f * (2 - f). */
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** WGS-84 polar semi-minor axis in meters. */
export const WGS84_B = WGS84_A * (1 - WGS84_F);

/** IUGG / WGS-84 mean Earth radius in kilometers. */
export const EARTH_MEAN_RADIUS_KM = 6371.0088;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const ANT_EPS = 1e-11;

/** Clamp latitude in degrees to [-90, 90], guarding non-finite inputs. */
export function clampLatDeg(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return Math.max(-90, Math.min(90, lat));
}

/** Normalize longitude in degrees strictly into [-180, 180], guarding non-finite inputs. */
export function normalizeLonDeg(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  if (lon >= -180 && lon <= 180) {
    return lon === 0 ? 0 : lon;
  }
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === 0 ? 0 : wrapped;
}

/** Normalize an azimuth or bearing angle in degrees into [0, 360). */
export function normalizeAzimuthDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped >= 360 || wrapped === 0 ? 0 : wrapped;
}

/** Convert WGS-84 geodetic coordinates (deg, deg, m) into ECEF coordinates in meters. */
export function geodeticToEcef(
  latDeg: number,
  lonDeg: number,
  altM: number
): { x: number; y: number; z: number } {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return { x: 0, y: 0, z: 0 };
  }
  const alt = Number.isFinite(altM) ? altM : 0;
  const latRad = clampLatDeg(latDeg) * DEG_TO_RAD;
  const lonRad = normalizeLonDeg(lonDeg) * DEG_TO_RAD;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    x: (n + alt) * cosLat * cosLon,
    y: (n + alt) * cosLat * sinLon,
    z: (n * (1 - WGS84_E2) + alt) * sinLat,
  };
}

/** Rotate an ECEF delta vector (dx, dy, dz) in meters into the observer's local East-North-Up frame. */
export function ecefToEnu(
  dx: number,
  dy: number,
  dz: number,
  obsLatDeg: number,
  obsLonDeg: number
): { e: number; n: number; u: number } {
  if (
    !Number.isFinite(dx) ||
    !Number.isFinite(dy) ||
    !Number.isFinite(dz) ||
    !Number.isFinite(obsLatDeg) ||
    !Number.isFinite(obsLonDeg)
  ) {
    return { e: 0, n: 0, u: 0 };
  }
  const latRad = clampLatDeg(obsLatDeg) * DEG_TO_RAD;
  const lonRad = normalizeLonDeg(obsLonDeg) * DEG_TO_RAD;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  return {
    e: -sinLon * dx + cosLon * dy,
    n: -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz,
    u: cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz,
  };
}

/**
 * Compute exact WGS-84 topocentric look angles (azimuth, elevation, slant range, ground distance)
 * from an observer to a target, with optional Bennett atmospheric refraction near the horizon.
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

  const slantRangeM = Math.hypot(dx, dy, dz);
  const groundDistKm = haversineDistanceKm(observer.lat, observer.lon, target.lat, target.lon);

  if (slantRangeM < 1e-6) {
    return {
      azimuthDeg: 0,
      elevationDeg: 0,
      slantRangeKm: 0,
      groundDistKm,
      belowHorizon: false,
    };
  }

  const { e, n, u } = ecefToEnu(dx, dy, dz, observer.lat, observer.lon);
  const horizM = Math.hypot(e, n);

  let elevationDeg = Math.atan2(u, horizM) * RAD_TO_DEG;
  const azimuthDeg = horizM < 1e-9 ? 0 : normalizeAzimuthDeg(Math.atan2(e, n) * RAD_TO_DEG);

  // Apply Bennett atmospheric refraction with a smooth ramp across [-2.0, -0.5] deg near the horizon.
  if (applyRefraction && elevationDeg > -2.0 && elevationDeg < 89.8) {
    const ramp = elevationDeg >= -0.5 ? 1 : Math.max(0, Math.min(1, (elevationDeg + 2.0) / 1.5));
    const argDeg = elevationDeg + 7.31 / (elevationDeg + 4.4);
    const refractionDeg = (1 / Math.tan(argDeg * DEG_TO_RAD) / 60) * ramp;
    if (Number.isFinite(refractionDeg) && refractionDeg > 0) {
      elevationDeg = Math.min(90, elevationDeg + refractionDeg);
    }
  }

  elevationDeg = Math.max(-90, Math.min(90, elevationDeg));
  const slantRangeKm = slantRangeM / 1000;

  return {
    azimuthDeg,
    elevationDeg,
    slantRangeKm,
    groundDistKm,
    belowHorizon: elevationDeg < 0,
  };
}

/** Great-circle surface distance in kilometers between two lat/lon points via the Haversine formula. */
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

  const phi1 = clampLatDeg(lat1) * DEG_TO_RAD;
  const phi2 = clampLatDeg(lat2) * DEG_TO_RAD;
  const dPhi = phi2 - phi1;
  const dLambda = (normalizeLonDeg(lon2) - normalizeLonDeg(lon1)) * DEG_TO_RAD;

  const sinHalfLat = Math.sin(dPhi / 2);
  const sinHalfLon = Math.sin(dLambda / 2);
  const a = Math.min(
    1,
    Math.max(0, sinHalfLat * sinHalfLat + Math.cos(phi1) * Math.cos(phi2) * sinHalfLon * sinHalfLon)
  );
  return 2 * EARTH_MEAN_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Forward geodesic destination along a great circle given initial bearing (deg) and distance (km). */
export function greatCircleDestination(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distKm: number
): { lat: number; lon: number } {
  const safeLat = clampLatDeg(latDeg);
  const safeLon = normalizeLonDeg(lonDeg);
  if (!Number.isFinite(distKm) || !Number.isFinite(bearingDeg) || distKm === 0) {
    return { lat: safeLat, lon: safeLon };
  }

  const angularDist = distKm / EARTH_MEAN_RADIUS_KM;
  const brngRad = bearingDeg * DEG_TO_RAD;
  const phi1 = safeLat * DEG_TO_RAD;
  const lambda1 = safeLon * DEG_TO_RAD;

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(angularDist);
  const cosDelta = Math.cos(angularDist);

  const sinPhi2 = Math.max(-1, Math.min(1, sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(brngRad)));
  const phi2 = Math.asin(sinPhi2);
  const y = Math.sin(brngRad) * sinDelta * cosPhi1;
  const x = cosDelta - sinPhi1 * sinPhi2;
  const lambda2 = lambda1 + Math.atan2(y, x);

  return {
    lat: clampLatDeg(phi2 * RAD_TO_DEG),
    lon: normalizeLonDeg(lambda2 * RAD_TO_DEG),
  };
}

/** Compute initial great-circle bearing in degrees [0, 360) from point 1 to point 2. */
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

  const nLat1 = clampLatDeg(lat1);
  const nLon1 = normalizeLonDeg(lon1);
  const nLat2 = clampLatDeg(lat2);
  const nLon2 = normalizeLonDeg(lon2);

  if (Math.abs(nLat1 - nLat2) < 1e-12 && Math.abs(normalizeLonDeg(nLon2 - nLon1)) < 1e-12) {
    return 0;
  }

  const phi1 = nLat1 * DEG_TO_RAD;
  const phi2 = nLat2 * DEG_TO_RAD;
  const dLambda = (nLon2 - nLon1) * DEG_TO_RAD;

  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  if (Math.abs(x) < 1e-15 && Math.abs(y) < 1e-15) {
    return 0;
  }

  return normalizeAzimuthDeg(Math.atan2(y, x) * RAD_TO_DEG);
}

/**
 * Split a [lon, lat] polyline at +-180 deg whenever consecutive longitudes jump by > 180 deg,
 * interpolating the exact crossing latitude so MapLibre never draws cross-world streaks.
 */
export function splitAntimeridianLine(
  coords: Array<[number, number]>
): Array<Array<[number, number]>> {
  const clean: Array<[number, number]> = [];
  for (let i = 0; i < coords.length; i++) {
    const pt = coords[i];
    if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
    clean.push([normalizeLonDeg(pt[0]), clampLatDeg(pt[1])]);
  }

  if (clean.length === 0) return [];
  if (clean.length === 1) return [clean];

  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [clean[0]];

  for (let i = 1; i < clean.length; i++) {
    const [lonA, latA] = current[current.length - 1];
    const [lonB, latB] = clean[i];
    const diff = lonB - lonA;

    if (Math.abs(diff) > 180) {
      if (diff < -180) {
        // Crossing East across +180 -> -180.
        const lonBUnwrapped = lonB + 360;
        const span = lonBUnwrapped - lonA;
        const t = span > 1e-12 ? (180 - lonA) / span : 0;
        const crossLat = clampLatDeg(latA + t * (latB - latA));

        if (Math.abs(lonA - 180) > ANT_EPS) {
          current.push([180, crossLat]);
        }
        if (current.length >= 2) {
          segments.push(current);
        }
        current = [[-180, crossLat]];
        if (Math.abs(lonB + 180) > ANT_EPS || Math.abs(latB - crossLat) > ANT_EPS) {
          current.push([lonB, latB]);
        }
      } else {
        // Crossing West across -180 -> +180.
        const lonBUnwrapped = lonB - 360;
        const span = lonBUnwrapped - lonA;
        const t = Math.abs(span) > 1e-12 ? (-180 - lonA) / span : 0;
        const crossLat = clampLatDeg(latA + t * (latB - latA));

        if (Math.abs(lonA + 180) > ANT_EPS) {
          current.push([-180, crossLat]);
        }
        if (current.length >= 2) {
          segments.push(current);
        }
        current = [[180, crossLat]];
        if (Math.abs(lonB - 180) > ANT_EPS || Math.abs(latB - crossLat) > ANT_EPS) {
          current.push([lonB, latB]);
        }
      }
    } else {
      current.push([lonB, latB]);
    }
  }

  if (current.length >= 2 || (segments.length === 0 && current.length >= 1)) {
    segments.push(current);
  }

  return segments;
}

function clipRingMinLon(poly: Array<[number, number]>, minLon: number): Array<[number, number]> {
  if (poly.length === 0) return [];
  const output: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const currIn = curr[0] >= minLon;
    const prevIn = prev[0] >= minLon;

    if (currIn !== prevIn) {
      const dx = curr[0] - prev[0];
      const t = Math.abs(dx) > 1e-12 ? (minLon - prev[0]) / dx : 0;
      output.push([minLon, prev[1] + t * (curr[1] - prev[1])]);
    }
    if (currIn) {
      output.push(curr);
    }
  }
  return output;
}

function clipRingMaxLon(poly: Array<[number, number]>, maxLon: number): Array<[number, number]> {
  if (poly.length === 0) return [];
  const output: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const curr = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const currIn = curr[0] <= maxLon;
    const prevIn = prev[0] <= maxLon;

    if (currIn !== prevIn) {
      const dx = curr[0] - prev[0];
      const t = Math.abs(dx) > 1e-12 ? (maxLon - prev[0]) / dx : 0;
      output.push([maxLon, prev[1] + t * (curr[1] - prev[1])]);
    }
    if (currIn) {
      output.push(curr);
    }
  }
  return output;
}

function finalizeClosedRing(pts: Array<[number, number]>, shiftLon: number): Array<[number, number]> | null {
  if (pts.length < 3) return null;
  const deduped: Array<[number, number]> = [];
  for (const [lon, lat] of pts) {
    const shiftedLon = Math.max(-180, Math.min(180, lon + shiftLon));
    const clampedLat = clampLatDeg(lat);
    const last = deduped[deduped.length - 1];
    if (!last || Math.abs(last[0] - shiftedLon) > 1e-10 || Math.abs(last[1] - clampedLat) > 1e-10) {
      deduped.push([shiftedLon, clampedLat]);
    }
  }
  if (deduped.length < 3) return null;
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (Math.abs(first[0] - last[0]) > 1e-10 || Math.abs(first[1] - last[1]) > 1e-10) {
    deduped.push([first[0], first[1]]);
  } else {
    deduped[deduped.length - 1] = [first[0], first[1]];
  }
  return deduped.length >= 4 ? deduped : null;
}

/**
 * Build closed geodesic circle polygon ring(s) safely around +-180 deg longitude (and poles).
 * Returns an array of closed [lon, lat] exterior rings suitable for GeoJSON Polygon or MultiPolygon.
 */
export function geodesicCirclePolygon(
  latDeg: number,
  lonDeg: number,
  radiusKm: number,
  steps = 72
): Array<Array<[number, number]>> {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || !Number.isFinite(radiusKm) || radiusKm <= 0) {
    return [];
  }

  const centerLat = clampLatDeg(latDeg);
  const centerLon = normalizeLonDeg(lonDeg);
  const nSteps = Math.max(8, Math.floor(Number.isFinite(steps) ? steps : 72));
  const maxRadiusKm = Math.PI * EARTH_MEAN_RADIUS_KM - 0.1;
  const cappedRadiusKm = Math.min(radiusKm, maxRadiusKm);

  const rawPoints: Array<[number, number]> = [];
  for (let i = 0; i < nSteps; i++) {
    // Counterclockwise sweep in (lon, lat) space (N -> W -> S -> E -> N)
    const bearing = (360 - (i * 360) / nSteps) % 360;
    const dest = greatCircleDestination(centerLat, centerLon, bearing, cappedRadiusKm);
    rawPoints.push([dest.lon, dest.lat]);
  }

  const angularDeg = (cappedRadiusKm / EARTH_MEAN_RADIUS_KM) * RAD_TO_DEG;
  const enclosesNorthPole = centerLat + angularDeg >= 90 - 1e-9;
  const enclosesSouthPole = centerLat - angularDeg <= -90 + 1e-9;

  if (enclosesNorthPole || enclosesSouthPole) {
    const poleLat = enclosesNorthPole ? 90 : -90;
    const split = splitAntimeridianLine([...rawPoints, rawPoints[0]]);
    if (split.length >= 2) {
      const ordered = [...split[split.length - 1], ...split[0].slice(1)];
      for (let i = 1; i < split.length - 1; i++) {
        ordered.push(...split[i].slice(1));
      }
      const startPt = ordered[0];
      const endPt = ordered[ordered.length - 1];
      const endEdgeLon = endPt[0] < 0 ? -180 : 180;
      const startEdgeLon = startPt[0] < 0 ? -180 : 180;
      ordered.push([endEdgeLon, poleLat]);
      if (startEdgeLon !== endEdgeLon) {
        const midSteps = endEdgeLon < startEdgeLon ? [-90, 0, 90] : [90, 0, -90];
        for (const lonStep of midSteps) {
          ordered.push([lonStep, poleLat]);
        }
        ordered.push([startEdgeLon, poleLat]);
      }
      const closed = finalizeClosedRing(ordered, 0);
      return closed ? [closed] : [];
    }
    const closed = finalizeClosedRing(rawPoints, 0);
    return closed ? [closed] : [];
  }

  // Unwrap continuous longitudes relative to centerLon for planar clipping across +-180 slabs.
  const unwrapped: Array<[number, number]> = [];
  let minLon = Infinity;
  let maxLon = -Infinity;

  for (let i = 0; i < rawPoints.length; i++) {
    const [lon, lat] = rawPoints[i];
    const refLon = i === 0 ? centerLon : unwrapped[i - 1][0];
    let adjLon = lon;
    while (adjLon - refLon > 180) adjLon -= 360;
    while (adjLon - refLon < -180) adjLon += 360;
    unwrapped.push([adjLon, lat]);
    if (adjLon < minLon) minLon = adjLon;
    if (adjLon > maxLon) maxLon = adjLon;
  }

  if (minLon >= -180 && maxLon <= 180) {
    const single = finalizeClosedRing(unwrapped, 0);
    return single ? [single] : [];
  }

  const rings: Array<Array<[number, number]>> = [];
  const minK = Math.floor((minLon + 180) / 360);
  const maxK = Math.floor((maxLon + 180) / 360);

  for (let k = minK; k <= maxK; k++) {
    const slabMin = k * 360 - 180;
    const slabMax = k * 360 + 180;
    const clipped = clipRingMaxLon(clipRingMinLon(unwrapped, slabMin), slabMax);
    const finalized = finalizeClosedRing(clipped, -k * 360);
    if (finalized) {
      rings.push(finalized);
    }
  }

  return rings;
}

function isPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  const minX = Math.min(x1, x2) - ANT_EPS;
  const maxX = Math.max(x1, x2) + ANT_EPS;
  const minY = Math.min(y1, y2) - ANT_EPS;
  const maxY = Math.max(y1, y2) + ANT_EPS;
  if (px < minX || px > maxX || py < minY || py > maxY) {
    return false;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < ANT_EPS * ANT_EPS) {
    return Math.hypot(px - x1, py - y1) <= ANT_EPS;
  }
  const cross = Math.abs((px - x1) * dy - (py - y1) * dx);
  return cross / Math.sqrt(lenSq) <= ANT_EPS;
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
    if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(xj) || !Number.isFinite(yj)) {
      continue;
    }
    if (isPointOnSegment(lon, lat, xi, yi, xj, yj)) {
      return true;
    }
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygonRings(lon: number, lat: number, rings: number[][][]): boolean {
  if (!Array.isArray(rings) || rings.length === 0) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lon, lat, rings[i])) {
      return false;
    }
  }
  return true;
}

/** Test whether a geographic point (lon, lat) falls inside a GeoJSON Polygon or MultiPolygon (respecting holes). */
export function pointInGeoJsonPolygon(
  lon: number,
  lat: number,
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  if (!geometry || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return false;
  }
  const normLon = normalizeLonDeg(lon);
  const clampedLat = clampLatDeg(lat);

  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(normLon, clampedLat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    for (let i = 0; i < geometry.coordinates.length; i++) {
      if (pointInPolygonRings(normLon, clampedLat, geometry.coordinates[i])) {
        return true;
      }
    }
  }
  return false;
}

/** Test whether a geographic point (lon, lat) falls inside a GeoJSON Feature's Polygon or MultiPolygon geometry. */
export function pointInGeoJsonFeature(
  lon: number,
  lat: number,
  feature: GeoJSON.Feature
): boolean {
  if (!feature || !feature.geometry || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return false;
  }
  const geom = feature.geometry;
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    return pointInGeoJsonPolygon(lon, lat, geom);
  }
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    for (let i = 0; i < geom.geometries.length; i++) {
      const sub = geom.geometries[i];
      if ((sub.type === 'Polygon' || sub.type === 'MultiPolygon') && pointInGeoJsonPolygon(lon, lat, sub)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Extrapolate a target's geodetic position and altitude forward/backward over dtSec
 * using spherical great-circle dead reckoning and vertical rate.
 */
export function extrapolateDeadReckoning(
  latDeg: number,
  lonDeg: number,
  speedMs: number,
  headingDeg: number,
  dtSec: number,
  altM = 0,
  vertRateMs = 0
): { lat: number; lon: number; altM: number } {
  const safeLat = clampLatDeg(latDeg);
  const safeLon = normalizeLonDeg(lonDeg);
  const safeSpeed = Number.isFinite(speedMs) ? speedMs : 0;
  const safeHeading = Number.isFinite(headingDeg) ? headingDeg : 0;
  const safeDt = Number.isFinite(dtSec) ? dtSec : 0;
  const safeAlt = Number.isFinite(altM) ? altM : 0;
  const safeVert = Number.isFinite(vertRateMs) ? vertRateMs : 0;

  const distKm = (safeSpeed * safeDt) / 1000;
  const dest =
    distKm === 0 ? { lat: safeLat, lon: safeLon } : greatCircleDestination(safeLat, safeLon, safeHeading, distKm);

  const rawAlt = safeAlt + safeVert * safeDt;
  const nextAltM = safeAlt >= 0 && safeDt >= 0 ? Math.max(0, rawAlt) : rawAlt;

  return {
    lat: dest.lat,
    lon: dest.lon,
    altM: nextAltM,
  };
}
