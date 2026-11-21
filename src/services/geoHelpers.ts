import { normalizeAzimuthDeg } from '../math/geodesy';

export {
  WGS84_A,
  WGS84_F,
  WGS84_E2,
  EARTH_MEAN_RADIUS_KM,
  normalizeLonDeg,
  normalizeAzimuthDeg,
  geodeticToEcef,
  ecefToEnu,
  haversineDistanceKm,
  computeBearingDeg,
  greatCircleDestination,
  computeTopocentricLookAngles,
  pointInGeoJsonPolygon,
  pointInGeoJsonFeature,
} from '../math/geodesy';

/**
 * Convert compass bearing [0, 360) to 8-point cardinal direction string.
 */
export function bearingToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const idx = Math.round(normalizeAzimuthDeg(deg) / 45) % 8;
  return dirs[idx];
}
