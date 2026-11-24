import { describe, expect, it } from 'vitest';
import {
  WGS84_A,
  WGS84_E2,
  WGS84_F,
  computeBearingDeg,
  computeClosestApproach,
  computeSkyDomeTrajectoryTangent,
  computeSolarLunarTopocentric,
  computeTargetEnuState,
  computeTopocentricLookAngles,
  ecefToEnu,
  elevationToVaultNormR,
  extrapolateDeadReckoning,
  geodesicCirclePolygon,
  geodeticToEcef,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeLonDeg,
  pointInGeoJsonFeature,
  pointInGeoJsonPolygon,
  projectEnuToSkyDome,
  projectToSkyDome,
  splitAntimeridianLine,
  unprojectFromSkyDome,
} from '../../src/math/geodesy';
import {
  formatAltitude,
  formatAzEl,
  formatCoords,
  formatDistance,
  formatDoppler,
  formatSpeed,
  formatVerticalRate,
} from '../../src/math/units';
import {
  computeSatelliteOrbitOverlay,
  createAstroWorkerEngine,
  parseTleRecords,
  propagateSatellites,
  selectSatellitePool,
} from '../../src/workers/astro.worker';
import { AstroClient, unpackSatelliteKinematics } from '../../src/workers/astroClient';
import {
  SAT_KINEMATICS_STRIDE,
  type ObserverLocation,
  type TleRecord,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../../src/types/sky-contracts';

const ISS_TLE: TleRecord = {
  name: 'ISS (ZARYA)',
  noradId: 25544,
  group: 'stations',
  line1: '1 25544U 98067A   26324.50000000  .00016717  00000-0  30125-3 0  9998',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814500483410',
};

// 2026 day 324.50 UTC = 2026-11-20T12:00:00Z
const ISS_EPOCH_MS = Date.UTC(2026, 10, 20, 12, 0, 0);

const DC_OBSERVER: ObserverLocation = {
  lat: 38.8512,
  lon: -77.0402,
  altM: 12,
  label: 'DC / Potomac',
  source: 'preset',
};

describe('WGS-84 geodesy & coordinate transformations', () => {
  it('defines exact WGS-84 ellipsoid constants', () => {
    expect(WGS84_A).toBe(6378137.0);
    expect(WGS84_F).toBeCloseTo(1 / 298.257223563, 15);
    expect(WGS84_E2).toBeCloseTo(WGS84_F * (2 - WGS84_F), 15);
  });

  it('normalizes longitudes strictly into [-180, 180]', () => {
    expect(normalizeLonDeg(0)).toBe(0);
    expect(normalizeLonDeg(-0)).toBe(0);
    expect(normalizeLonDeg(180)).toBe(180);
    expect(normalizeLonDeg(-180)).toBe(-180);
    expect(normalizeLonDeg(181)).toBe(-179);
    expect(normalizeLonDeg(-181)).toBe(179);
    expect(normalizeLonDeg(360)).toBe(0);
    expect(normalizeLonDeg(-360)).toBe(0);
    expect(normalizeLonDeg(540)).toBe(-180);
    expect(normalizeLonDeg(Number.NaN)).toBe(0);
  });

  it('converts geodetic coordinates to ECEF and rotates ECEF deltas to ENU', () => {
    const eq = geodeticToEcef(0, 0, 0);
    expect(eq.x).toBeCloseTo(WGS84_A, 6);
    expect(eq.y).toBeCloseTo(0, 6);
    expect(eq.z).toBeCloseTo(0, 6);

    const pole = geodeticToEcef(90, 0, 0);
    expect(pole.x).toBeCloseTo(0, 5);
    expect(pole.y).toBeCloseTo(0, 5);
    expect(pole.z).toBeCloseTo(WGS84_A * (1 - WGS84_F), 5);

    const enu = ecefToEnu(0, 100, 200, 0, 0);
    expect(enu.e).toBeCloseTo(100, 9);
    expect(enu.n).toBeCloseTo(200, 9);
    expect(enu.u).toBeCloseTo(0, 9);
  });

  it('computes zenith El = 90 deg and guards zero-distance / NaN look angles', () => {
    const zenith = computeTopocentricLookAngles(
      { lat: 38.8512, lon: -77.0402, altM: 12 },
      { lat: 38.8512, lon: -77.0402, altM: 10012 }
    );
    expect(zenith.elevationDeg).toBeCloseTo(90, 8);
    expect(zenith.slantRangeKm).toBeCloseTo(10, 6);
    expect(zenith.groundDistKm).toBeCloseTo(0, 9);
    expect(zenith.belowHorizon).toBe(false);

    const colocated = computeTopocentricLookAngles(
      { lat: 38.8512, lon: -77.0402, altM: 12 },
      { lat: 38.8512, lon: -77.0402, altM: 12 }
    );
    expect(Number.isNaN(colocated.azimuthDeg)).toBe(false);
    expect(Number.isNaN(colocated.elevationDeg)).toBe(false);
    expect(colocated.slantRangeKm).toBe(0);
    expect(colocated.belowHorizon).toBe(false);

    const bad = computeTopocentricLookAngles(
      { lat: Number.NaN, lon: 0, altM: 0 },
      { lat: 10, lon: 10, altM: 1000 }
    );
    expect(bad.azimuthDeg).toBe(0);
    expect(bad.elevationDeg).toBe(0);
  });

  it('computes cardinal azimuths (0, 90, 180, 270 deg) accurately', () => {
    const obs = { lat: 0, lon: 0, altM: 0 };
    const north = greatCircleDestination(obs.lat, obs.lon, 0, 100);
    const east = greatCircleDestination(obs.lat, obs.lon, 90, 100);
    const south = greatCircleDestination(obs.lat, obs.lon, 180, 100);
    const west = greatCircleDestination(obs.lat, obs.lon, 270, 100);

    expect(computeTopocentricLookAngles(obs, { ...north, altM: 5000 }).azimuthDeg).toBeCloseTo(0, 2);
    expect(computeTopocentricLookAngles(obs, { ...east, altM: 5000 }).azimuthDeg).toBeCloseTo(90, 2);
    expect(computeTopocentricLookAngles(obs, { ...south, altM: 5000 }).azimuthDeg).toBeCloseTo(180, 2);
    expect(computeTopocentricLookAngles(obs, { ...west, altM: 5000 }).azimuthDeg).toBeCloseTo(270, 2);
  });

  it('models WGS-84 horizon drop-off at 250 km (1,500m -> El < 0, 12,000m -> El > 0)', () => {
    const obs = { lat: 38.8512, lon: -77.0402, altM: 0 };
    const target250Km = greatCircleDestination(obs.lat, obs.lon, 90, 250);

    const lowTarget = computeTopocentricLookAngles(obs, {
      lat: target250Km.lat,
      lon: target250Km.lon,
      altM: 1500,
    });
    expect(lowTarget.groundDistKm).toBeCloseTo(250, 1);
    expect(lowTarget.elevationDeg).toBeLessThan(0);
    expect(lowTarget.belowHorizon).toBe(true);

    const highTarget = computeTopocentricLookAngles(obs, {
      lat: target250Km.lat,
      lon: target250Km.lon,
      altM: 12000,
    });
    expect(highTarget.groundDistKm).toBeCloseTo(250, 1);
    expect(highTarget.elevationDeg).toBeGreaterThan(0);
    expect(highTarget.belowHorizon).toBe(false);
  });

  it('applies optional Bennett atmospheric refraction near horizon without altering zenith', () => {
    const obs = { lat: 0, lon: 0, altM: 0 };
    const distKm = 111.195;
    const tgtPos = greatCircleDestination(obs.lat, obs.lon, 90, distKm);
    // Geometric curvature drop at ~111 km is ~970 m -> target at 970 m is right near 0 deg elevation.
    const geom = computeTopocentricLookAngles(obs, { ...tgtPos, altM: 970 }, false);
    const refracted = computeTopocentricLookAngles(obs, { ...tgtPos, altM: 970 }, true);
    expect(refracted.elevationDeg).toBeGreaterThan(geom.elevationDeg);
    expect(refracted.elevationDeg - geom.elevationDeg).toBeCloseTo(0.57, 1);

    const zenithRef = computeTopocentricLookAngles(
      obs,
      { lat: 0, lon: 0, altM: 10000 },
      true
    );
    expect(zenithRef.elevationDeg).toBeCloseTo(90, 8);
  });

  it('computes Haversine, bearing, and great-circle destination round-trips', () => {
    const start = { lat: 35.5494, lon: 139.7798 };
    const dest = greatCircleDestination(start.lat, start.lon, 45, 250);
    expect(haversineDistanceKm(start.lat, start.lon, dest.lat, dest.lon)).toBeCloseTo(250, 2);
    expect(computeBearingDeg(start.lat, start.lon, dest.lat, dest.lon)).toBeCloseTo(45, 2);

    // Polar observer singularity check
    const southPoleLook = computeTopocentricLookAngles(
      { lat: -90, lon: 0, altM: 0 },
      { lat: -89, lon: 0, altM: 10000 }
    );
    expect(Number.isFinite(southPoleLook.azimuthDeg)).toBe(true);
    expect(southPoleLook.azimuthDeg).toBeCloseTo(0, 2);
  });

  it('splits polylines cleanly at the +-180 deg Antimeridian with exact interpolated latitude', () => {
    const eastbound = splitAntimeridianLine([
      [170, 10],
      [-160, 40],
    ]);
    expect(eastbound).toHaveLength(2);
    expect(eastbound[0]).toEqual([
      [170, 10],
      [180, 20],
    ]);
    expect(eastbound[1]).toEqual([
      [-180, 20],
      [-160, 40],
    ]);

    const westbound = splitAntimeridianLine([
      [-170, -5],
      [170, 5],
    ]);
    expect(westbound).toHaveLength(2);
    expect(westbound[0]).toEqual([
      [-170, -5],
      [-180, 0],
    ]);
    expect(westbound[1]).toEqual([
      [180, 0],
      [170, 5],
    ]);

    // Boundary point right on 180 should not produce 1-point stub segments
    const seamStart = splitAntimeridianLine([
      [180, 10],
      [-175, 20],
    ]);
    expect(seamStart).toEqual([
      [
        [-180, 10],
        [-175, 20],
      ],
    ]);
  });

  it('builds closed geodesic circle rings safely across +-180 deg and poles', () => {
    const normal = geodesicCirclePolygon(38.8512, -77.0402, 120, 64);
    expect(normal).toHaveLength(1);
    expect(normal[0].length).toBeGreaterThanOrEqual(64);
    expect(normal[0][0]).toEqual(normal[0][normal[0].length - 1]);

    const antimeridianCircle = geodesicCirclePolygon(20, 178, 500, 72);
    expect(antimeridianCircle).toHaveLength(2);
    for (const ring of antimeridianCircle) {
      expect(ring.length).toBeGreaterThanOrEqual(4);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      for (let i = 0; i < ring.length; i++) {
        expect(ring[i][0]).toBeGreaterThanOrEqual(-180);
        expect(ring[i][0]).toBeLessThanOrEqual(180);
        if (i > 0) {
          expect(Math.abs(ring[i][0] - ring[i - 1][0])).toBeLessThanOrEqual(180);
        }
      }
    }

    const polarCircle = geodesicCirclePolygon(88, 0, 500, 64);
    expect(polarCircle.length).toBeGreaterThanOrEqual(1);
    expect(polarCircle[0][0]).toEqual(polarCircle[0][polarCircle[0].length - 1]);
  });

  it('evaluates GeoJSON Polygon (with holes), MultiPolygon, and Feature containment', () => {
    const polyWithHole: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
          [-10, -10],
        ],
        [
          [-2, -2],
          [2, -2],
          [2, 2],
          [-2, 2],
          [-2, -2],
        ],
      ],
    };
    expect(pointInGeoJsonPolygon(5, 5, polyWithHole)).toBe(true);
    expect(pointInGeoJsonPolygon(0, 0, polyWithHole)).toBe(false);
    expect(pointInGeoJsonPolygon(15, 0, polyWithHole)).toBe(false);

    const feature: GeoJSON.Feature = {
      type: 'Feature',
      properties: { CEILING: 200 },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [polyWithHole.coordinates],
      },
    };
    expect(pointInGeoJsonFeature(5, 5, feature)).toBe(true);
    expect(pointInGeoJsonFeature(0, 0, feature)).toBe(false);
  });

  it('extrapolates dead reckoning accurately with vertical rate and ground clamp', () => {
    const next = extrapolateDeadReckoning(0, 0, 100, 90, 100, 1000, 5);
    expect(haversineDistanceKm(0, 0, next.lat, next.lon)).toBeCloseTo(10, 2);
    expect(next.lon).toBeGreaterThan(0);
    expect(next.lat).toBeCloseTo(0, 4);
    expect(next.altM).toBeCloseTo(1500, 6);

    const grounded = extrapolateDeadReckoning(38.85, -77.04, 10, 0, 10, 20, -5);
    expect(grounded.altM).toBe(0);
  });
});

describe('3D Sky-Dome vault projection, ENU tangents, celestial ephemeris & TCA', () => {
  it('maps elevations cleanly via elevationToVaultNormR and culls below minEl without rim clamping', () => {
    expect(elevationToVaultNormR(90, 'hemisphere')).toBe(0);
    expect(elevationToVaultNormR(0, 'hemisphere')).toBe(1);
    expect(elevationToVaultNormR(-10, 'hemisphere')).toBe(1);
    expect(elevationToVaultNormR(Number.NaN, 'hemisphere')).toBe(1);

    expect(elevationToVaultNormR(90, 'zenith')).toBe(0);
    expect(elevationToVaultNormR(30, 'zenith')).toBe(1);
    expect(elevationToVaultNormR(15, 'zenith')).toBe(1);
    expect(elevationToVaultNormR(Number.POSITIVE_INFINITY, 'zenith')).toBe(1);

    // Monotonic decrease from minEl to 90 deg
    expect(elevationToVaultNormR(45, 'hemisphere')).toBeGreaterThan(elevationToVaultNormR(60, 'hemisphere'));
    expect(elevationToVaultNormR(45, 'zenith')).toBeGreaterThan(elevationToVaultNormR(60, 'zenith'));

    // Strict culling for el < 0 (hemisphere) and el < 30 (zenith)
    const culledHemi = projectToSkyDome(120, -0.001, 200, 200, 150, 'hemisphere');
    expect(culledHemi).toEqual({ x: 200, y: 200, r: 0, normR: 0, visible: false });

    const culledZenith = projectToSkyDome(120, 29.999, 200, 200, 150, 'zenith');
    expect(culledZenith).toEqual({ x: 200, y: 200, r: 0, normR: 0, visible: false });

    // Exact boundary el === minEl is visible on the rim (normR = 1)
    const rimHemi = projectToSkyDome(90, 0, 200, 200, 150, 'hemisphere');
    expect(rimHemi.visible).toBe(true);
    expect(rimHemi.normR).toBeCloseTo(1, 12);
    expect(rimHemi.x).toBeCloseTo(350, 9);
    expect(rimHemi.y).toBeCloseTo(200, 9);

    const rimZenith = projectToSkyDome(0, 30, 200, 200, 150, 'zenith');
    expect(rimZenith.visible).toBe(true);
    expect(rimZenith.normR).toBeCloseTo(1, 12);
    expect(rimZenith.x).toBeCloseTo(200, 9);
    expect(rimZenith.y).toBeCloseTo(50, 9);

    // Invalid radius / NaN guards
    expect(projectToSkyDome(0, 45, 200, 200, 0, 'hemisphere').visible).toBe(false);
    expect(projectToSkyDome(Number.NaN, 45, 200, 200, 150, 'hemisphere').visible).toBe(false);
  });

  it('round-trips projectToSkyDome <-> unprojectFromSkyDome (< 0.01 deg error) in hemisphere and zenith modes', () => {
    const cx = 320;
    const cy = 240;
    const radius = 180;
    const azimuths = [0, 22.5, 90, 135, 180, 247.3, 315, 359.9];

    for (const mode of ['hemisphere', 'zenith'] as const) {
      const minEl = mode === 'zenith' ? 30 : 0;
      const elevations = mode === 'zenith' ? [30, 35, 45, 60, 75, 88, 89.99] : [0, 5, 15, 30, 45, 65, 85, 89.99];

      for (const el of elevations) {
        for (const az of azimuths) {
          const pt = projectToSkyDome(az, el, cx, cy, radius, mode);
          expect(pt.visible).toBe(true);
          const back = unprojectFromSkyDome(pt.x, pt.y, cx, cy, radius, mode);
          expect(back.inBounds).toBe(true);
          expect(Math.abs(back.elevationDeg - el)).toBeLessThan(1e-9);
          const azDiff = Math.abs((((back.azimuthDeg - az) % 360) + 540) % 360 - 180);
          expect(azDiff).toBeLessThan(0.01);
        }
      }

      // Exact center -> 90 deg Zenith, exact rim -> minEl, outside rim -> inBounds: false & clamped finite el
      const centerUnproj = unprojectFromSkyDome(cx, cy, cx, cy, radius, mode);
      expect(centerUnproj.inBounds).toBe(true);
      expect(centerUnproj.elevationDeg).toBeCloseTo(90, 11);

      const rimUnproj = unprojectFromSkyDome(cx + radius, cy, cx, cy, radius, mode);
      expect(rimUnproj.inBounds).toBe(true);
      expect(rimUnproj.azimuthDeg).toBeCloseTo(90, 9);
      expect(rimUnproj.elevationDeg).toBeCloseTo(minEl, 11);

      const outUnproj = unprojectFromSkyDome(cx + radius * 1.5, cy, cx, cy, radius, mode);
      expect(outUnproj.inBounds).toBe(false);
      expect(outUnproj.elevationDeg).toBeCloseTo(minEl, 11);

      const badUnproj = unprojectFromSkyDome(Number.NaN, cy, cx, cy, -10, mode);
      expect(badUnproj.inBounds).toBe(false);
      expect(Number.isFinite(badUnproj.elevationDeg)).toBe(true);
    }
  });

  it('projects ENU vectors smoothly through Zenith and matches projectToSkyDome', () => {
    const cx = 250;
    const cy = 250;
    const radius = 200;

    // Away from Zenith: matches az/el projection exactly
    const e = 8000;
    const n = 5000;
    const u = 12000;
    const enuPt = projectEnuToSkyDome(e, n, u, cx, cy, radius, 'hemisphere');
    const azDeg = Math.atan2(e, n) * (180 / Math.PI);
    const elDeg = Math.atan2(u, Math.hypot(e, n)) * (180 / Math.PI);
    const azElPt = projectToSkyDome(azDeg, elDeg, cx, cy, radius, 'hemisphere');
    expect(enuPt.visible).toBe(true);
    expect(enuPt.x).toBeCloseTo(azElPt.x, 9);
    expect(enuPt.y).toBeCloseTo(azElPt.y, 9);
    expect(enuPt.normR).toBeCloseTo(azElPt.normR, 12);

    // Exact Zenith and sub-micrometer Zenith neighborhood: zero NaN, smooth continuity
    const exactZenith = projectEnuToSkyDome(0, 0, 10000, cx, cy, radius, 'zenith');
    expect(exactZenith.visible).toBe(true);
    expect(exactZenith.x).toBe(cx);
    expect(exactZenith.y).toBe(cy);
    expect(exactZenith.normR).toBe(0);

    const tinyNorth = projectEnuToSkyDome(0, 1e-8, 10000, cx, cy, radius, 'hemisphere');
    const tinySouth = projectEnuToSkyDome(0, -1e-8, 10000, cx, cy, radius, 'hemisphere');
    expect(tinyNorth.visible).toBe(true);
    expect(tinyNorth.y).toBeLessThan(cy);
    expect(tinySouth.y).toBeGreaterThan(cy);
    expect(Math.hypot(tinyNorth.x - cx, tinyNorth.y - cy)).toBeLessThan(1e-6);

    // Below minEl culling vs allowBelowMinEl
    expect(projectEnuToSkyDome(1000, 0, -50, cx, cy, radius, 'hemisphere', false).visible).toBe(false);
    const extended = projectEnuToSkyDome(1000, 0, -50, cx, cy, radius, 'hemisphere', true);
    expect(extended.visible).toBe(false);
    expect(extended.normR).toBeGreaterThan(1);
    expect(projectEnuToSkyDome(0, 0, 0, cx, cy, radius).visible).toBe(false);
  });

  it('keeps computeSkyDomeTrajectoryTangent smooth across EL = 90.000 Zenith and +-180 Antimeridian', () => {
    const obs = { lat: 38.8512, lon: -77.0402, altM: 12 };
    const cx = 250;
    const cy = 250;
    const radius = 200;

    // Aircraft flying straight South-to-North overhead through observer's exact Zenith
    const offsetsKm = [-5, -1, -0.05, -0.001, 0, 0.001, 0.05, 1, 5];
    const maxVariationRad = (2 * Math.PI) / 180;
    for (const mode of ['hemisphere', 'zenith'] as const) {
      for (const kmNorth of offsetsKm) {
        const pos =
          kmNorth === 0
            ? { lat: obs.lat, lon: obs.lon }
            : greatCircleDestination(obs.lat, obs.lon, kmNorth > 0 ? 0 : 180, Math.abs(kmNorth));
        const angle = computeSkyDomeTrajectoryTangent(
          obs,
          { lat: pos.lat, lon: pos.lon, altM: 10012, speedMs: 250, headingDeg: 0, vertRateMs: 0 },
          cx,
          cy,
          radius,
          mode
        );
        expect(Number.isFinite(angle)).toBe(true);
        const diff = Math.abs(Math.atan2(Math.sin(angle - -Math.PI / 2), Math.cos(angle - -Math.PI / 2)));
        expect(diff).toBeLessThan(maxVariationRad);
      }
    }

    // Antimeridian crossing: target eastbound from +179.99 to -179.99 viewed near the seam
    const antObs = { lat: 0, lon: 179.95, altM: 0 };
    const westSideAngle = computeSkyDomeTrajectoryTangent(
      antObs,
      { lat: 0, lon: 179.99, altM: 11000, speedMs: 240, headingDeg: 90, vertRateMs: 0 },
      cx,
      cy,
      radius,
      'hemisphere'
    );
    const eastSideAngle = computeSkyDomeTrajectoryTangent(
      antObs,
      { lat: 0, lon: -179.99, altM: 11000, speedMs: 240, headingDeg: 90, vertRateMs: 0 },
      cx,
      cy,
      radius,
      'hemisphere'
    );
    expect(Math.abs(westSideAngle)).toBeLessThan(0.05);
    expect(Math.abs(eastSideAngle)).toBeLessThan(0.05);
    expect(Math.abs(eastSideAngle - westSideAngle)).toBeLessThan(0.05);

    // Stationary/hovering target with valid heading uses synthetic 10 m/s forward tangent
    const hoverEast = computeSkyDomeTrajectoryTangent(
      obs,
      { lat: obs.lat, lon: obs.lon, altM: 500, speedMs: 0, headingDeg: 90, headingValid: true, vertRateMs: 0 },
      cx,
      cy,
      radius
    );
    expect(hoverEast).toBeCloseTo(0, 3);

    // Invalid heading falls back cleanly without NaN
    const invalidHeadingState = computeTargetEnuState(obs, {
      lat: obs.lat,
      lon: obs.lon,
      altM: 500,
      speedMs: 50,
      headingDeg: 180,
      headingValid: false,
    });
    expect(invalidHeadingState.ve).toBe(0);
    expect(invalidHeadingState.vn).toBe(0);
    expect(invalidHeadingState.vu).toBe(0);

    const fallbackAngle = computeSkyDomeTrajectoryTangent(
      obs,
      { lat: obs.lat, lon: obs.lon, altM: 500, speedMs: 0, headingDeg: 180, headingValid: false },
      cx,
      cy,
      radius
    );
    expect(fallbackAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  it('computes accurate solar/lunar topocentric positions, twilight states, and lunar phase/illumination', () => {
    // Vernal Equinox 2026 solar noon & midnight at (0, 0) (EoT ~ -7.6 min -> solar noon ~ 12:07:36 UTC)
    const eqNoon = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 2, 20, 12, 7, 36));
    expect(eqNoon.sun.elevationDeg).toBeGreaterThan(89);
    expect(eqNoon.twilightState).toBe('day');

    const eqMidnight = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 2, 20, 0, 7, 36));
    expect(eqMidnight.sun.elevationDeg).toBeLessThan(-89);
    expect(eqMidnight.twilightState).toBe('night');

    // Civil and nautical twilight bands on Vernal Equinox evening
    const eqCivil = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 2, 20, 18, 20, 0));
    expect(eqCivil.sun.elevationDeg).toBeGreaterThanOrEqual(-6);
    expect(eqCivil.sun.elevationDeg).toBeLessThan(0);
    expect(eqCivil.twilightState).toBe('civil-twilight');

    const eqNautical = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 2, 20, 18, 45, 0));
    expect(eqNautical.sun.elevationDeg).toBeGreaterThanOrEqual(-12);
    expect(eqNautical.sun.elevationDeg).toBeLessThan(-6);
    expect(eqNautical.twilightState).toBe('nautical-twilight');

    // Summer Solstice Midnight Sun (+89.9 deg) & Polar Night (-89.9 deg)
    const juneNorth = computeSolarLunarTopocentric({ lat: 89.9, lon: 0 }, Date.UTC(2026, 5, 21, 12, 0, 0));
    expect(juneNorth.sun.elevationDeg).toBeGreaterThan(22);
    expect(juneNorth.twilightState).toBe('day');

    const juneSouth = computeSolarLunarTopocentric({ lat: -89.9, lon: 0 }, Date.UTC(2026, 5, 21, 12, 0, 0));
    expect(juneSouth.sun.elevationDeg).toBeLessThan(-22);
    expect(juneSouth.twilightState).toBe('night');

    // Winter Solstice Polar Night (+89.9 deg) & Midnight Sun (-89.9 deg)
    const decNorth = computeSolarLunarTopocentric({ lat: 89.9, lon: 0 }, Date.UTC(2026, 11, 21, 12, 0, 0));
    expect(decNorth.sun.elevationDeg).toBeLessThan(-22);
    expect(decNorth.twilightState).toBe('night');

    const decSouth = computeSolarLunarTopocentric({ lat: -89.9, lon: 0 }, Date.UTC(2026, 11, 21, 12, 0, 0));
    expect(decSouth.sun.elevationDeg).toBeGreaterThan(22);
    expect(decSouth.twilightState).toBe('day');

    // Southern Hemisphere solar noon (Sydney: Sun culminates due North, az ~ 0 / 360 deg)
    const sydneyNoon = computeSolarLunarTopocentric(
      { lat: -33.8688, lon: 151.2093 },
      Date.UTC(2026, 2, 20, 2, 3, 0)
    );
    const northDist = Math.min(sydneyNoon.sun.azimuthDeg, 360 - sydneyNoon.sun.azimuthDeg);
    expect(northDist).toBeLessThan(2);
    expect(sydneyNoon.sun.elevationDeg).toBeGreaterThan(50);

    // New Moon (2026-03-19T01:23Z) vs Full Moon (2026-04-02T02:12Z)
    const newMoon = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 2, 19, 1, 23, 0));
    expect(newMoon.moon.illuminationFraction).toBeLessThan(0.01);
    const newPhaseErr = Math.min(newMoon.moon.phaseFraction, 1 - newMoon.moon.phaseFraction);
    expect(newPhaseErr).toBeLessThan(0.02);

    const fullMoon = computeSolarLunarTopocentric({ lat: 0, lon: 0 }, Date.UTC(2026, 3, 2, 2, 12, 0));
    expect(fullMoon.moon.illuminationFraction).toBeGreaterThan(0.99);
    expect(fullMoon.moon.phaseFraction).toBeCloseTo(0.5, 1);

    // Non-finite timestamp and extreme latitude safety
    const badInput = computeSolarLunarTopocentric({ lat: 95, lon: 540 }, Number.NaN);
    expect(Number.isFinite(badInput.sun.azimuthDeg)).toBe(true);
    expect(Number.isFinite(badInput.sun.elevationDeg)).toBe(true);
    expect(Number.isFinite(badInput.moon.illuminationFraction)).toBe(true);
  });

  it('predicts Time of Closest Approach (TCA) for approaching, hovering, receding, and distant targets', () => {
    const obs = { lat: 38.8512, lon: -77.0402, altM: 12 };

    // 1. Approaching overhead jet: 30 km South heading North at 250 m/s, 10,000 m alt -> TCA ~ 120s, peak El ~ 90 deg
    const south30Km = greatCircleDestination(obs.lat, obs.lon, 180, 30);
    const approaching = computeClosestApproach(obs, {
      lat: south30Km.lat,
      lon: south30Km.lon,
      altM: 10012,
      speedMs: 250,
      headingDeg: 0,
      vertRateMs: 0,
    });
    expect(approaching.isApproaching).toBe(true);
    expect(approaching.tcaSeconds).toBeCloseTo(120, 0);
    expect(approaching.peakElevationDeg).toBeGreaterThan(85);
    expect(approaching.minSlantRangeKm).toBeCloseTo(10, 0);

    // 2. Stationary hovering drone (speedMs = 0) -> not approaching, zero NaN
    const hoverPos = greatCircleDestination(obs.lat, obs.lon, 45, 2);
    const hovering = computeClosestApproach(obs, {
      lat: hoverPos.lat,
      lon: hoverPos.lon,
      altM: 120,
      speedMs: 0,
      headingDeg: 90,
      vertRateMs: 0,
    });
    expect(hovering.isApproaching).toBe(false);
    expect(hovering.tcaSeconds).toBe(0);
    expect(Number.isFinite(hovering.peakElevationDeg)).toBe(true);
    expect(Number.isFinite(hovering.minSlantRangeKm)).toBe(true);
    expect(Number.isFinite(hovering.peakAzimuthDeg)).toBe(true);
    expect(hovering.minSlantRangeKm).toBeCloseTo(2, 1);

    // 3. Receding jet: 30 km North heading North -> tauRaw < 0 -> not approaching
    const north30Km = greatCircleDestination(obs.lat, obs.lon, 0, 30);
    const receding = computeClosestApproach(obs, {
      lat: north30Km.lat,
      lon: north30Km.lon,
      altM: 10012,
      speedMs: 250,
      headingDeg: 0,
      vertRateMs: 0,
    });
    expect(receding.isApproaching).toBe(false);
    expect(receding.tcaSeconds).toBe(0);
    expect(receding.minSlantRangeKm).toBeGreaterThan(30);

    // 4. Distant approaching jet (250 km South at 250 m/s -> raw TCA ~ 1000s) clamped at maxWindowSec = 600
    const south250Km = greatCircleDestination(obs.lat, obs.lon, 180, 250);
    const clamped = computeClosestApproach(
      obs,
      {
        lat: south250Km.lat,
        lon: south250Km.lon,
        altM: 11000,
        speedMs: 250,
        headingDeg: 0,
        vertRateMs: 0,
      },
      600
    );
    expect(clamped.isApproaching).toBe(true);
    expect(clamped.tcaSeconds).toBe(600);
    expect(clamped.minSlantRangeKm).toBeLessThan(110);
  });
});

describe('Tabular unit formatters', () => {
  it('formats aviation and metric speed, altitude, vertical rate, and distance', () => {
    expect(formatSpeed(100, 'aviation')).toBe('194 kt');
    expect(formatSpeed(100, 'metric')).toBe('360 km/h');
    expect(formatSpeed(Number.NaN, 'aviation')).toBe('---');

    expect(formatAltitude(121.92, 'aviation')).toBe('400 ft');
    expect(formatAltitude(10668, 'aviation')).toBe('FL350');
    expect(formatAltitude(420_500, 'aviation')).toBe('420.5 km');
    expect(formatAltitude(1500, 'metric')).toBe('1,500 m');
    expect(formatAltitude(12500, 'metric')).toBe('12.5 km');

    expect(formatVerticalRate(5, 'aviation')).toBe('+984 fpm');
    expect(formatVerticalRate(-5, 'metric')).toBe('-5.0 m/s');
    expect(formatVerticalRate(0, 'metric')).toBe('0.0 m/s');

    expect(formatDistance(18.52, 'aviation')).toBe('10.0 NM');
    expect(formatDistance(0.45, 'metric')).toBe('450 m');
    expect(formatDistance(42.5, 'metric')).toBe('42.5 km');

    expect(formatCoords(38.8512, -77.0402, 4)).toBe('38.8512°N, 77.0402°W');
    expect(formatAzEl(5.2, -0.02)).toBe('005.2° / +0.0°');
    expect(formatDoppler(8420)).toBe('+8.42 kHz');
    expect(formatDoppler(-340)).toBe('-340 Hz');
    expect(formatDoppler(0)).toBe('0 Hz');
  });
});

describe('SGP4 orbital worker engine & AstroClient', () => {
  it('parses valid ISS TLE, computes orbital elements, and skips corrupt TLEs', () => {
    const badTle: TleRecord = {
      name: 'CORRUPT SAT',
      noradId: 99999,
      group: 'visual',
      line1: '1 INVALID TLE LINE',
      line2: '2 INVALID TLE LINE',
    };
    const parsed = parseTleRecords([ISS_TLE, badTle]);
    expect(parsed).toHaveLength(1);
    const iss = parsed[0];
    expect(iss.meta.noradId).toBe(25544);
    expect(iss.meta.inclinationDeg).toBeCloseTo(51.6416, 3);
    // SGP4 converts TLE Kozai mean motion to Brouwer mean motion (~0.01 min shift).
    expect(iss.meta.periodMin).toBeCloseTo(1440 / 15.498145, 1);
    expect(iss.meta.apogeeKm).toBeGreaterThan(350);
    expect(iss.meta.apogeeKm).toBeLessThan(500);
    expect(iss.meta.perigeeKm).toBeGreaterThan(350);
    expect(iss.meta.perigeeKm).toBeLessThan(iss.meta.apogeeKm);
  });

  it('propagates 2,000 satellites well within real-time frame/worker budgets', () => {
    const bulkTles: TleRecord[] = Array.from({ length: 2000 }, (_, i) => ({
      name: `SAT-${i + 1}`,
      noradId: 60000 + i,
      group: i < 20 ? 'stations' : i < 200 ? 'visual' : 'starlink',
      line1: ISS_TLE.line1.replace('25544U', String(60000 + i).padStart(5, '0') + 'U'),
      line2: ISS_TLE.line2.replace('25544', String(60000 + i).padStart(5, '0')),
    }));
    const parsed = parseTleRecords(bulkTles);
    const pool = selectSatellitePool(parsed, true);
    expect(pool).toHaveLength(2000);

    const t0 = performance.now();
    const res = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: DC_OBSERVER,
      radiusKm: 250,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });
    const elapsedMs = performance.now() - t0;
    expect(res.kinematics.length).toBe(res.meta.length * SAT_KINEMATICS_STRIDE);
    expect(elapsedMs).toBeLessThan(250);
  });

  it('caps starlink to 600 evenly sampled records when fullConstellation is false', () => {
    const fakeStarlink: TleRecord[] = Array.from({ length: 1200 }, (_, i) => ({
      name: `STARLINK-${i + 1}`,
      noradId: 50000 + i,
      group: 'starlink' as const,
      line1: ISS_TLE.line1.replace('25544U', String(50000 + i).padStart(5, '0') + 'U'),
      line2: ISS_TLE.line2.replace('25544', String(50000 + i).padStart(5, '0')),
    }));
    const parsed = parseTleRecords([ISS_TLE, ...fakeStarlink]);
    const capped = selectSatellitePool(parsed, false);
    const uncapped = selectSatellitePool(parsed, true);

    expect(capped.filter((s) => s.meta.group === 'stations')).toHaveLength(1);
    expect(capped.filter((s) => s.meta.group === 'starlink')).toHaveLength(600);
    expect(uncapped).toHaveLength(1201);
  });

  it('propagates ISS via SGP4, packs stride-12 Float32Array, and unpacks SatelliteEntity', () => {
    const parsed = parseTleRecords([ISS_TLE]);
    const pool = selectSatellitePool(parsed, true);

    // Propagate in hemisphere mode with large radius so ISS is guaranteed to be emitted
    const { kinematics, meta } = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: DC_OBSERVER,
      radiusKm: 25000,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });

    expect(meta).toHaveLength(1);
    expect(kinematics.length).toBe(SAT_KINEMATICS_STRIDE);

    const unpacked = unpackSatelliteKinematics(kinematics, meta, ISS_EPOCH_MS);
    expect(unpacked).toHaveLength(1);
    const issEntity = unpacked[0];
    expect(issEntity.id).toBe('sat-25544');
    expect(issEntity.lat).toBeGreaterThanOrEqual(-55);
    expect(issEntity.lat).toBeLessThanOrEqual(55);
    expect(issEntity.altM).toBeGreaterThan(350_000);
    expect(issEntity.altM).toBeLessThan(480_000);
    expect(issEntity.speedMs).toBeGreaterThan(7000);
    expect(issEntity.speedMs).toBeLessThan(8200);
    expect(issEntity.topocentric.azimuthDeg).toBeGreaterThanOrEqual(0);
    expect(issEntity.topocentric.azimuthDeg).toBeLessThan(360);
    expect(issEntity.trail).toHaveLength(1);

    // Verify cylinder scope excludes ISS when sub-satellite point is outside radiusKm
    const issSubObserver: ObserverLocation = {
      lat: issEntity.lat,
      lon: issEntity.lon,
      altM: 0,
      label: 'Sub-ISS',
      source: 'manual',
    };
    const cylInside = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: issSubObserver,
      radiusKm: 100,
      orbitalScope: 'cylinder',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });
    expect(cylInside.meta).toHaveLength(1);
    expect(cylInside.kinematics[6]).toBeGreaterThan(80); // Near zenith directly overhead!

    const antipodeObserver: ObserverLocation = {
      lat: -issEntity.lat,
      lon: normalizeLonDeg(issEntity.lon + 180),
      altM: 0,
      label: 'Antipode',
      source: 'manual',
    };
    const cylOutside = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: antipodeObserver,
      radiusKm: 250,
      orbitalScope: 'cylinder',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });
    expect(cylOutside.meta).toHaveLength(0);
  });

  it('computes Antimeridian-split orbit overlay, footprint radius, and peak pass marker', () => {
    const parsed = parseTleRecords([ISS_TLE]);
    const iss = parsed[0];
    const { kinematics } = propagateSatellites(parsed, ISS_EPOCH_MS, {
      observer: DC_OBSERVER,
      radiusKm: 25000,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });

    const subIssObserver: ObserverLocation = {
      lat: kinematics[0],
      lon: kinematics[1],
      altM: 0,
      label: 'Sub-ISS',
      source: 'manual',
    };
    const overlay = computeSatelliteOrbitOverlay(iss, ISS_EPOCH_MS, subIssObserver);
    expect(overlay.noradId).toBe(25544);
    expect(overlay.groundTrackSegments.length).toBeGreaterThanOrEqual(1);
    for (const seg of overlay.groundTrackSegments) {
      expect(seg.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < seg.length; i++) {
        expect(Math.abs(seg[i][0] - seg[i - 1][0])).toBeLessThanOrEqual(180);
      }
    }
    expect(overlay.footprintRadiusKm).toBeGreaterThan(2000);
    expect(overlay.footprintRadiusKm).toBeLessThan(2600);
    const peaks = overlay.passArcAzEl.filter((p) => p.isPeak);
    expect(peaks).toHaveLength(1);
    expect(peaks[0].elDeg).toBeGreaterThan(75);
  });

  it('orchestrates AstroClient message lifecycle cleanly and caps trails at <= 40', async () => {
    const engine = createAstroWorkerEngine();
    const client = new AstroClient(
      {},
      {
        workerFactory: () => {
          const fakeWorker = {
            onmessage: null as ((ev: MessageEvent<WorkerResponseMessage>) => void) | null,
            onerror: null,
            postMessage(msg: WorkerRequestMessage) {
              const res = engine.handleMessage(msg);
              if (res && fakeWorker.onmessage) {
                fakeWorker.onmessage({ data: res } as MessageEvent<WorkerResponseMessage>);
              }
            },
            terminate() {},
          };
          return fakeWorker as unknown as Worker;
        },
      }
    );

    const ready = await client.initTles([ISS_TLE], false);
    expect(ready).toEqual({ count: 1, totalParsed: 1 });

    let latestTrailLen = 0;
    client.setCallbacks({
      onPropagated: (payload) => {
        if (payload.satellites.length > 0) {
          latestTrailLen = payload.satellites[0].trail.length;
        }
      },
    });

    client.updateConfig({
      observer: DC_OBSERVER,
      radiusKm: 25000,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });

    for (let step = 0; step < 50; step++) {
      client.tick(ISS_EPOCH_MS + step * 5000);
    }
    expect(latestTrailLen).toBeGreaterThan(1);
    expect(latestTrailLen).toBeLessThanOrEqual(40);

    const overlay = await client.computeOrbit(25544, ISS_EPOCH_MS, DC_OBSERVER);
    expect(overlay.noradId).toBe(25544);
    expect(overlay.groundTrackSegments.length).toBeGreaterThanOrEqual(1);

    client.dispose();

    // Disposing while an async request is in flight resolves cleanly without unhandled rejections.
    const asyncClient = new AstroClient(
      {},
      {
        workerFactory: () =>
          ({
            onmessage: null,
            onerror: null,
            postMessage() {},
            terminate() {},
          }) as unknown as Worker,
      }
    );
    const pendingOrbit = asyncClient.computeOrbit(25544, ISS_EPOCH_MS, DC_OBSERVER);
    asyncClient.dispose();
    const fallbackOverlay = await pendingOrbit;
    expect(fallbackOverlay.groundTrackSegments).toEqual([]);
  });
});
