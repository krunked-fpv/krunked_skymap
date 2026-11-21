import { describe, expect, it } from 'vitest';
import {
  WGS84_A,
  WGS84_E2,
  WGS84_F,
  computeBearingDeg,
  computeTopocentricLookAngles,
  ecefToEnu,
  extrapolateDeadReckoning,
  geodesicCirclePolygon,
  geodeticToEcef,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeLonDeg,
  pointInGeoJsonFeature,
  pointInGeoJsonPolygon,
  splitAntimeridianLine,
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
