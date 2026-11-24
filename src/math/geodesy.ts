import type {
  CelestialPositions,
  ClosestApproachPrediction,
  SkyDomeProjectionPoint,
  SkyDomeUnprojectionResult,
  SkyDomeZoomMode,
  TopocentricCoords,
  TwilightState,
} from '../types/sky-contracts';

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

/**
 * Signed shortest-arc angular delta from `fromDeg` to `toDeg` in degrees within (-180, 180].
 * Positive means clockwise rotation; negative means counter-clockwise.
 */
export function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  if (!Number.isFinite(fromDeg) || !Number.isFinite(toDeg)) return 0;
  let delta = normalizeAzimuthDeg(toDeg) - normalizeAzimuthDeg(fromDeg);
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  if (delta === -180) delta = 180;
  return delta === 0 ? 0 : delta;
}

/**
 * Wrap-safe circular low-pass filter for compass heading smoothing across the 359° <-> 0° seam.
 */
export function smoothCompassHeadingDeg(
  currentDeg: number,
  targetDeg: number,
  alpha = 0.18
): number {
  if (!Number.isFinite(targetDeg)) return normalizeAzimuthDeg(currentDeg);
  if (!Number.isFinite(currentDeg)) return normalizeAzimuthDeg(targetDeg);
  const clampedAlpha = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0.18;
  const base = normalizeAzimuthDeg(currentDeg);
  const delta = shortestAngleDeltaDeg(base, targetDeg);
  return normalizeAzimuthDeg(base + delta * clampedAlpha);
}

/**
 * Convert a W3C DeviceOrientation `alpha` angle (counter-clockwise yaw from North) and
 * screen orientation angle (e.g. 0, 90, 180, 270, or -90) into a clockwise compass heading in [0, 360).
 */
export function computeScreenCompensatedHeadingDeg(
  alphaDeg: number | null | undefined,
  screenOrientationDeg = 0
): number | null {
  if (typeof alphaDeg !== 'number' || !Number.isFinite(alphaDeg)) return null;
  const safeScreenDeg =
    typeof screenOrientationDeg === 'number' && Number.isFinite(screenOrientationDeg)
      ? screenOrientationDeg
      : 0;
  return normalizeAzimuthDeg(360 - alphaDeg + safeScreenDeg);
}

/**
 * Derive a clockwise compass heading in [0, 360) from browser DeviceOrientation fields,
 * preferring iOS `webkitCompassHeading` when valid and falling back to screen-compensated
 * absolute `alpha` (Android `deviceorientationabsolute`). Returns `null` if no absolute heading is available.
 */
export function deriveCompassHeadingDeg(
  reading:
    | {
        webkitCompassHeading?: number | null;
        alpha?: number | null;
        absolute?: boolean;
        screenAngle?: number;
        screenOrientationDeg?: number;
      }
    | null
    | undefined
): number | null {
  if (!reading) return null;
  if (
    typeof reading.webkitCompassHeading === 'number' &&
    Number.isFinite(reading.webkitCompassHeading) &&
    reading.webkitCompassHeading >= 0
  ) {
    return normalizeAzimuthDeg(reading.webkitCompassHeading);
  }
  if (reading.absolute === true) {
    const rawScreenAngle =
      typeof reading.screenOrientationDeg === 'number' && Number.isFinite(reading.screenOrientationDeg)
        ? reading.screenOrientationDeg
        : reading.screenAngle;
    return computeScreenCompensatedHeadingDeg(reading.alpha, rawScreenAngle);
  }
  return null;
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

/** Apply Bennett atmospheric refraction with a smooth ramp across [-2.0, -0.5] deg near the horizon. */
function applyBennettRefraction(elevationDeg: number): number {
  if (elevationDeg > -2.0 && elevationDeg < 89.8) {
    const ramp = elevationDeg >= -0.5 ? 1 : Math.max(0, Math.min(1, (elevationDeg + 2.0) / 1.5));
    const argDeg = elevationDeg + 7.31 / (elevationDeg + 4.4);
    const refractionDeg = (1 / Math.tan(argDeg * DEG_TO_RAD) / 60) * ramp;
    if (Number.isFinite(refractionDeg) && refractionDeg > 0) {
      return Math.min(90, elevationDeg + refractionDeg);
    }
  }
  return elevationDeg;
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

  if (applyRefraction) {
    elevationDeg = applyBennettRefraction(elevationDeg);
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

const VAULT_SPHERICAL_WEIGHT = 0.55;
const VAULT_LINEAR_WEIGHT = 0.45;
const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;

function skyDomeMinElevation(zoomMode: SkyDomeZoomMode): number {
  return zoomMode === 'zenith' ? 30 : 0;
}

function vaultCurveValue(elDeg: number): number {
  return VAULT_SPHERICAL_WEIGHT * Math.cos(elDeg * DEG_TO_RAD) + VAULT_LINEAR_WEIGHT * ((90 - elDeg) / 90);
}

/**
 * Map elevation in degrees to normalized 3D spherical/stereographic sky-dome radius [0, 1]
 * (0 at 90 deg Zenith, 1 at minEl rim: 0 deg in hemisphere mode, 30 deg in zenith mode).
 */
export function elevationToVaultNormR(elDeg: number, zoomMode: SkyDomeZoomMode = 'hemisphere'): number {
  const minEl = skyDomeMinElevation(zoomMode);
  if (!Number.isFinite(elDeg)) return 1;
  const clamped = Math.max(minEl, Math.min(90, elDeg));
  if (clamped >= 90) return 0;
  if (clamped <= minEl) return 1;
  return vaultCurveValue(clamped) / vaultCurveValue(minEl);
}

/**
 * Project topocentric (azDeg, elDeg) onto the circular sky-dome canvas with strict horizon/minEl culling.
 * When `rotationDeg` is set to heading theta, azimuth theta sits at 12 o'clock (top of dome).
 */
export function projectToSkyDome(
  azDeg: number,
  elDeg: number,
  cx: number,
  cy: number,
  radius: number,
  zoomMode: SkyDomeZoomMode = 'hemisphere',
  rotationDeg = 0
): SkyDomeProjectionPoint {
  const safeCx = Number.isFinite(cx) ? cx : 0;
  const safeCy = Number.isFinite(cy) ? cy : 0;
  const minEl = skyDomeMinElevation(zoomMode);
  if (
    !Number.isFinite(azDeg) ||
    !Number.isFinite(elDeg) ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    elDeg < minEl
  ) {
    return { x: safeCx, y: safeCy, r: 0, normR: 0, visible: false };
  }

  const safeRot = Number.isFinite(rotationDeg) ? normalizeAzimuthDeg(rotationDeg) : 0;
  const normR = elevationToVaultNormR(elDeg, zoomMode);
  const r = normR * radius;
  const displayAzDeg = normalizeAzimuthDeg(normalizeAzimuthDeg(azDeg) - safeRot);
  const theta = (displayAzDeg - 90) * DEG_TO_RAD;
  return {
    x: cx + r * Math.cos(theta),
    y: cy + r * Math.sin(theta),
    r,
    normR,
    visible: true,
  };
}

/**
 * Invert sky-dome canvas coordinates back to true topocentric (azimuthDeg, elevationDeg)
 * via safeguarded Newton-Raphson, accounting for `rotationDeg` heading orientation.
 */
export function unprojectFromSkyDome(
  px: number,
  py: number,
  cx: number,
  cy: number,
  radius: number,
  zoomMode: SkyDomeZoomMode = 'hemisphere',
  rotationDeg = 0
): SkyDomeUnprojectionResult {
  const minEl = skyDomeMinElevation(zoomMode);
  if (
    !Number.isFinite(px) ||
    !Number.isFinite(py) ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return { azimuthDeg: 0, elevationDeg: minEl, inBounds: false };
  }

  const safeRot = Number.isFinite(rotationDeg) ? normalizeAzimuthDeg(rotationDeg) : 0;
  const dx = px - cx;
  const dy = py - cy;
  const dist = Math.hypot(dx, dy);
  const azimuthDeg =
    dist < 1e-12 ? 0 : normalizeAzimuthDeg(Math.atan2(dy, dx) * RAD_TO_DEG + 90 + safeRot);
  const inBounds = dist <= radius + 1e-6;
  const normR = Math.max(0, Math.min(1, dist / radius));

  if (normR <= 0) {
    return { azimuthDeg, elevationDeg: 90, inBounds };
  }
  if (normR >= 1) {
    return { azimuthDeg, elevationDeg: minEl, inBounds };
  }

  const target = normR * vaultCurveValue(minEl);
  let lo = minEl;
  let hi = 90;
  let el = 90 - normR * (90 - minEl);

  for (let i = 0; i < 32; i++) {
    const val = vaultCurveValue(el) - target;
    if (Math.abs(val) < 1e-14) break;
    if (val > 0) {
      lo = el;
    } else {
      hi = el;
    }
    const deriv = -VAULT_SPHERICAL_WEIGHT * DEG_TO_RAD * Math.sin(el * DEG_TO_RAD) - VAULT_LINEAR_WEIGHT / 90;
    const next = el - val / deriv;
    if (Number.isFinite(next) && next > lo && next < hi) {
      const step = Math.abs(next - el);
      el = next;
      if (step < 1e-13) break;
    } else {
      const mid = 0.5 * (lo + hi);
      if (Math.abs(mid - el) < 1e-13) {
        el = mid;
        break;
      }
      el = mid;
    }
  }

  return {
    azimuthDeg,
    elevationDeg: Math.max(minEl, Math.min(90, el)),
    inBounds,
  };
}

/**
 * Singularity-free direct ENU projection onto the sky dome, remaining C1 smooth right through Zenith.
 */
export function projectEnuToSkyDome(
  e: number,
  n: number,
  u: number,
  cx: number,
  cy: number,
  radius: number,
  zoomMode: SkyDomeZoomMode = 'hemisphere',
  allowBelowMinEl = false,
  rotationDeg = 0
): SkyDomeProjectionPoint {
  const safeCx = Number.isFinite(cx) ? cx : 0;
  const safeCy = Number.isFinite(cy) ? cy : 0;
  if (
    !Number.isFinite(e) ||
    !Number.isFinite(n) ||
    !Number.isFinite(u) ||
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return { x: safeCx, y: safeCy, r: 0, normR: 0, visible: false };
  }

  const rho = Math.hypot(e, n, u);
  if (rho < 1e-9) {
    return { x: cx, y: cy, r: 0, normR: 0, visible: false };
  }

  const h = Math.hypot(e, n);
  const elDeg = Math.atan2(u, h) * RAD_TO_DEG;
  const minEl = skyDomeMinElevation(zoomMode);
  const visible = elDeg >= minEl;
  if (!visible && !allowBelowMinEl) {
    return { x: cx, y: cy, r: 0, normR: 0, visible: false };
  }

  const thetaZen = Math.atan2(h, u);
  // Use the analytical limit theta/h -> 1/rho near Zenith to avoid 0/0 cancellation.
  const thetaOverH =
    u >= 0 ? (h > 1e-6 * rho ? thetaZen / h : 1 / rho) : h > 1e-12 * rho ? thetaZen / h : 0;
  const scale = VAULT_SPHERICAL_WEIGHT / rho + (VAULT_LINEAR_WEIGHT / (Math.PI / 2)) * thetaOverH;
  const fMin = vaultCurveValue(minEl);
  const k = (radius / fMin) * scale;

  const dx0 = e === 0 ? 0 : k * e;
  const dy0 = n === 0 ? 0 : -k * n;
  const safeRot = Number.isFinite(rotationDeg) ? normalizeAzimuthDeg(rotationDeg) : 0;
  let dx = dx0;
  let dy = dy0;
  if (safeRot !== 0 && (dx0 !== 0 || dy0 !== 0)) {
    const phi = safeRot * DEG_TO_RAD;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    dx = dx0 * cosPhi + dy0 * sinPhi;
    dy = -dx0 * sinPhi + dy0 * cosPhi;
  }
  const r = Math.hypot(dx, dy);

  return {
    x: cx + dx,
    y: cy + dy,
    r,
    normR: radius > 0 ? r / radius : 0,
    visible,
  };
}

/**
 * Compute exact WGS-84 ENU position, velocity vector (m/s), and slant range (m) of a target
 * relative to an observer, preserving Earth curvature and meridian convergence.
 */
export function computeTargetEnuState(
  observer: { lat: number; lon: number; altM?: number },
  target: {
    lat: number;
    lon: number;
    altM?: number;
    speedMs?: number;
    headingDeg?: number;
    headingValid?: boolean;
    vertRateMs?: number;
  }
): { e: number; n: number; u: number; ve: number; vn: number; vu: number; slantRangeM: number } {
  if (
    !Number.isFinite(observer.lat) ||
    !Number.isFinite(observer.lon) ||
    !Number.isFinite(target.lat) ||
    !Number.isFinite(target.lon)
  ) {
    return { e: 0, n: 0, u: 0, ve: 0, vn: 0, vu: 0, slantRangeM: 0 };
  }

  const obsAltM = Number.isFinite(observer.altM) ? (observer.altM as number) : 0;
  const tgtAltM = Number.isFinite(target.altM) ? (target.altM as number) : 0;

  const obsEcef = geodeticToEcef(observer.lat, observer.lon, obsAltM);
  const tgtEcef = geodeticToEcef(target.lat, target.lon, tgtAltM);
  const { e, n, u } = ecefToEnu(
    tgtEcef.x - obsEcef.x,
    tgtEcef.y - obsEcef.y,
    tgtEcef.z - obsEcef.z,
    observer.lat,
    observer.lon
  );
  const slantRangeM = Math.hypot(e, n, u);

  if (
    target.headingValid === false ||
    !Number.isFinite(target.speedMs) ||
    (target.speedMs === 0 && !Number.isFinite(target.vertRateMs))
  ) {
    return { e, n, u, ve: 0, vn: 0, vu: 0, slantRangeM };
  }

  const safeSpeed = target.speedMs as number;
  const safeHeading = Number.isFinite(target.headingDeg) ? (target.headingDeg as number) : 0;
  const safeVertRate = Number.isFinite(target.vertRateMs) ? (target.vertRateMs as number) : 0;

  const nextPos = extrapolateDeadReckoning(target.lat, target.lon, safeSpeed, safeHeading, 1, tgtAltM, safeVertRate);
  const nextEcef = geodeticToEcef(nextPos.lat, nextPos.lon, nextPos.altM);
  const nextEnu = ecefToEnu(
    nextEcef.x - obsEcef.x,
    nextEcef.y - obsEcef.y,
    nextEcef.z - obsEcef.z,
    observer.lat,
    observer.lon
  );

  return {
    e,
    n,
    u,
    ve: nextEnu.e - e,
    vn: nextEnu.n - n,
    vu: nextEnu.u - u,
    slantRangeM,
  };
}

/**
 * Compute smooth sky-dome canvas rotation angle (radians, 0 = +X East, -pi/2 = -Y North)
 * via centered ENU finite difference without singularities across Zenith or Antimeridian.
 */
export function computeSkyDomeTrajectoryTangent(
  observer: { lat: number; lon: number; altM?: number },
  target: {
    lat: number;
    lon: number;
    altM?: number;
    speedMs?: number;
    headingDeg?: number;
    headingValid?: boolean;
    vertRateMs?: number;
  },
  cx: number,
  cy: number,
  radius: number,
  zoomMode: SkyDomeZoomMode = 'hemisphere',
  rotationDeg = 0
): number {
  const safeHeading = Number.isFinite(target.headingDeg)
    ? normalizeAzimuthDeg(target.headingDeg as number)
    : 0;
  const safeRot = Number.isFinite(rotationDeg) ? normalizeAzimuthDeg(rotationDeg) : 0;
  const fallbackRaw = (safeHeading - safeRot - 90) * DEG_TO_RAD;
  const fallbackAngle = Math.atan2(Math.sin(fallbackRaw), Math.cos(fallbackRaw));

  let state = computeTargetEnuState(observer, target);
  if (target.headingValid !== false && Math.hypot(state.ve, state.vn, state.vu) <= 0.1) {
    state = computeTargetEnuState(observer, { ...target, speedMs: 10, vertRateMs: 0 });
  }

  const { e, n, u, ve, vn, vu, slantRangeM } = state;
  const vMag = Math.hypot(ve, vn, vu);
  if (vMag < 1e-9 || slantRangeM < 1e-9 || !Number.isFinite(radius) || radius <= 0) {
    return fallbackAngle;
  }

  const dt = Math.max(0.25, Math.min(10, (0.005 * Math.max(100, slantRangeM)) / Math.max(1, vMag)));
  const half = 0.5 * dt;

  const pMinus = projectEnuToSkyDome(
    e - ve * half,
    n - vn * half,
    u - vu * half,
    cx,
    cy,
    radius,
    zoomMode,
    true,
    safeRot
  );
  const pPlus = projectEnuToSkyDome(
    e + ve * half,
    n + vn * half,
    u + vu * half,
    cx,
    cy,
    radius,
    zoomMode,
    true,
    safeRot
  );

  const dx = pPlus.x - pMinus.x;
  const dy = pPlus.y - pMinus.y;
  if (Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= 1e-9) {
    return Math.atan2(dy, dx);
  }
  return fallbackAngle;
}

/**
 * Compute zero-dependency analytical Sun & Moon topocentric (Az, El) with GMST rotation,
 * lunar horizontal parallax, Bennett atmospheric refraction, lunar illumination/phase, and twilight state.
 */
export function computeSolarLunarTopocentric(
  observer: { lat: number; lon: number; altM?: number },
  timestampMs: number
): CelestialPositions {
  const safeLat = Number.isFinite(observer.lat) ? Math.max(-89.9999, Math.min(89.9999, observer.lat)) : 0;
  const safeLon = normalizeLonDeg(observer.lon);
  const safeTsMs = Number.isFinite(timestampMs) ? timestampMs : 0;

  const jd = safeTsMs / 86_400_000 + 2440587.5;
  const d = jd - 2451545.0;
  const t = d / 36525.0;
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t2 * t2;

  const gmstDeg = normalizeAzimuthDeg(280.46061837 + 360.98564736629 * d + 0.000387933 * t2 - t3 / 38710000);
  const gmstRad = gmstDeg * DEG_TO_RAD;

  // Solar ephemeris (Meeus Ch. 25 / USNO, ~0.01 deg accuracy).
  const sunMeanAnom = (357.52911 + 35999.05029 * t - 0.0001537 * t2) * DEG_TO_RAD;
  const sunMeanLon = 280.46646 + 36000.76983 * t + 0.0003032 * t2;
  const sunCenter =
    (1.914602 - 0.004817 * t - 0.000014 * t2) * Math.sin(sunMeanAnom) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * sunMeanAnom) +
    0.000289 * Math.sin(3 * sunMeanAnom);
  const nodeOmega = (125.04 - 1934.136 * t) * DEG_TO_RAD;
  const lambdaSunDeg = normalizeAzimuthDeg(sunMeanLon + sunCenter - 0.00569 - 0.00478 * Math.sin(nodeOmega));
  const lambdaSunRad = lambdaSunDeg * DEG_TO_RAD;

  const eps0 = 23.43929111 - 0.013004167 * t - 1.6389e-7 * t2 + 5.036e-7 * t3;
  const epsRad = (eps0 + 0.00256 * Math.cos(nodeOmega)) * DEG_TO_RAD;

  const raSun = Math.atan2(Math.cos(epsRad) * Math.sin(lambdaSunRad), Math.cos(lambdaSunRad));
  const decSun = Math.asin(Math.max(-1, Math.min(1, Math.sin(epsRad) * Math.sin(lambdaSunRad))));

  // Lunar ephemeris (Meeus Ch. 47 6-term analytical series, ~0.2 deg accuracy).
  const moonMeanLon = 218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000;
  const moonElongD = (297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868) * DEG_TO_RAD;
  const sunAnomMs = (357.5291092 + 35999.0502909 * t - 0.0001536 * t2) * DEG_TO_RAD;
  const moonAnomMm = (134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699) * DEG_TO_RAD;
  const moonArgLatF = (93.272095 + 483202.0175233 * t - 0.0036539 * t2) * DEG_TO_RAD;

  const dLonMoon =
    6.288774 * Math.sin(moonAnomMm) +
    1.274027 * Math.sin(2 * moonElongD - moonAnomMm) +
    0.658314 * Math.sin(2 * moonElongD) +
    0.213618 * Math.sin(2 * moonAnomMm) -
    0.185116 * Math.sin(sunAnomMs) -
    0.114332 * Math.sin(2 * moonArgLatF);
  const dLatMoon =
    5.128122 * Math.sin(moonArgLatF) +
    0.280602 * Math.sin(moonAnomMm + moonArgLatF) +
    0.277693 * Math.sin(moonAnomMm - moonArgLatF) +
    0.173237 * Math.sin(2 * moonElongD - moonArgLatF);
  const rMoonKm =
    385000.56 -
    20905.355 * Math.cos(moonAnomMm) -
    3699.111 * Math.cos(2 * moonElongD - moonAnomMm) -
    2955.968 * Math.cos(2 * moonElongD) -
    569.925 * Math.cos(2 * moonAnomMm);

  const lambdaMoonDeg = normalizeAzimuthDeg(moonMeanLon + dLonMoon);
  const lambdaMoonRad = lambdaMoonDeg * DEG_TO_RAD;
  const betaMoonRad = dLatMoon * DEG_TO_RAD;

  const cosBeta = Math.cos(betaMoonRad);
  const sinBeta = Math.sin(betaMoonRad);
  const cosEps = Math.cos(epsRad);
  const sinEps = Math.sin(epsRad);

  const xEqMoon = cosBeta * Math.cos(lambdaMoonRad);
  const yEqMoon = cosEps * cosBeta * Math.sin(lambdaMoonRad) - sinEps * sinBeta;
  const zEqMoon = sinEps * cosBeta * Math.sin(lambdaMoonRad) + cosEps * sinBeta;
  const raMoon = Math.atan2(yEqMoon, xEqMoon);
  const decMoon = Math.asin(Math.max(-1, Math.min(1, zEqMoon)));

  const latRad = safeLat * DEG_TO_RAD;
  const lonRad = safeLon * DEG_TO_RAD;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);

  const equatorialToTopocentric = (ra: number, dec: number, moonDistKm?: number) => {
    const ha = gmstRad + lonRad - ra;
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);
    const east = -cosDec * Math.sin(ha);
    const north = cosLat * sinDec - sinLat * cosDec * Math.cos(ha);
    const up = sinLat * sinDec + cosLat * cosDec * Math.cos(ha);

    const horiz = Math.hypot(east, north);
    let elRad = Math.asin(Math.max(-1, Math.min(1, up)));
    if (moonDistKm !== undefined && moonDistKm > EARTH_EQUATORIAL_RADIUS_KM) {
      elRad -= Math.asin(EARTH_EQUATORIAL_RADIUS_KM / moonDistKm) * Math.cos(elRad);
    }
    const elDeg = Math.max(-90, Math.min(90, applyBennettRefraction(elRad * RAD_TO_DEG)));
    const azDeg = horiz < 1e-12 ? 0 : normalizeAzimuthDeg(Math.atan2(east, north) * RAD_TO_DEG);
    return { azimuthDeg: azDeg, elevationDeg: elDeg };
  };

  const sun = equatorialToTopocentric(raSun, decSun);
  const moonHoriz = equatorialToTopocentric(raMoon, decMoon, rMoonKm);

  const cosPsi = Math.max(
    -1,
    Math.min(1, Math.sin(decSun) * Math.sin(decMoon) + Math.cos(decSun) * Math.cos(decMoon) * Math.cos(raSun - raMoon))
  );
  const illuminationFraction = Math.max(0, Math.min(1, (1 - cosPsi) / 2));
  const phaseFraction = Math.max(0, Math.min(1, normalizeAzimuthDeg(lambdaMoonDeg - lambdaSunDeg) / 360));

  const twilightState: TwilightState =
    sun.elevationDeg >= 0
      ? 'day'
      : sun.elevationDeg >= -6
        ? 'civil-twilight'
        : sun.elevationDeg >= -12
          ? 'nautical-twilight'
          : 'night';

  return {
    sun,
    moon: {
      ...moonHoriz,
      phaseFraction,
      illuminationFraction,
    },
    twilightState,
  };
}

/**
 * Predict Time of Closest Approach (TCA) and peak topocentric elevation for a moving target
 * inside maxWindowSec using WGS-84 ENU state and dead-reckoned re-evaluation.
 */
export function computeClosestApproach(
  observer: { lat: number; lon: number; altM?: number },
  target: {
    lat: number;
    lon: number;
    altM?: number;
    speedMs?: number;
    headingDeg?: number;
    headingValid?: boolean;
    vertRateMs?: number;
  },
  maxWindowSec = 600
): ClosestApproachPrediction {
  const obsAltM = Number.isFinite(observer.altM) ? (observer.altM as number) : 0;
  const tgtAltM = Number.isFinite(target.altM) ? (target.altM as number) : 0;
  const lookNow = computeTopocentricLookAngles(
    { lat: observer.lat, lon: observer.lon, altM: obsAltM },
    { lat: target.lat, lon: target.lon, altM: tgtAltM },
    true
  );

  const nonApproaching: ClosestApproachPrediction = {
    isApproaching: false,
    tcaSeconds: 0,
    peakElevationDeg: lookNow.elevationDeg,
    minSlantRangeKm: lookNow.slantRangeKm,
    peakAzimuthDeg: lookNow.azimuthDeg,
  };

  const { e, n, u, ve, vn, vu, slantRangeM } = computeTargetEnuState(observer, target);
  const v2 = ve * ve + vn * vn + vu * vu;

  if (target.headingValid === false || !Number.isFinite(target.speedMs) || v2 < 1.0 || slantRangeM < 1e-3) {
    return nonApproaching;
  }

  const tauRaw = -(e * ve + n * vn + u * vu) / v2;
  if (!Number.isFinite(tauRaw) || tauRaw <= 0.5) {
    return nonApproaching;
  }

  const safeWindowSec = Number.isFinite(maxWindowSec) ? Math.max(0, maxWindowSec) : 0;
  const tcaSeconds = Math.min(safeWindowSec, tauRaw);
  const pred = extrapolateDeadReckoning(
    target.lat,
    target.lon,
    target.speedMs ?? 0,
    Number.isFinite(target.headingDeg) ? (target.headingDeg as number) : 0,
    tcaSeconds,
    tgtAltM,
    Number.isFinite(target.vertRateMs) ? (target.vertRateMs as number) : 0
  );
  const predLook = computeTopocentricLookAngles({ lat: observer.lat, lon: observer.lon, altM: obsAltM }, pred, true);
  const minSlantRangeKm = Math.min(lookNow.slantRangeKm, predLook.slantRangeKm);

  return {
    isApproaching: tcaSeconds > 0.5 && minSlantRangeKm < lookNow.slantRangeKm - 1e-6,
    tcaSeconds,
    peakElevationDeg: predLook.elevationDeg,
    minSlantRangeKm,
    peakAzimuthDeg: predLook.azimuthDeg,
  };
}
