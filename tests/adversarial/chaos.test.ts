import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fallbackAirspaceRaw from '../../public/data/fallback-airspace.geojson?raw';
import stationsTleRaw from '../../public/data/tle/stations.tle?raw';
import visualTleRaw from '../../public/data/tle/visual.tle?raw';
import starlinkTleRaw from '../../public/data/tle/starlink.tle?raw';
import appSourceRaw from '../../src/App.tsx?raw';
import balloonsSourceRaw from '../../src/services/balloonsService.ts?raw';
import controlDockSourceRaw from '../../src/components/hud/ControlDock.tsx?raw';
import topTelemetryBarSourceRaw from '../../src/components/hud/TopTelemetryBar.tsx?raw';
import polarDomeSourceRaw from '../../src/components/skydome/PolarSkyDome.tsx?raw';
import tacticalMapSourceRaw from '../../src/components/map/TacticalMap.tsx?raw';
import {
  computeBearingDeg,
  computeTopocentricLookAngles,
  extrapolateDeadReckoning,
  geodesicCirclePolygon,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeLonDeg,
  splitAntimeridianLine,
} from '../../src/math/geodesy';
import {
  computeSatelliteOrbitOverlay,
  createAstroWorkerEngine,
  parseTleRecords,
  propagateSatellites,
  selectSatellitePool,
} from '../../src/workers/astro.worker';
import { AstroClient, unpackSatelliteKinematics } from '../../src/workers/astroClient';
import {
  clearFlightsServiceCache,
  extractRelayedJsonPayload,
  fetchFlightsCascade,
  fetchGlobalSpecialFlights,
  flightsCircuitBreaker,
  globalFlightsCircuitBreaker,
  normalizeAdsbxAircraft,
  normalizeOpenSkyState,
} from '../../src/services/flightsService';
import {
  clearBalloonsCache,
  fetchBalloons,
  normalizeSondeRecord,
  parseWindBorneConstellation,
} from '../../src/services/balloonsService';
import { fetchAirspace } from '../../src/services/airspaceService';
import {
  clearTleCache,
  loadInitialTles,
  parseTleText,
  refreshTlesIfStale,
} from '../../src/services/satellitesService';
import {
  OpenDroneIdClient,
  normalizeOdidPayload,
  stepSimulatedDrones,
} from '../../src/services/openDroneIdService';
import { TacticalAudioEngine } from '../../src/audio/tacticalAudio';
import { liveKinematicsRegistry, useSkyStore } from '../../src/store/useSkyStore';
import { resolveSpriteForEntity } from '../../src/assets/sprites/tacticalSprites';
import {
  formatAltitude as formatInspectorAltitude,
  formatDoppler as formatInspectorDoppler,
  formatHeading as formatInspectorHeading,
  formatSpeed as formatInspectorSpeed,
} from '../../src/components/inspector/unitFormatters';
import {
  SAT_KINEMATICS_STRIDE,
  type AirspaceData,
  type BalloonEntity,
  type DroneEntity,
  type FlightEntity,
  type ObserverLocation,
  type SatelliteEntity,
  type SkyEntity,
  type TleRecord,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../../src/types/sky-contracts';

interface NodeFsSubset {
  existsSync(path: URL): boolean;
  readFileSync(path: URL): Uint8Array;
  readFileSync(path: URL, encoding: 'utf8'): string;
}

interface NodeVmSubset {
  runInNewContext(code: string, context: Record<string, unknown>): unknown;
}

async function loadNodeFs(): Promise<NodeFsSubset> {
  const mod = 'node:fs';
  return (await import(/* @vite-ignore */ mod)) as NodeFsSubset;
}

async function loadNodeVm(): Promise<NodeVmSubset> {
  const mod = 'node:vm';
  return (await import(/* @vite-ignore */ mod)) as NodeVmSubset;
}

function repoFileUrl(relativePath: string): URL {
  return new URL(`../../${relativePath}`, import.meta.url);
}

const EXTREME_OBSERVERS: Array<{ id: string; observer: ObserverLocation }> = [
  {
    id: 'equator-prime',
    observer: { lat: 0, lon: 0, altM: 0, label: 'Equator (0, 0)', source: 'manual' },
  },
  {
    id: 'svalbard-arctic',
    observer: { lat: 78.22, lon: 15.63, altM: 28, label: 'Svalbard', source: 'manual' },
  },
  {
    id: 'sydney-southern',
    observer: { lat: -33.86, lon: 151.2, altM: 19, label: 'Sydney', source: 'manual' },
  },
  {
    id: 'south-pole',
    observer: { lat: -89.99, lon: 0, altM: 2835, label: 'South Pole', source: 'manual' },
  },
  {
    id: 'antimeridian-east',
    observer: { lat: 0, lon: 179.95, altM: 0, label: 'Antimeridian +179.95', source: 'manual' },
  },
  {
    id: 'antimeridian-west',
    observer: { lat: 0, lon: -179.95, altM: 0, label: 'Antimeridian -179.95', source: 'manual' },
  },
];

const ISS_TLE: TleRecord = {
  name: 'ISS (ZARYA)',
  noradId: 25544,
  group: 'stations',
  line1: '1 25544U 98067A   26324.50000000  .00016717  00000-0  30125-3 0  9998',
  line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814500483410',
};

const POLAR_TLE: TleRecord = {
  name: 'NOAA 19',
  noradId: 33591,
  group: 'visual',
  line1: '1 33591U 09005A   26324.21000000  .00000123  00000-0  91234-4 0  9991',
  line2: '2 33591  99.1900 120.5000 0014500  45.1000 315.1000 14.12500000800001',
};

const EQUATORIAL_TLE: TleRecord = {
  name: 'EQUA-LEO',
  noradId: 49999,
  group: 'visual',
  line1: '1 49999U 21001A   26324.50000000  .00001000  00000-0  10000-4 0  9992',
  line2: '2 49999   0.1500  45.0000 0002000  90.0000 270.0000 15.20000000100001',
};

const DECAYED_TLE: TleRecord = {
  name: 'DECAYED ANCIENT SAT',
  noradId: 90007,
  group: 'visual',
  line1: '1 90007U 80001A   90001.00000000  .50000000  00000-0  50000-0 0  9991',
  line2: '2 90007  51.6416 247.4627 0006703 130.5360 325.0288 16.50000000000001',
};

const ISS_EPOCH_MS = Date.UTC(2026, 10, 20, 12, 0, 0);

const EMPTY_AIRSPACE: AirspaceData = {
  uasfm: { type: 'FeatureCollection', features: [] },
  sua: { type: 'FeatureCollection', features: [] },
  usCoverage: false,
};

function assertAllFiniteCoords(coords: Array<[number, number]>, context: string): void {
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat] = coords[i];
    expect(Number.isFinite(lon), `${context}[${i}].lon not finite: ${lon}`).toBe(true);
    expect(Number.isFinite(lat), `${context}[${i}].lat not finite: ${lat}`).toBe(true);
    expect(lon, `${context}[${i}].lon out of [-180, 180]: ${lon}`).toBeGreaterThanOrEqual(-180);
    expect(lon, `${context}[${i}].lon out of [-180, 180]: ${lon}`).toBeLessThanOrEqual(180);
    expect(lat, `${context}[${i}].lat out of [-90, 90]: ${lat}`).toBeGreaterThanOrEqual(-90);
    expect(lat, `${context}[${i}].lat out of [-90, 90]: ${lat}`).toBeLessThanOrEqual(90);
    if (i > 0) {
      const jump = Math.abs(lon - coords[i - 1][0]);
      expect(
        jump,
        `${context}[${i}] antimeridian jump > 180 deg (${coords[i - 1][0]} -> ${lon}, delta=${jump})`
      ).toBeLessThanOrEqual(180);
    }
  }
}

function makeSynthesizedTle(index: number): TleRecord {
  const noradId = 70000 + index;
  const id5 = String(noradId);
  const inc = (28 + ((index * 7) % 70)).toFixed(4).padStart(8, ' ');
  const raan = ((index * 13.7) % 360).toFixed(4).padStart(8, ' ');
  const ma = ((index * 29.3) % 360).toFixed(4).padStart(8, ' ');
  const mm = (14.5 + (index % 130) * 0.01).toFixed(8).padStart(11, ' ');
  const rawL1 = `1 ${id5}U 24001A   26324.50000000  .00005000  00000-0  50000-4 0  999`;
  const rawL2 = `2 ${id5} ${inc} ${raan} 0002500  80.0000 ${ma} ${mm}00010`;
  const checksum = (line: string): number => {
    let sum = 0;
    for (let i = 0; i < 68; i++) {
      const c = line[i];
      if (c >= '0' && c <= '9') sum += c.charCodeAt(0) - 48;
      else if (c === '-') sum += 1;
    }
    return sum % 10;
  };
  return {
    name: `SYNTH-${noradId}`,
    noradId,
    group: index < 20 ? 'stations' : index < 200 ? 'visual' : 'starlink',
    line1: `${rawL1}${checksum(rawL1)}`,
    line2: `${rawL2}${checksum(rawL2)}`,
  };
}

function makeSeededStaticAwareFetch(
  externalBehavior: (url: string) => Promise<Response> | never
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('fallback-airspace.geojson')) {
      return new Response(fallbackAirspaceRaw, {
        status: 200,
        headers: { 'Content-Type': 'application/geo+json' },
      });
    }
    if (url.includes('/tle/stations.tle')) {
      return new Response(stationsTleRaw, { status: 200 });
    }
    if (url.includes('/tle/visual.tle')) {
      return new Response(visualTleRaw, { status: 200 });
    }
    if (url.includes('/tle/starlink.tle')) {
      return new Response(starlinkTleRaw, { status: 200 });
    }
    return externalBehavior(url);
  }) as unknown as typeof fetch;
}

describe('Challenge 1 — Extreme Geodesy & Antimeridian Torture', () => {
  it('computes finite, bounded topocentric look angles, bearings, distances, and great-circle destinations across all 6 extreme observers', () => {
    for (const { id, observer } of EXTREME_OBSERVERS) {
      const colocated = computeTopocentricLookAngles(observer, observer);
      expect(Number.isFinite(colocated.azimuthDeg), `${id} colocated az`).toBe(true);
      expect(Number.isFinite(colocated.elevationDeg), `${id} colocated el`).toBe(true);
      expect(colocated.slantRangeKm).toBe(0);

      const zenith = computeTopocentricLookAngles(observer, {
        lat: observer.lat,
        lon: observer.lon,
        altM: observer.altM + 10_000,
      });
      expect(zenith.elevationDeg, `${id} zenith el`).toBeCloseTo(90, 5);
      expect(zenith.belowHorizon).toBe(false);

      for (const distKm of [0, 0.5, 50, 120, 250, 2500]) {
        for (const bearing of [0, 45, 90, 135, 180, 225, 270, 315, 360]) {
          const dest = greatCircleDestination(observer.lat, observer.lon, bearing, distKm);
          expect(Number.isFinite(dest.lat), `${id} dest.lat d=${distKm} b=${bearing}`).toBe(true);
          expect(Number.isFinite(dest.lon), `${id} dest.lon d=${distKm} b=${bearing}`).toBe(true);
          expect(dest.lat).toBeGreaterThanOrEqual(-90);
          expect(dest.lat).toBeLessThanOrEqual(90);
          expect(dest.lon).toBeGreaterThanOrEqual(-180);
          expect(dest.lon).toBeLessThanOrEqual(180);

          const look = computeTopocentricLookAngles(observer, {
            lat: dest.lat,
            lon: dest.lon,
            altM: 10_000,
          });
          expect(Number.isFinite(look.azimuthDeg)).toBe(true);
          expect(Number.isFinite(look.elevationDeg)).toBe(true);
          expect(Number.isFinite(look.slantRangeKm)).toBe(true);
          expect(Number.isFinite(look.groundDistKm)).toBe(true);
          expect(look.azimuthDeg).toBeGreaterThanOrEqual(0);
          expect(look.azimuthDeg).toBeLessThan(360);
          expect(look.elevationDeg).toBeGreaterThanOrEqual(-90);
          expect(look.elevationDeg).toBeLessThanOrEqual(90);
        }
      }
    }

    expect(haversineDistanceKm(0, 179.95, 0, -179.95)).toBeCloseTo(11.12, 1);
    expect(computeBearingDeg(0, 179.95, 0, -179.95)).toBeCloseTo(90, 1);
    expect(computeBearingDeg(0, -179.95, 0, 179.95)).toBeCloseTo(270, 1);
    expect(normalizeLonDeg(180.05)).toBeCloseTo(-179.95, 6);
    expect(normalizeLonDeg(-180.05)).toBeCloseTo(179.95, 6);

    const eastToWest = computeTopocentricLookAngles(
      { lat: 0, lon: 179.95, altM: 0 },
      { lat: 0, lon: -179.95, altM: 0 }
    );
    expect(eastToWest.groundDistKm).toBeCloseTo(11.12, 1);
    expect(eastToWest.azimuthDeg).toBeCloseTo(90, 1);
  });

  it('splits Antimeridian zig-zag polylines with zero >180 deg longitude jumps or NaNs', () => {
    const zigZag: Array<[number, number]> = [
      [175, -10],
      [179.95, 0],
      [-179.95, 2],
      [-175, 10],
      [178, 25],
      [180, 35],
      [-180, 40],
      [-179, 45],
      [179.5, 55],
    ];
    const segments = splitAntimeridianLine(zigZag);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (let s = 0; s < segments.length; s++) {
      expect(segments[s].length).toBeGreaterThanOrEqual(2);
      assertAllFiniteCoords(segments[s], `splitAntimeridianLine.seg[${s}]`);
    }

    const exactBoundary = splitAntimeridianLine([
      [179, 10],
      [-180, 20],
      [180, 30],
      [-179, 40],
    ]);
    for (let s = 0; s < exactBoundary.length; s++) {
      assertAllFiniteCoords(exactBoundary[s], `exactBoundary.seg[${s}]`);
    }
  });

  it('builds geodesicCirclePolygon rings across non-polar and polar-enclosing observers without >180 deg jumps', () => {
    const cases: Array<{ id: string; lat: number; lon: number; radiusKm: number }> = [
      { id: 'equator-120', lat: 0, lon: 0, radiusKm: 120 },
      { id: 'sydney-250', lat: -33.86, lon: 151.2, radiusKm: 250 },
      { id: 'svalbard-250', lat: 78.22, lon: 15.63, radiusKm: 250 },
      { id: 'antimeridian-e-120', lat: 0, lon: 179.95, radiusKm: 120 },
      { id: 'antimeridian-w-250', lat: 0, lon: -179.95, radiusKm: 250 },
      { id: 'south-pole-120', lat: -89.99, lon: 0, radiusKm: 120 },
      { id: 'svalbard-footprint-2200', lat: 78.22, lon: 15.63, radiusKm: 2200 },
    ];

    for (const c of cases) {
      const rings = geodesicCirclePolygon(c.lat, c.lon, c.radiusKm, 72);
      expect(rings.length, `${c.id} should return rings`).toBeGreaterThanOrEqual(1);
      for (let r = 0; r < rings.length; r++) {
        expect(rings[r].length).toBeGreaterThanOrEqual(4);
        expect(rings[r][0]).toEqual(rings[r][rings[r].length - 1]);
        assertAllFiniteCoords(rings[r], `${c.id}.ring[${r}]`);
      }
    }
  });

  it('computes Antimeridian-safe computeSatelliteOrbitOverlay across all 6 extreme observers', () => {
    const parsed = parseTleRecords([ISS_TLE, POLAR_TLE, EQUATORIAL_TLE]);
    expect(parsed).toHaveLength(3);

    const crossingEpoch = ISS_EPOCH_MS + 37 * 60 * 1000;

    for (const sat of parsed) {
      for (const { id, observer } of EXTREME_OBSERVERS) {
        const overlay = computeSatelliteOrbitOverlay(sat, crossingEpoch, observer);
        expect(Number.isFinite(overlay.footprintRadiusKm), `${sat.meta.name}@${id} footprint`).toBe(
          true
        );
        expect(overlay.footprintRadiusKm).toBeGreaterThan(0);
        expect(overlay.groundTrackSegments.length).toBeGreaterThanOrEqual(1);

        for (let s = 0; s < overlay.groundTrackSegments.length; s++) {
          const seg = overlay.groundTrackSegments[s];
          expect(seg.length).toBeGreaterThanOrEqual(2);
          assertAllFiniteCoords(seg, `orbitOverlay(${sat.meta.name}@${id}).seg[${s}]`);
        }

        for (const pt of overlay.passArcAzEl) {
          expect(Number.isFinite(pt.azDeg)).toBe(true);
          expect(Number.isFinite(pt.elDeg)).toBe(true);
          expect(pt.azDeg).toBeGreaterThanOrEqual(0);
          expect(pt.azDeg).toBeLessThan(360);
          expect(pt.elDeg).toBeGreaterThanOrEqual(-90);
          expect(pt.elDeg).toBeLessThanOrEqual(90);
        }
      }
    }
  });
});

describe('Challenge 2 — WGS-84 Curvature Horizon & Bennett Refraction Bounds', () => {
  it('models Earth curvature horizon drop-off at 250 km across latitudes (1,500m below, 12,000m above)', () => {
    for (const { id, observer } of EXTREME_OBSERVERS) {
      const seaLevelObs = { lat: observer.lat, lon: observer.lon, altM: 0 };
      for (const bearing of [0, 90, 180, 270]) {
        const tgt = greatCircleDestination(seaLevelObs.lat, seaLevelObs.lon, bearing, 250);

        const lowGeom = computeTopocentricLookAngles(
          seaLevelObs,
          { lat: tgt.lat, lon: tgt.lon, altM: 1500 },
          false
        );
        expect(lowGeom.groundDistKm, `${id} b=${bearing}`).toBeCloseTo(250, 0);
        expect(lowGeom.elevationDeg, `${id} 1500m geom el`).toBeLessThan(0);
        expect(lowGeom.belowHorizon).toBe(true);

        const lowRefracted = computeTopocentricLookAngles(
          seaLevelObs,
          { lat: tgt.lat, lon: tgt.lon, altM: 1500 },
          true
        );
        expect(lowRefracted.elevationDeg, `${id} 1500m refracted el`).toBeLessThan(0);
        expect(lowRefracted.belowHorizon).toBe(true);

        const highGeom = computeTopocentricLookAngles(
          seaLevelObs,
          { lat: tgt.lat, lon: tgt.lon, altM: 12_000 },
          false
        );
        expect(highGeom.elevationDeg, `${id} 12000m geom el`).toBeGreaterThan(0);
        expect(highGeom.belowHorizon).toBe(false);

        const highRefracted = computeTopocentricLookAngles(
          seaLevelObs,
          { lat: tgt.lat, lon: tgt.lon, altM: 12_000 },
          true
        );
        expect(highRefracted.elevationDeg, `${id} 12000m refracted el`).toBeGreaterThan(0);
        expect(highRefracted.belowHorizon).toBe(false);
      }
    }
  });

  it('keeps Bennett refraction monotonic and strictly bounded in [-90, 90] across full elevation sweep', () => {
    const obs = { lat: 38.8512, lon: -77.0402, altM: 0 };
    const tgt250 = greatCircleDestination(obs.lat, obs.lon, 90, 250);

    const sampleAlts: number[] = [];
    for (let alt = -15_000; alt <= 40_000; alt += 100) {
      sampleAlts.push(alt);
    }

    let prevGeomEl = -91;
    let prevRefEl = -91;
    for (const altM of sampleAlts) {
      const geom = computeTopocentricLookAngles(obs, { ...tgt250, altM }, false);
      const refr = computeTopocentricLookAngles(obs, { ...tgt250, altM }, true);

      expect(Number.isFinite(geom.elevationDeg)).toBe(true);
      expect(Number.isFinite(refr.elevationDeg)).toBe(true);
      expect(refr.elevationDeg).toBeGreaterThanOrEqual(-90);
      expect(refr.elevationDeg).toBeLessThanOrEqual(90);

      expect(geom.elevationDeg).toBeGreaterThanOrEqual(prevGeomEl);
      expect(refr.elevationDeg).toBeGreaterThanOrEqual(prevRefEl);
      expect(refr.elevationDeg).toBeGreaterThanOrEqual(geom.elevationDeg);

      prevGeomEl = geom.elevationDeg;
      prevRefEl = refr.elevationDeg;
    }

    const nearObs = greatCircleDestination(obs.lat, obs.lon, 90, 1);
    let prevNearRef = -91;
    for (let alt = -50; alt <= 400_000; alt += alt < 200 ? 1 : 1000) {
      const refr = computeTopocentricLookAngles(obs, { ...nearObs, altM: alt }, true);
      expect(refr.elevationDeg).toBeGreaterThanOrEqual(-90);
      expect(refr.elevationDeg).toBeLessThanOrEqual(90);
      expect(refr.elevationDeg).toBeGreaterThanOrEqual(prevNearRef);
      prevNearRef = refr.elevationDeg;
    }

    const zenith = computeTopocentricLookAngles(
      obs,
      { lat: obs.lat, lon: obs.lon, altM: 420_000 },
      true
    );
    expect(zenith.elevationDeg).toBeCloseTo(90, 8);
  });
});

describe('Challenge 3 — SGP4 Resilience & 2,000-Satellite Latency Budget', () => {
  it('propagates valid ISS/LEO TLEs cleanly alongside corrupt/malformed and decayed TLEs without NaNs or crashes', () => {
    const rawChaosText = [
      'ISS (ZARYA)',
      ISS_TLE.line1,
      ISS_TLE.line2,
      'SHORT LINE SAT',
      '1 90001U 98067A   26324.50000000',
      '2 90001  51.6416',
      'GARBAGE EPOCH SAT',
      '1 90002U 98067A   XX324.50000000  .00016717  00000-0  30125-3 0  9998',
      '2 90002  51.6416 247.4627 0006703 130.5360 325.0288 15.49814500483410',
      'ZERO MEAN MOTION SAT',
      '1 90003U 98067A   26324.50000000  .00016717  00000-0  30125-3 0  9998',
      '2 90003  51.6416 247.4627 0006703 130.5360 325.0288 00.00000000483410',
      'HYPERBOLIC ECCENTRICITY SAT',
      '1 90004U 98067A   26324.50000000  .00016717  00000-0  30125-3 0  9998',
      '2 90004  51.6416 247.4627 9999999 130.5360 325.0288 15.49814500483410',
      'MISMATCHED NORAD SAT',
      '1 90005U 98067A   26324.50000000  .00016717  00000-0  30125-3 0  9998',
      '2 90006  51.6416 247.4627 0006703 130.5360 325.0288 15.49814500483410',
      'ALPHA-5 STARLINK',
      '1 T0123U 24001A   26324.50000000  .00010000  00000-0  50000-4 0  9990',
      '2 T0123  53.2100 100.0000 0001500  80.0000 280.0000 15.06400000000012',
      'NOAA 19',
      POLAR_TLE.line1,
      POLAR_TLE.line2,
    ].join('\n');

    const textParsed = parseTleText(rawChaosText, 'visual');
    expect(textParsed.some((r) => r.noradId === 25544)).toBe(true);
    expect(textParsed.some((r) => r.noradId === 33591)).toBe(true);

    const directRecords: TleRecord[] = [
      ...textParsed,
      DECAYED_TLE,
      { name: 'EMPTY', noradId: 91000, group: 'visual', line1: '', line2: '' },
      null as unknown as TleRecord,
    ];

    const parsed = parseTleRecords(directRecords);
    expect(parsed.some((p) => p.meta.noradId === 25544)).toBe(true);
    expect(parsed.some((p) => p.meta.noradId === 33591)).toBe(true);

    const decayed = parsed.find((s) => s.meta.noradId === 90007);
    expect(decayed).toBeDefined();
    expect(() => {
      const ov = computeSatelliteOrbitOverlay(decayed!, ISS_EPOCH_MS, EXTREME_OBSERVERS[0].observer);
      expect(Number.isFinite(ov.footprintRadiusKm)).toBe(true);
    }).not.toThrow();

    const res = propagateSatellites(parsed, ISS_EPOCH_MS, {
      observer: EXTREME_OBSERVERS[1].observer,
      radiusKm: 25_000,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });

    for (let i = 0; i < res.kinematics.length; i++) {
      expect(Number.isFinite(res.kinematics[i]), `kinematics[${i}]`).toBe(true);
    }
    expect(res.meta.some((m) => m.noradId === 25544)).toBe(true);
  });

  it('propagates 2,000 synthesized valid LEO satellites in < 100ms with strict Stride-12 Float32Array packing', () => {
    const bulkTles = Array.from({ length: 2000 }, (_, i) => makeSynthesizedTle(i));
    const parsed = parseTleRecords(bulkTles);
    expect(parsed).toHaveLength(2000);

    const pool = selectSatellitePool(parsed, true);
    expect(pool).toHaveLength(2000);

    const config = {
      observer: { lat: 38.8512, lon: -77.0402, altM: 12, label: 'DCA', source: 'preset' as const },
      radiusKm: 250,
      orbitalScope: 'hemisphere' as const,
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    };

    propagateSatellites(pool, ISS_EPOCH_MS, config);

    const latenciesMs: number[] = [];
    let lastResult!: ReturnType<typeof propagateSatellites>;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      lastResult = propagateSatellites(pool, ISS_EPOCH_MS + run * 100, config);
      latenciesMs.push(performance.now() - t0);
    }

    const medianMs = latenciesMs.slice().sort((a, b) => a - b)[2];
    console.info(
      `[Challenge 3] 2,000-sat propagation median=${medianMs.toFixed(2)}ms (samples=${latenciesMs
        .map((n) => n.toFixed(2))
        .join(',')}ms, visible=${lastResult.meta.length})`
    );

    expect(lastResult.kinematics).toBeInstanceOf(Float32Array);
    expect(lastResult.kinematics.length).toBe(lastResult.meta.length * SAT_KINEMATICS_STRIDE);
    expect(lastResult.meta.length).toBeGreaterThan(50);

    for (let i = 0; i < lastResult.kinematics.length; i++) {
      expect(Number.isFinite(lastResult.kinematics[i])).toBe(true);
    }

    const unpacked = unpackSatelliteKinematics(
      lastResult.kinematics,
      lastResult.meta,
      ISS_EPOCH_MS + 400
    );
    expect(unpacked).toHaveLength(lastResult.meta.length);

    expect(
      medianMs,
      `2,000-sat propagation median ${medianMs.toFixed(2)}ms exceeded 100ms budget`
    ).toBeLessThan(100);
  });
});

describe('Challenge 4 — Zero Phantom Aircraft & Multi-API Blackout Chaos', () => {
  const DCA: ObserverLocation = {
    lat: 38.8512,
    lon: -77.0402,
    altM: 12,
    label: 'DCA',
    source: 'preset',
  };
  const HEATHROW: ObserverLocation = {
    lat: 51.47,
    lon: -0.4543,
    altM: 25,
    label: 'EGLL Heathrow',
    source: 'preset',
  };

  beforeEach(() => {
    clearFlightsServiceCache();
    clearTleCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('proves fallback-flights.json does not exist on disk and SIM-ODID defaults to disabled', async () => {
    const fs = await loadNodeFs();
    expect(
      fs.existsSync(repoFileUrl('public/data/fallback-flights.json')),
      'Obsolete public/data/fallback-flights.json must not exist in Sprint 02'
    ).toBe(false);
    expect(useSkyStore.getState().odidConfig.simulatorEnabled).toBe(false);
  });

  it('returns 0 fabricated aircraft and honest status under TypeError, 429, 503, truncated JSON, and offline', async () => {
    const chaosScenarios: Array<{
      name: string;
      external: (url: string) => Promise<Response>;
      expectedFlightStatus: 'error' | 'rate-limited' | 'offline';
      offline?: boolean;
    }> = [
      {
        name: 'TypeError(Failed to fetch)',
        external: async () => {
          throw new TypeError('Failed to fetch');
        },
        expectedFlightStatus: 'error',
      },
      {
        name: 'HTTP 429 Rate Limited',
        external: async () =>
          new Response('Rate limit exceeded', { status: 429, statusText: 'Too Many Requests' }),
        expectedFlightStatus: 'rate-limited',
      },
      {
        name: 'HTTP 503 Service Unavailable',
        external: async () =>
          new Response('Upstream unavailable', { status: 503, statusText: 'Service Unavailable' }),
        expectedFlightStatus: 'error',
      },
      {
        name: 'Truncated / Corrupt JSON',
        external: async () => new Response('{"ac":[{"hex":"a12', { status: 200 }),
        expectedFlightStatus: 'error',
      },
      {
        name: 'Navigator Offline',
        external: async () => {
          throw new TypeError('Failed to fetch');
        },
        expectedFlightStatus: 'offline',
        offline: true,
      },
    ];

    for (const scenario of chaosScenarios) {
      clearFlightsServiceCache();
      clearTleCache();
      vi.stubGlobal('navigator', { onLine: !scenario.offline });
      const fetchSpy = makeSeededStaticAwareFetch(scenario.external);
      vi.stubGlobal('fetch', fetchSpy);

      const flights = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
      expect(flights.status, `${scenario.name} flights.status`).toBe(scenario.expectedFlightStatus);
      expect(flights.entities, `${scenario.name} flights.entities must be empty`).toEqual([]);
      expect(flights.timestampMs, `${scenario.name} timestampMs must be 0 when no live cache`).toBe(0);

      const fetchedUrls = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0])
      );
      expect(
        fetchedUrls.some((u) => u.includes('fallback-flights.json')),
        `${scenario.name} must never fetch fallback-flights.json`
      ).toBe(false);

      const balloons = await fetchBalloons(DCA, 120);
      expect(balloons.status, `${scenario.name} balloons.status`).toBe('error');
      expect(balloons.entities).toEqual([]);

      const airspaceUs = await fetchAirspace(DCA, 120);
      expect(airspaceUs.status, `${scenario.name} airspaceUs.status`).toBe('fallback');
      expect(airspaceUs.airspace.usCoverage).toBe(true);
      expect(airspaceUs.airspace.uasfm.features.length).toBeGreaterThan(0);

      const airspaceUk = await fetchAirspace(HEATHROW, 120);
      expect(airspaceUk.airspace.usCoverage, `${scenario.name} Heathrow usCoverage`).toBe(false);
      expect(airspaceUk.airspace.uasfm.features).toHaveLength(0);

      const tles = await refreshTlesIfStale(true);
      expect(tles.status, `${scenario.name} tles.status`).toBe('fallback');
      expect(tles.records.length, `${scenario.name} tles.records`).toBeGreaterThan(0);

      const cold = await loadInitialTles();
      expect(cold.length).toBeGreaterThan(0);
    }

    // Fresh <= 45s live cache preserves verified aircraft as delayed or rate-limited (never phantom)
    clearFlightsServiceCache();
    vi.stubGlobal('navigator', { onLine: true });
    const nowMs = Date.now();
    const freshLive = normalizeAdsbxAircraft(
      {
        hex: 'a10999',
        flight: 'LIVE999',
        lat: 38.86,
        lon: -77.05,
        alt_baro: 9000,
        gs: 260,
        track: 120,
        seen_pos: 12,
      },
      DCA,
      undefined,
      nowMs
    )!;
    vi.stubGlobal(
      'fetch',
      makeSeededStaticAwareFetch(async () => new Response('Unavailable', { status: 503 }))
    );
    const delayedRes = await fetchFlightsCascade(DCA, 120, [freshLive], { force: true });
    expect(delayedRes.status).toBe('delayed');
    expect(delayedRes.entities.map((e) => e.id)).toEqual([freshLive.id]);

    clearFlightsServiceCache();
    vi.stubGlobal(
      'fetch',
      makeSeededStaticAwareFetch(async () => new Response('Rate limited', { status: 429 }))
    );
    const rlDelayedRes = await fetchFlightsCascade(DCA, 120, [freshLive], { force: true });
    expect(rlDelayedRes.status).toBe('rate-limited');
    expect(rlDelayedRes.entities.map((e) => e.id)).toEqual([freshLive.id]);

    // Total blackout where even ./data/* fallback assets fail with TypeError
    clearFlightsServiceCache();
    clearTleCache();
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const totalBlackoutFlights = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(totalBlackoutFlights.status).toBe('error');
    expect(totalBlackoutFlights.entities).toEqual([]);

    const totalBlackoutAirspace = await fetchAirspace(DCA, 120);
    expect(totalBlackoutAirspace.status).toBe('error');
    expect(totalBlackoutAirspace.airspace.uasfm.features).toEqual([]);

    const totalBlackoutTles = await refreshTlesIfStale(true);
    expect(totalBlackoutTles.status).toBe('fallback');
    expect(totalBlackoutTles.records).toEqual([]);
  });

  it('prunes onGround, seen_pos > 60s, stale timestamp > 60s, Null Island, and out-of-range aircraft + guards zero-track drift', async () => {
    const deadSeaObs: ObserverLocation = {
      lat: 31.5,
      lon: 35.5,
      altM: -410,
      label: 'Dead Sea',
      source: 'manual',
    };

    const deadSeaPlane = normalizeAdsbxAircraft(
      {
        hex: 'a10002',
        flight: 'ISR404',
        lat: 31.51,
        lon: 35.48,
        alt_baro: -1279.5275,
        alt_geom: -1279.5275,
        gs: 130,
        track: null,
      },
      deadSeaObs
    );
    expect(deadSeaPlane).not.toBeNull();
    expect(deadSeaPlane?.onGround).toBe(false);
    expect(deadSeaPlane?.altM).toBeCloseTo(-390, 0);
    expect(deadSeaPlane?.altBaroM).toBeCloseTo(-390, 0);
    expect(deadSeaPlane?.headingDeg).toBe(0);
    expect(deadSeaPlane?.headingValid).toBe(false);
    expect(formatInspectorHeading(deadSeaPlane!.headingDeg, deadSeaPlane!.headingValid)).toBe(
      'TRACK UNKNOWN'
    );

    // Null Island & missing coordinates rejected
    expect(
      normalizeAdsbxAircraft({ hex: 'a10003', lat: 0, lon: 0, alt_baro: 5000 }, HEATHROW)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft(
        { hex: 'a10003', lat: undefined, lon: -0.4543, alt_baro: 5000, track: null },
        HEATHROW
      )
    ).toBeNull();

    // OpenSky track=null without prior fix emits headingValid=false
    const osNoTrack = normalizeOpenSkyState(
      ['a77771', 'NOTRK', 'US', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), -77.04, 38.85, 5000, false, 200, null],
      DCA
    );
    expect(osNoTrack).not.toBeNull();
    expect(osNoTrack?.headingValid).toBe(false);
    expect(osNoTrack?.headingDeg).toBe(0);

    // fetchFlightsCascade excludes onGround, seen_pos > 60s, seen > 60s, Null Island, and groundDistKm > radiusKm
    const outOfRange = greatCircleDestination(DCA.lat, DCA.lon, 90, 130);
    const inRange = greatCircleDestination(DCA.lat, DCA.lon, 90, 95);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('adsb.lol')) {
          return new Response(
            JSON.stringify({
              ac: [
                { hex: 'a20001', flight: 'GND', lat: 38.86, lon: -77.05, alt_baro: 'ground', gs: 12, track: 90, seen_pos: 1 },
                { hex: 'a20002', flight: 'GNDFLAG', lat: 38.86, lon: -77.05, alt_baro: 100, ground: true, gs: 12, track: 90, seen_pos: 1 },
                { hex: 'a20003', flight: 'STALEPOS', lat: 38.86, lon: -77.05, alt_baro: 8000, gs: 220, track: 90, seen_pos: 61 },
                { hex: 'a20004', flight: 'STALETS', lat: 38.86, lon: -77.05, alt_baro: 8000, gs: 220, track: 90, seen: 65 },
                { hex: 'a20005', flight: 'NULLISL', lat: 0, lon: 0, alt_baro: 8000, gs: 220, track: 90, seen_pos: 2 },
                { hex: 'a20006', flight: 'OUTRANGE', lat: outOfRange.lat, lon: outOfRange.lon, alt_baro: 8000, gs: 220, track: 90, seen_pos: 2 },
                { hex: 'a20007', flight: 'VALIDIN', lat: inRange.lat, lon: inRange.lon, alt_baro: 12000, gs: 280, track: null, seen_pos: 4 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );

    const cascade = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(cascade.status).toBe('live');
    expect(cascade.entities.map((e) => e.callsign)).toEqual(['VALIDIN']);
    expect(cascade.entities[0].headingValid).toBe(false);

    // Also verify OpenSky stage inside fetchFlightsCascade excludes onGround, stale (>60s), future (>+60s), Null Island, and out-of-range
    clearFlightsServiceCache();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://opensky-network.org/')) {
          return new Response(
            JSON.stringify({
              states: [
                ['a30001', 'OSGND', 'US', nowSec, nowSec, inRange.lon, inRange.lat, 50, true, 10, 90],
                ['a30002', 'OSOLD', 'US', nowSec - 65, nowSec - 65, inRange.lon, inRange.lat, 5000, false, 220, 90],
                ['a30003', 'OSFUT', 'US', nowSec + 120, nowSec + 120, inRange.lon, inRange.lat, 5000, false, 220, 90],
                ['a30004', 'OSNULL', 'US', nowSec, nowSec, 0, 0, 5000, false, 220, 90],
                ['a30005', 'OSOUT', 'US', nowSec, nowSec, outOfRange.lon, outOfRange.lat, 5000, false, 220, 90],
                ['a30006', 'OSLIVE', 'US', nowSec - 5, nowSec - 5, inRange.lon, inRange.lat, 5000, false, 220, null],
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );
    const osCascade = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(osCascade.status).toBe('live');
    expect(osCascade.provider).toBe('opensky-network');
    expect(osCascade.entities.map((e) => e.callsign)).toEqual(['OSLIVE']);
    expect(osCascade.entities[0].headingValid).toBe(false);

    // App.tsx gates dead-reckoning on headingValid !== false and prunes flights at 60_000ms + radiusKm * 1.02
    expect(appSourceRaw).toContain('raw.headingValid !== false');
    expect(appSourceRaw).toMatch(/pushAtmospheric\(liveKinematicsRegistry\.rawFlights,\s*12,\s*60_000\)/);
    expect(appSourceRaw).toContain('topocentric.groundDistKm > st.radiusKm * 1.02');
    expect(tacticalMapSourceRaw).toContain('entity.headingValid === false');
    expect(tacticalMapSourceRaw).toContain('entity.headingValid !== false');
    expect(polarDomeSourceRaw).toContain('entity.headingValid === false');
  });

  it('preserves status & respects rate-limiter cooldown cleanly on consecutive non-forced calls', async () => {
    const fetchMock = makeSeededStaticAwareFetch(
      async () => new Response('Unavailable', { status: 503 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await fetchFlightsCascade(DCA, 120);
    expect(first.status).toBe('error');
    expect(first.entities).toEqual([]);

    const callsAfterFirst = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await fetchFlightsCascade(DCA, 120, first.entities);
    expect(second.status).toBe('error');
    expect(second.entities).toEqual([]);
    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });

  it('[DEFECT-S2-02] forced fetchFlightsCascade call fails to consume adsbRateLimiter bucket, letting immediate non-forced call bypass 10s cooldown', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('adsb.lol')) {
        return new Response(
          JSON.stringify({
            ac: [{ hex: 'a12345', flight: 'DAL1', lat: 38.86, lon: -77.05, alt_baro: 8000, gs: 240, track: 90 }],
          }),
          { status: 200 }
        );
      }
      return new Response('Unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const forced = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(forced.status).toBe('live');
    const callsAfterForced = fetchMock.mock.calls.length;

    const immediateUnforced = await fetchFlightsCascade(DCA, 120, forced.entities);
    expect(
      fetchMock.mock.calls.length,
      'Non-forced call immediately after forced call bypassed 10s adsbRateLimiter cooldown'
    ).toBe(callsAfterForced);
    expect(immediateUnforced.status).toBe('cached');
  });
});

describe('Challenge 5 — 60fps Memory Hygiene, Cleanup & Sprint 02 Render Probes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('caps trail arrays <= 40 across 100 consecutive updates on flights, balloons, drones, and satellites', () => {
    const obs: ObserverLocation = {
      lat: 38.8512,
      lon: -77.0402,
      altM: 12,
      label: 'DCA',
      source: 'preset',
    };
    const baseMs = 1_760_000_000_000;

    let prevFlight: FlightEntity | undefined;
    for (let i = 0; i < 100; i++) {
      const next = normalizeAdsbxAircraft(
        {
          hex: 'a12345',
          flight: 'UAL100',
          lat: 38.85 + i * 0.002,
          lon: -77.04 + i * 0.002,
          alt_baro: 15000 + i * 20,
          gs: 320,
          track: 45,
        },
        obs,
        prevFlight,
        baseMs + i * 5000
      );
      expect(next).not.toBeNull();
      prevFlight = next ?? undefined;
      expect(prevFlight?.trail.length ?? 0).toBeLessThanOrEqual(40);
    }
    expect(prevFlight?.trail.length).toBeGreaterThan(10);
    expect(prevFlight?.trail.length).toBeLessThanOrEqual(40);

    let prevBalloon: BalloonEntity | undefined;
    for (let i = 0; i < 100; i++) {
      const next = normalizeSondeRecord(
        {
          serial: 'RS41-100',
          lat: 38.86 + i * 0.001,
          lon: -77.05 + i * 0.001,
          alt: 5000 + i * 100,
          vel_v: 5.0,
          vel_h: 15.0,
          datetime: new Date(baseMs + i * 10_000).toISOString(),
        },
        obs,
        { prev: prevBalloon }
      );
      expect(next).not.toBeNull();
      prevBalloon = next ?? undefined;
      expect(prevBalloon?.trail.length ?? 0).toBeLessThanOrEqual(40);
    }
    expect(prevBalloon?.trail.length).toBeGreaterThan(10);
    expect(prevBalloon?.trail.length).toBeLessThanOrEqual(40);

    let prevDrones: DroneEntity[] = [];
    for (let i = 0; i < 100; i++) {
      prevDrones = stepSimulatedDrones(obs, 120, i * 1.5, EMPTY_AIRSPACE, prevDrones);
      for (const d of prevDrones) {
        expect(d.trail.length).toBeLessThanOrEqual(40);
      }
    }

    let prevLiveDrones: DroneEntity[] = [];
    for (let i = 0; i < 100; i++) {
      prevLiveDrones = normalizeOdidPayload(
        [{ uasId: 'LIVE-100', lat: 38.85 + i * 0.0005, lon: -77.04 + i * 0.0005, altAglM: 80 }],
        obs,
        EMPTY_AIRSPACE,
        prevLiveDrones
      );
      expect(prevLiveDrones).toHaveLength(1);
      expect(prevLiveDrones[0].trail.length).toBeLessThanOrEqual(40);
    }

    const parsedIss = parseTleRecords([ISS_TLE]);
    const pool = selectSatellitePool(parsedIss, true);
    let prevSatMap = new Map<string, SatelliteEntity>();
    for (let i = 0; i < 100; i++) {
      const ts = ISS_EPOCH_MS + i * 5000;
      const { kinematics, meta } = propagateSatellites(pool, ts, {
        observer: obs,
        radiusKm: 25_000,
        orbitalScope: 'hemisphere',
        activeGroups: { stations: true, visual: true, starlink: true },
        fullConstellation: true,
      });
      const unpacked = unpackSatelliteKinematics(kinematics, meta, ts, prevSatMap);
      expect(unpacked).toHaveLength(1);
      expect(unpacked[0].trail.length).toBeLessThanOrEqual(40);
      prevSatMap = new Map(unpacked.map((s) => [s.id, s]));
    }
    expect(prevSatMap.get('sat-25544')?.trail.length).toBe(40);
  });

  it('cleans up AstroClient Worker, OpenDroneIdClient handles, and TacticalAudioEngine cleanly on dispose/disconnect', async () => {
    const terminatedSpy = vi.fn();
    let createdFakeWorker: {
      onmessage: ((ev: MessageEvent<WorkerResponseMessage>) => void) | null;
      onerror: ((ev: ErrorEvent) => void) | null;
      postMessage: (msg: WorkerRequestMessage) => void;
      terminate: () => void;
    } | null = null;

    const engine = createAstroWorkerEngine();
    const client = new AstroClient(
      {},
      {
        workerFactory: () => {
          createdFakeWorker = {
            onmessage: null,
            onerror: null,
            postMessage(msg: WorkerRequestMessage) {
              const res = engine.handleMessage(msg);
              if (res && createdFakeWorker?.onmessage) {
                createdFakeWorker.onmessage({ data: res } as MessageEvent<WorkerResponseMessage>);
              }
            },
            terminate: terminatedSpy,
          };
          return createdFakeWorker as unknown as Worker;
        },
      }
    );

    await client.initTles([ISS_TLE], false);
    client.dispose();
    expect(terminatedSpy).toHaveBeenCalledTimes(1);
    expect(createdFakeWorker!.onmessage).toBeNull();
    expect(createdFakeWorker!.onerror).toBeNull();

    const wsCloseSpy = vi.fn();
    let wsInstance: {
      onopen: (() => void) | null;
      onmessage: ((e: MessageEvent) => void) | null;
      onerror: (() => void) | null;
      onclose: (() => void) | null;
      close: () => void;
    } | null = null;

    vi.stubGlobal(
      'WebSocket',
      class FakeWebSocket {
        onopen: (() => void) | null = null;
        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        close = wsCloseSpy;
        constructor() {
          wsInstance = this;
        }
      }
    );

    const obs: ObserverLocation = { lat: 38.85, lon: -77.04, altM: 12, label: 'DCA', source: 'preset' };
    const odid = new OpenDroneIdClient(obs, EMPTY_AIRSPACE, {
      onDrones: () => {},
    });
    odid.connect('ws://127.0.0.1:8765/odid');
    expect(wsInstance).not.toBeNull();
    odid.disconnect();
    expect(wsCloseSpy).toHaveBeenCalledTimes(1);
    expect(wsInstance!.onmessage).toBeNull();
    expect(wsInstance!.onclose).toBeNull();

    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      })
    );
    odid.connect('http://127.0.0.1:8765/odid.json', 1000);
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);
    odid.disconnect();
    expect(capturedSignal?.aborted).toBe(true);

    const audio = new TacticalAudioEngine();
    expect(useSkyStore.getState().audioEnabled).toBe(false);
    audio.playSweepPulse();
    audio.playTargetLock();
    audio.playZenithChime();
    audio.playAlertTone();
    audio.dispose();
  });

  it('preserves Sprint 01 fixes: sat- prefix, 6h balloon TTL, permalink alt/label, ODID clear, cursor/audio/ControlDock & worker error settlement', async () => {
    expect(appSourceRaw).toContain("startsWith('sat-')");

    expect(balloonsSourceRaw).toContain('last=10800');
    const match = appSourceRaw.match(
      /pushAtmospheric\(liveKinematicsRegistry\.rawBalloons,\s*\d+,\s*([\d_]+)\)/
    );
    expect(match).not.toBeNull();
    expect(Number(match![1].replaceAll('_', ''))).toBeGreaterThanOrEqual(10_800_000);

    const buildHashBlock = appSourceRaw.slice(
      appSourceRaw.indexOf('function buildUrlHashString'),
      appSourceRaw.indexOf('export default function App')
    );
    expect(buildHashBlock).toContain("params.set('label'");
    expect(buildHashBlock).toContain("params.set('alt'");
    expect(formatInspectorAltitude(420_000, 'aviation')).toMatch(/^420(\.0)? km$/);
    expect(formatInspectorSpeed(7660, 'aviation')).toContain('km/s');
    expect(formatInspectorDoppler(8420)).toContain('kHz');

    const cleanupSlice = appSourceRaw.slice(
      appSourceRaw.indexOf('// 5. OpenDroneID Live Client'),
      appSourceRaw.indexOf('// 6. Target Lock Audio Feedback')
    );
    expect(cleanupSlice).toContain('liveWebhookDronesRef.current.clear()');

    expect(/style=\{\{[^}]*cursor:\s*'crosshair'/.test(polarDomeSourceRaw)).toBe(false);
    const hoverSyncSlice = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.indexOf('// Refresh active hover tooltip'),
      tacticalMapSourceRaw.indexOf('const containerWidth')
    );
    expect(hoverSyncSlice).toContain('setHoveredId(null)');

    const sweepCallers =
      (appSourceRaw.includes('playSweepPulse()') ? 1 : 0) +
      (polarDomeSourceRaw.includes('playSweepPulse()') ? 1 : 0);
    expect(sweepCallers).toBe(1);

    const mapOrbitScope = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.indexOf('function buildOrbitOverlayFc'),
      tacticalMapSourceRaw.indexOf('// Smooth camera follow')
    );
    expect(mapOrbitScope).toContain('satellite');

    const selectBlock = controlDockSourceRaw.slice(
      controlDockSourceRaw.indexOf('const selectSearchResult'),
      controlDockSourceRaw.indexOf('const handleSearchKeyDown')
    );
    expect(/Ref\.current\s*=|selectedLabel/.test(selectBlock)).toBe(true);

    const client = new AstroClient(
      {},
      {
        workerFactory: () => {
          const fakeWorker = {
            onmessage: null as ((ev: MessageEvent<WorkerResponseMessage>) => void) | null,
            onerror: null,
            postMessage(msg: WorkerRequestMessage) {
              if (msg.type === 'compute-orbit' && fakeWorker.onmessage) {
                fakeWorker.onmessage({
                  data: { type: 'error', message: 'Simulated SGP4 worker error' },
                } as MessageEvent<WorkerResponseMessage>);
              }
            },
            terminate() {},
          };
          return fakeWorker as unknown as Worker;
        },
      }
    );

    const outcome = await Promise.race([
      client.computeOrbit(25544, ISS_EPOCH_MS, EXTREME_OBSERVERS[0].observer).then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
    ]);
    client.dispose();
    expect(outcome).toBe('settled');
  });

  it('verifies PolarSkyDome & TacticalMap Sprint 02 render, pitch-lock, recenterNonce, deduplication, and cleanup hygiene', () => {
    // 1. Identity-transform clearRect(0, 0, canvas.width, canvas.height)
    expect(polarDomeSourceRaw).toContain('ctx.setTransform(1, 0, 0, 1, 0, 0)');
    expect(polarDomeSourceRaw).toContain('ctx.clearRect(0, 0, canvas.width, canvas.height)');
    expect(tacticalMapSourceRaw).toContain('ctx.setTransform(1, 0, 0, 1, 0, 0)');
    expect(tacticalMapSourceRaw).toContain('ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height)');

    // 2. Immediate polar trail pruning with zero +40 slack retention
    expect(polarDomeSourceRaw).not.toMatch(/polarTrailsRef\.current\.size\s*>\s*activeIds\.size\s*\+\s*40/);
    // Sprint 04 refactor removed comment anchors; assert prune statements directly.
    expect(polarDomeSourceRaw).toContain('if (!activeIds.has(key)) polarTrailsRef.current.delete(key)');
    expect(polarDomeSourceRaw).toContain('if (!activeIds.has(key)) lastTrailSampleRef.current.delete(key)');

    // 3. MapLibre pitch lock + recenterNonce + deduplication
    expect(tacticalMapSourceRaw).toContain('maxPitch: 0');
    expect(tacticalMapSourceRaw).toContain('touchPitch: false');
    expect(tacticalMapSourceRaw).toContain('pitchWithRotate: false');
    expect(tacticalMapSourceRaw).toContain('recenterNonce');
    expect(tacticalMapSourceRaw).toContain('if (seenIds.has(entity.id)) continue;');

    const baseNonce = useSkyStore.getState().recenterNonce;
    useSkyStore.getState().bumpRecenterNonce();
    expect(useSkyStore.getState().recenterNonce).toBe(baseNonce + 1);
    useSkyStore.getState().setObserver({
      lat: 35.5494,
      lon: 139.7798,
      altM: 11,
      label: 'Haneda',
      source: 'preset',
    });
    expect(useSkyStore.getState().recenterNonce).toBe(baseNonce + 2);

    // 4. Cleanup of listeners, ResizeObserver, and rAF on unmount
    const mapCleanup = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.lastIndexOf('return () => {'),
      tacticalMapSourceRaw.indexOf('// Sync observer, scan ring, and recenter')
    );
    expect(mapCleanup).toContain('cancelAnimationFrame(rafId)');
    expect(mapCleanup).toContain('resizeObserver.disconnect()');
    expect(mapCleanup).toContain("window.removeEventListener('resize', handleWindowResize)");
    expect(mapCleanup).toContain("map.off('mousemove', LAYER_IDS.entitiesSymbol, handleMouseMove)");
    expect(mapCleanup).toContain("removeEventListener('webglcontextlost', handleCanvasContextLost)");
    expect(mapCleanup).toContain('map.remove()');

    const domeCleanup = polarDomeSourceRaw.slice(
      polarDomeSourceRaw.indexOf('rafId = requestAnimationFrame(renderFrame);'),
      polarDomeSourceRaw.indexOf('const findNearestHit')
    );
    expect(domeCleanup).toContain('cancelAnimationFrame(rafId)');
    expect(domeCleanup).toContain('observerRO?.disconnect()');
    expect(domeCleanup).toContain("window.removeEventListener('resize', onWinResize)");
  });

  it('[DEFECT-S2-01] App.tsx >50km observer jump clears rawFlights without resetting feeds.flights.lastUpdatedMs, leaking prior region timestamp on offline/error', () => {
    const jumpStart = appSourceRaw.indexOf('if (jumpKm > 50)');
    expect(jumpStart).toBeGreaterThan(-1);
    const jumpEnd = appSourceRaw.indexOf('const timer = window.setTimeout', jumpStart);
    expect(jumpEnd).toBeGreaterThan(jumpStart);
    const jumpBlock = appSourceRaw.slice(jumpStart, jumpEnd);
    expect(
      jumpBlock.includes('lastUpdatedMs: null'),
      'App.tsx jumpKm > 50 clears rawFlights without resetting feeds.flights.lastUpdatedMs to null, leaving stale prior-region timestamp in HUD on failure/offline'
    ).toBe(true);
  });

  it('supports runtime dead-reckoning & negative altitude preservation without NaN', () => {
    const next = extrapolateDeadReckoning(0, 179.99, 250, 90, 10, 10_000, 0);
    expect(Number.isFinite(next.lat)).toBe(true);
    expect(Number.isFinite(next.lon)).toBe(true);
    expect(next.lon).toBeLessThan(-179);
    expect(next.lon).toBeGreaterThanOrEqual(-180);

    const negExtrap = extrapolateDeadReckoning(31.5, 35.5, 50, 90, 5, -390, 0);
    expect(negExtrap.altM).toBe(-390);
  });
});

describe('Challenge 6 — PWA Manifest, Binary Raster PNGs & Service Worker Integrity', () => {
  it('validates public/manifest.json fields, relative paths, and icon definitions', async () => {
    const fs = await loadNodeFs();
    const manifestUrl = repoFileUrl('public/manifest.json');
    expect(fs.existsSync(manifestUrl)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8')) as {
      start_url: string;
      scope: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };

    expect(manifest.start_url).toBe('./');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color.toUpperCase()).toBe('#06090F');
    expect(manifest.theme_color.toUpperCase()).toBe('#06090F');

    const icon192 = manifest.icons.find((i) => i.sizes === '192x192');
    const icon512 = manifest.icons.find((i) => i.sizes === '512x512');
    expect(icon192).toMatchObject({
      src: './icons/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any maskable',
    });
    expect(icon512).toMatchObject({
      src: './icons/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    });
  });

  it('verifies exact binary PNG signatures and big-endian IHDR dimensions for all PWA raster icons', async () => {
    const fs = await loadNodeFs();
    const expectedSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const decoder = new TextDecoder('ascii');
    const hasAsciiChunk = (bytes: Uint8Array, tag: string): boolean => {
      const t = [tag.charCodeAt(0), tag.charCodeAt(1), tag.charCodeAt(2), tag.charCodeAt(3)];
      for (let i = 0; i <= bytes.length - 4; i += 1) {
        if (bytes[i] === t[0] && bytes[i + 1] === t[1] && bytes[i + 2] === t[2] && bytes[i + 3] === t[3]) {
          return true;
        }
      }
      return false;
    };

    const targets: Array<{ file: string; width: number; height: number }> = [
      { file: 'public/icons/icon-192.png', width: 192, height: 192 },
      { file: 'public/icons/icon-512.png', width: 512, height: 512 },
      { file: 'public/icons/apple-touch-icon.png', width: 180, height: 180 },
    ];

    for (const target of targets) {
      const bytes = fs.readFileSync(repoFileUrl(target.file));
      expect(bytes.length, `${target.file} must be non-empty`).toBeGreaterThan(64);
      expect(Array.from(bytes.subarray(0, 8)), `${target.file} PNG magic bytes`).toEqual(
        expectedSignature
      );

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getUint32(8, false), `${target.file} IHDR chunk length`).toBe(13);
      expect(decoder.decode(bytes.subarray(12, 16)), `${target.file} IHDR chunk type`).toBe('IHDR');
      expect(view.getUint32(16, false), `${target.file} width`).toBe(target.width);
      expect(view.getUint32(20, false), `${target.file} height`).toBe(target.height);
      expect(hasAsciiChunk(bytes, 'IDAT'), `${target.file} IDAT chunk`).toBe(true);
      expect(hasAsciiChunk(bytes, 'IEND'), `${target.file} IEND chunk`).toBe(true);
    }
  });

  it('verifies public/sw.js cache hygiene, activate pruning, and strict bypass of telemetry & /api-proxy/', async () => {
    const fs = await loadNodeFs();
    const vm = await loadNodeVm();
    const swSource = fs.readFileSync(repoFileUrl('public/sw.js'), 'utf8');

    expect(swSource).toContain("const CACHE_VERSION = 'krunked-skymap-v5'");
    expect(swSource).toContain("addEventListener('install'");
    expect(swSource).toContain("addEventListener('activate'");
    expect(swSource).toContain("addEventListener('fetch'");
    expect(swSource).toContain('caches.delete');
    expect(swSource).toContain("url.origin !== self.location.origin");
    expect(swSource).toContain("url.pathname.includes('/api-proxy/')");
    expect(swSource).toContain('networkFirst');

    // Execute sw.js in an isolated VM sandbox to prove runtime bypass vs shell handling
    const listeners = new Map<string, (ev: unknown) => void>();
    const deletedCaches: string[] = [];
    const openedCaches = new Map<string, Map<string, Response>>();
    const mockFetch = vi.fn(async () => new Response('shell-ok', { status: 200 }));

    const sandboxSelf = {
      location: {
        origin: 'https://example.github.io',
        href: 'https://example.github.io/krunked_skymap/sw.js',
      },
      addEventListener(type: string, cb: (ev: unknown) => void) {
        listeners.set(type, cb);
      },
      skipWaiting: vi.fn(async () => {}),
      clients: { claim: vi.fn(async () => {}) },
    };

    const sandboxCaches = {
      async open(name: string) {
        let store = openedCaches.get(name);
        if (!store) {
          store = new Map<string, Response>();
          openedCaches.set(name, store);
        }
        return {
          async add(req: Request | string) {
            const key = typeof req === 'string' ? req : req.url;
            store!.set(key, new Response('precached', { status: 200 }));
          },
          async put(req: Request | string, res: Response) {
            const key = typeof req === 'string' ? req : req.url;
            store!.set(key, res);
          },
        };
      },
      async keys() {
        return [
          'krunked-skymap-v1',
          'krunked-skymap-v2',
          'krunked-skymap-v3',
          'krunked-skymap-v4',
          'krunked-skymap-v5',
        ];
      },
      async delete(key: string) {
        deletedCaches.push(key);
        return true;
      },
      async match() {
        return undefined;
      },
    };

    vm.runInNewContext(swSource, {
      self: sandboxSelf,
      caches: sandboxCaches,
      fetch: mockFetch,
      URL,
      Request,
      Response,
      Promise,
    });

    // Activate deletes old cache versions while keeping current CACHE_VERSION (krunked-skymap-v5)
    const activateTasks: Array<Promise<unknown>> = [];
    listeners.get('activate')?.({
      waitUntil(p: Promise<unknown>) {
        activateTasks.push(p);
      },
    });
    await Promise.all(activateTasks);
    expect(deletedCaches).toEqual([
      'krunked-skymap-v1',
      'krunked-skymap-v2',
      'krunked-skymap-v3',
      'krunked-skymap-v4',
    ]);
    expect(deletedCaches).not.toContain('krunked-skymap-v5');

    // Telemetry, CORS relays (r.jina.ai), and /api-proxy/ URLs MUST bypass respondWith()
    const fetchListener = listeners.get('fetch')!;
    const bypassUrls = [
      'https://r.jina.ai/https://opendata.adsb.fi/api/v3/lat/38.8512/lon/-77.0402/dist/65?_=123',
      'https://r.jina.ai/https://api.adsb.lol/v2/point/38.8512/-77.0402/65?_=123',
      'https://api.adsb.lol/v2/point/38.85/-77.04/65',
      'https://opensky-network.org/api/states/all?lamin=38&lomin=-78&lamax=39&lomax=-76',
      'https://api.v2.sondehub.org/sondes?lat=38.85&lon=-77.04',
      'https://example.github.io/krunked_skymap/api-proxy/adsb-fi/api/v3/lat/38.85/lon/-77.04/dist/65',
    ];
    for (const url of bypassUrls) {
      const respondWith = vi.fn();
      fetchListener({
        request: { method: 'GET', cache: 'default', mode: 'cors', url },
        respondWith,
      });
      expect(respondWith, `SW must bypass ${url}`).not.toHaveBeenCalled();
    }

    // Same-origin app shell URL MUST be intercepted via respondWith(networkFirst)
    const shellRespondWith = vi.fn();
    fetchListener({
      request: {
        method: 'GET',
        cache: 'default',
        mode: 'navigate',
        destination: 'document',
        url: 'https://example.github.io/krunked_skymap/index.html',
      },
      respondWith: shellRespondWith,
    });
    expect(shellRespondWith).toHaveBeenCalledTimes(1);
    await shellRespondWith.mock.calls[0][0];
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('audits index.html and vite.config.ts for relative PWA metadata, SW registration, and proxy routes', async () => {
    const fs = await loadNodeFs();
    const indexHtml = fs.readFileSync(repoFileUrl('index.html'), 'utf8');
    expect(indexHtml).toContain('href="./manifest.json"');
    expect(indexHtml).toContain('href="./icons/apple-touch-icon.png"');
    expect(indexHtml).toContain('name="theme-color" content="#06090F"');
    expect(indexHtml).toContain("navigator.serviceWorker.register('./sw.js', { scope: './' })");

    const viteConfig = fs.readFileSync(repoFileUrl('vite.config.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(viteConfig).toContain("base: './'");
    expect(viteConfig).toContain("'/api-proxy/adsb-fi'");
    expect(viteConfig).toContain("'/api-proxy/adsb-lol'");
    expect(viteConfig).toContain("'/api-proxy/airplanes-live'");
    expect(viteConfig).toContain("proxyReq.removeHeader('origin')");
    expect(viteConfig).toContain("proxyReq.removeHeader('referer')");
    expect(viteConfig).toContain(
      "proxyReq.setHeader(\n      'User-Agent',\n      'KrunkedSkyMap/2.0 (+https://github.com/krunked-fpv/krunked_skymap)'"
    );
    expect(viteConfig).toContain('server: {\n    proxy: adsbApiProxy,');
    expect(viteConfig).toContain('preview: {\n    proxy: adsbApiProxy,');
  });
});

describe('Challenge 7 — Sprint 02.1 Live ADS-B CORS Relays, Fast-Bypass & Circuit-Breaker Recovery', () => {
  const DCA: ObserverLocation = {
    lat: 38.8512,
    lon: -77.0402,
    altM: 12,
    label: 'DCA',
    source: 'preset',
  };

  beforeEach(() => {
    clearFlightsServiceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('enforces zero-preflight simple-GET header hygiene on all r.jina.ai CORS relay fetch() calls', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    const capturedCalls: Array<{ url: string; init?: RequestInit }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        capturedCalls.push({ url, init });
        if (url.startsWith('https://r.jina.ai/https://api.adsb.lol/')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'a12345',
                  flight: 'SIMPLE1',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 10000,
                  gs: 260,
                  track: 90,
                  seen_pos: 2,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Upstream unavailable', { status: 503 });
      })
    );

    const res = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(res.status).toBe('live');
    expect(res.provider).toBe('cors-relay:adsb.lol');
    expect(res.entities).toHaveLength(1);

    const relayCalls = capturedCalls.filter((c) => c.url.startsWith('https://r.jina.ai/'));
    expect(relayCalls).toHaveLength(2);
    expect(relayCalls[0].url).toContain('https://r.jina.ai/https://opendata.adsb.fi/api/v3/');
    expect(relayCalls[1].url).toContain('https://r.jina.ai/https://api.adsb.lol/v2/');

    for (const call of relayCalls) {
      expect(call.init?.method === undefined || call.init.method.toUpperCase() === 'GET').toBe(true);
      expect(
        call.init?.headers,
        `r.jina.ai call ${call.url} must omit custom headers (e.g., Accept: application/json) to avoid CORS OPTIONS preflight`
      ).toBeUndefined();
    }
  });

  it('extracts Markdown Content payloads while rejecting upstream {Error}, HTML, and truncated JSON with 0 phantom aircraft', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });

    const validMarkdown = [
      'Title: ',
      '',
      'URL Source: https://opendata.adsb.fi/api/v3/lat/38.8512/lon/-77.0402/dist/65',
      '',
      'Markdown Content:',
      JSON.stringify({
        aircraft: [
          {
            hex: 'a88001',
            flight: 'JINA1',
            lat: 38.86,
            lon: -77.05,
            alt_baro: 11000,
            gs: 280,
            track: 135,
            seen_pos: 3,
          },
        ],
      }),
    ].join('\n');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(validMarkdown, { status: 200 });
        }
        return new Response('Unexpected downstream', { status: 503 });
      })
    );

    const validRes = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(validRes.status).toBe('live');
    expect(validRes.provider).toBe('cors-relay:adsb.fi');
    expect(validRes.entities.map((e) => e.callsign)).toEqual(['JINA1']);

    // Direct helper rejection proofs (including { Error, ac: [...] } poisoning attempt)
    expect(() =>
      extractRelayedJsonPayload(
        JSON.stringify({ Error: 'Quota exceeded', ac: [{ hex: 'a99999', lat: 38.86, lon: -77.05 }] }),
        'cors-relay:adsb.fi'
      )
    ).toThrow('Quota exceeded');
    expect(() =>
      extractRelayedJsonPayload(
        'Title: Gate\n\nMarkdown Content:\n<!DOCTYPE html><html><body>502</body></html>',
        'cors-relay:adsb.fi'
      )
    ).toThrow('Invalid payload from cors-relay:adsb.fi');

    const poisonedBodies = [
      {
        name: 'Upstream { Error } alongside ac[]',
        body: `Markdown Content:\n${JSON.stringify({
          Error: 'Rate limit exceeded',
          ac: [{ hex: 'a99999', flight: 'PHANTOM', lat: 38.86, lon: -77.05, alt_baro: 9000, gs: 250, track: 90 }],
        })}`,
      },
      {
        name: 'Jina { data: { content } } containing { Error }',
        body: JSON.stringify({
          code: 200,
          data: {
            content: JSON.stringify({
              Error: 'Upstream rejected',
              aircraft: [{ hex: 'a99998', flight: 'PHANTOM2', lat: 38.86, lon: -77.05, alt_baro: 9000 }],
            }),
          },
        }),
      },
      {
        name: 'HTML <!DOCTYPE html> gateway page',
        body: '<!DOCTYPE html><html><head><title>502</title></head><body>Bad Gateway</body></html>',
      },
      {
        name: 'Markdown Content wrapping HTML <!DOCTYPE html>',
        body: 'Title: 502\n\nMarkdown Content:\n<!DOCTYPE html><html><body>Blocked</body></html>',
      },
      {
        name: 'Truncated JSON inside Markdown Content',
        body: 'Title: \n\nMarkdown Content:\n{"aircraft":[{"hex":"a12345","flight":"CUT',
      },
    ];

    for (const poisoned of poisonedBodies) {
      clearFlightsServiceCache();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.startsWith('https://r.jina.ai/')) {
            return new Response(poisoned.body, { status: 200 });
          }
          return new Response('Upstream unavailable', { status: 503 });
        })
      );

      const res = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
      expect(res.status, `${poisoned.name} status`).toBe('error');
      expect(res.entities, `${poisoned.name} must yield 0 phantom aircraft`).toEqual([]);
    }
  });

  it('fast-bypasses localhost static-server 404 and 200 HTML proxy responses straight into cors-relay:adsb.fi without leaking 404', async () => {
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
    const calls404: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls404.push(url);
        if (url.startsWith('/api-proxy/adsb-fi/')) {
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        if (url.startsWith('/api-proxy/adsb-lol/') || url.startsWith('/api-proxy/airplanes-live/')) {
          throw new Error(`Fast-bypass failed: unexpected Stage 1 call to ${url}`);
        }
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            `Markdown Content:\n${JSON.stringify({
              aircraft: [
                {
                  hex: 'a70001',
                  flight: 'STAT404',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 8500,
                  gs: 240,
                  track: 180,
                  seen_pos: 1,
                },
              ],
            })}`,
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const bypass404 = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(bypass404.status).toBe('live');
    expect(bypass404.provider).toBe('cors-relay:adsb.fi');
    expect(bypass404.httpStatus).toBeUndefined();
    expect(bypass404.errorMsg).toBeUndefined();
    expect(bypass404.entities.map((e) => e.callsign)).toEqual(['STAT404']);
    expect(calls404).toHaveLength(2);
    expect(calls404[0]).toContain('/api-proxy/adsb-fi/');
    expect(calls404[1]).toContain('https://r.jina.ai/https://opendata.adsb.fi/');

    // Also verify 200 HTML SPA fallback at localhost fast-bypasses cleanly and never leaks 404 or proxy failure
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const callsHtml: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        callsHtml.push(url);
        if (url.startsWith('/api-proxy/adsb-fi/')) {
          return new Response('<!DOCTYPE html><html><body>Vite SPA Shell</body></html>', { status: 200 });
        }
        if (url.startsWith('/api-proxy/adsb-lol/') || url.startsWith('/api-proxy/airplanes-live/')) {
          throw new Error(`Fast-bypass failed on HTML proxy response: ${url}`);
        }
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              aircraft: [
                {
                  hex: 'a70002',
                  flight: 'HTMLBYP',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 9500,
                  gs: 250,
                  track: 45,
                  seen_pos: 2,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const bypassHtml = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(bypassHtml.status).toBe('live');
    expect(bypassHtml.provider).toBe('cors-relay:adsb.fi');
    expect(bypassHtml.httpStatus).toBeUndefined();
    expect(bypassHtml.entities.map((e) => e.callsign)).toEqual(['HTMLBYP']);
    expect(callsHtml).toHaveLength(2);
  });

  it('recovers immediately on resetBreakers: true manual sweep while background resetBreakers: false honors open circuit cooldowns and prevents tight polling loops', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' }))
    );

    for (let i = 0; i < 3; i++) {
      const trip = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
      expect(trip.status).toBe('rate-limited');
      expect(trip.httpStatus).toBe(429);
    }

    expect(flightsCircuitBreaker.getState('cors-relay-adsb-fi')).toBe('open');
    expect(flightsCircuitBreaker.getState('adsb.lol')).toBe('open');
    expect(flightsCircuitBreaker.getState('opensky')).toBe('open');

    const healthyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
        return new Response(
          `Markdown Content:\n${JSON.stringify({
            aircraft: [
              {
                hex: 'a60001',
                flight: 'RECOV1',
                lat: 38.86,
                lon: -77.05,
                alt_baro: 14000,
                gs: 310,
                track: 270,
                seen_pos: 1,
              },
            ],
          })}`,
          { status: 200 }
        );
      }
      return new Response('Down', { status: 503 });
    });
    vi.stubGlobal('fetch', healthyFetch);

    // Background 1Hz tick uses resetBreakers: false -> must respect open circuits (0 fetch calls)
    const bgTick = await fetchFlightsCascade(DCA, 120, undefined, {
      force: true,
      resetBreakers: false,
    });
    expect(healthyFetch).not.toHaveBeenCalled();
    expect(bgTick.status).toBe('rate-limited');
    expect(bgTick.httpStatus).toBe(429);
    expect(bgTick.errorMsg).toContain('(HTTP 429)');
    expect(bgTick.entities).toEqual([]);

    // Manual sweep / Retry Live Feed / online recovery uses resetBreakers: true -> immediate recovery
    const manualSweep = await fetchFlightsCascade(DCA, 120, undefined, {
      force: true,
      resetBreakers: true,
    });
    expect(healthyFetch).toHaveBeenCalledTimes(1);
    expect(manualSweep.status).toBe('live');
    expect(manualSweep.provider).toBe('cors-relay:adsb.fi');
    expect(manualSweep.entities.map((e) => e.callsign)).toEqual(['RECOV1']);

    // App.tsx & ControlDock.tsx separation + anti-loop guards
    const normalizedApp = appSourceRaw.replace(/\r\n/g, '\n');
    expect(normalizedApp).toContain('if (flightsInFlightRef.current) return;');
    expect(normalizedApp).toContain('nextFlightsDueMsRef.current = checkedAtMs + 10_000;');
    expect(normalizedApp).toContain('void runFlightsRefresh(shouldForce, false);');

    const manualSweepBlock = normalizedApp.slice(
      normalizedApp.indexOf('// Manual Sweep trigger'),
      normalizedApp.indexOf('// 1Hz Wall-Clock Scheduler')
    );
    expect(manualSweepBlock).toContain('void runFlightsRefresh(true, true);');

    const onlineBlock = normalizedApp.slice(
      normalizedApp.indexOf('const handleOnline = () => {'),
      normalizedApp.indexOf('const handleVisibilityChange = () => {')
    );
    expect(onlineBlock).toContain('void runFlightsRefresh(true, true);');

    const normalizedDock = controlDockSourceRaw.replace(/\r\n/g, '\n');
    const retryGateSlice = normalizedDock.slice(
      normalizedDock.indexOf('const canRetryLiveFeed ='),
      normalizedDock.indexOf('return (', normalizedDock.indexOf('const canRetryLiveFeed ='))
    );
    expect(retryGateSlice).toContain("flightsFeed.status === 'error'");
    expect(retryGateSlice).toContain("flightsFeed.status === 'rate-limited'");
    expect(retryGateSlice).toContain("flightsFeed.status === 'delayed'");
    expect(retryGateSlice).not.toContain("'loading'");
    expect(normalizedDock).toContain('data-testid="dock-feed-retry"');
    expect(normalizedDock).toContain('onClick={onManualSweep}');
  });
});

async function mountAppInJsdom(): Promise<{
  window: Window & typeof globalThis;
  document: Document;
  container: HTMLElement;
  cleanup: () => Promise<void>;
}> {
  const jsdomMod = (await import('jsdom')) as {
    JSDOM: new (
      html: string,
      opts?: Record<string, unknown>
    ) => { window: Window & typeof globalThis };
  };
  const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://krunked-fpv.github.io/krunked_skymap/',
  });

  const w = dom.window as unknown as Record<string, unknown>;
  const domUrl = dom.window.URL as unknown as {
    createObjectURL?: (obj: unknown) => string;
    revokeObjectURL?: (url: string) => void;
  };
  if (typeof domUrl.createObjectURL !== 'function') {
    domUrl.createObjectURL = () => 'blob:mock-url';
  }
  if (typeof domUrl.revokeObjectURL !== 'function') {
    domUrl.revokeObjectURL = () => {};
  }
  if (typeof w.requestAnimationFrame !== 'function') {
    w.requestAnimationFrame = () => 1;
  }
  if (typeof w.cancelAnimationFrame !== 'function') {
    w.cancelAnimationFrame = () => {};
  }

  useSkyStore.getState().selectEntity(null, false);
  useSkyStore.setState({
    commandPaletteOpen: false,
    odidModalOpen: false,
    diagnosticsOpen: false,
    settingsOpen: false,
    inspectorOpen: false,
    selectedEntitySnapshot: null,
  });

  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('navigator', dom.window.navigator);
  vi.stubGlobal('location', dom.window.location);
  vi.stubGlobal('history', dom.window.history);
  vi.stubGlobal('URL', dom.window.URL);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
  vi.stubGlobal('Node', dom.window.Node);
  vi.stubGlobal('Element', dom.window.Element);
  vi.stubGlobal('Event', dom.window.Event);
  vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
  vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  if (!w.matchMedia) {
    w.matchMedia = () => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!w.ResizeObserver) {
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('.tle')) {
        return new Response('', { status: 200 });
      }
      if (url.includes('fallback-airspace.geojson')) {
        return new Response(fallbackAirspaceRaw, { status: 200 });
      }
      if (url.includes('windborne-balloons.json')) {
        return new Response(
          JSON.stringify({ capturedAtMs: Date.now(), t0: [[38.85, -77.04, 18]], t1: [] }),
          { status: 200 }
        );
      }
      if (url.includes('windborne') || url.includes('treasure')) {
        return new Response('[]', { status: 200 });
      }
      return new Response(JSON.stringify({ ac: [] }), { status: 200 });
    })
  );

  // Stub heavy WebGL/2D canvas viewports so HUD & overlay keyboard tests avoid loading MapLibre WebGL workers
  vi.doMock('../../src/components/map/TacticalMap', () => ({
    TacticalMap: () => null,
  }));
  vi.doMock('../../src/components/skydome/PolarSkyDome', () => ({
    PolarSkyDome: () => null,
  }));

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('../../src/App');

  const container = dom.window.document.getElementById('root')!;
  let root: ReturnType<typeof createRoot> | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(App));
  });

  return {
    window: dom.window,
    document: dom.window.document,
    container,
    cleanup: async () => {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
      vi.unstubAllGlobals();
    },
  };
}

describe('Challenge 8 — Sprint 03 Global WindBorne, Mil/LADD/PIA, ATC UAS/LTA, Scale & Glass-Cockpit Overlay Audit', () => {
  const DCA: ObserverLocation = {
    lat: 38.8512,
    lon: -77.0402,
    altM: 12,
    label: 'DCA',
    source: 'preset',
  };

  beforeEach(() => {
    clearFlightsServiceCache();
    clearBalloonsCache();
    clearTleCache();
    liveKinematicsRegistry.entities.clear();
    liveKinematicsRegistry.rawFlights.clear();
    liveKinematicsRegistry.rawGlobalFlights.clear();
    liveKinematicsRegistry.rawBalloons.clear();
    liveKinematicsRegistry.rawAdsbBalloons.clear();
    liveKinematicsRegistry.rawDrones.clear();
    liveKinematicsRegistry.rawAdsbDrones.clear();
    liveKinematicsRegistry.satellites.clear();
    liveKinematicsRegistry.orbitOverlay = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useSkyStore.setState({
      observer: { ...DCA },
      radiusKm: 120,
      atmosphericScope: 'global',
      layout: 'split',
      skyDomePip: true,
      layers: {
        flight: true,
        military: true,
        satellite: true,
        balloon: true,
        drone: true,
      },
      selectedId: null,
      hoveredId: null,
      followSelected: false,
      inspectorOpen: false,
      selectedEntitySnapshot: null,
      odidModalOpen: false,
      commandPaletteOpen: false,
      diagnosticsOpen: false,
      settingsOpen: false,
    });
  });

  it('hardens WindBorne tuple validation, mismatched snapshot lengths, >450km jump guard, and Antimeridian ±180° heading/speed', () => {
    const t0Ms = 1_764_000_000_000;
    const t0Raw: unknown[] = [
      null, // index 0: null tuple
      [Number.NaN, -77.0, 18.0], // index 1: NaN
      [38.8, Number.POSITIVE_INFINITY, 18.0], // index 2: Infinity
      [0, 0, 18.0], // index 3: Null Island exact
      [0.00005, -0.00005, 18.0], // index 4: Null Island epsilon
      [91.0, 10.0, 18.0], // index 5: lat > 90
      [-91.0, 10.0, 18.0], // index 6: lat < -90
      [10.0, 181.0, 18.0], // index 7: lon > 180
      [10.0, -181.0, 18.0], // index 8: lon < -180
      [10.0, 10.0, -0.6], // index 9: altKm < -0.5
      [10.0, 10.0, 61.0], // index 10: altKm > 60
      [10.0, 10.0], // index 11: tuple length < 3
      ['38.8', '-77.0', '18'], // index 12: non-numeric strings
      [0.0, -179.5, 19.8], // index 13: valid Antimeridian eastbound crossing
      [0.0, 179.5, 17.0], // index 14: valid Antimeridian westbound crossing
      [42.0, -71.0, 20.0], // index 15: >450 km slot reassignment teleport vs t1
      [35.0, 139.0, 18.5], // index 16: t2 outlier (>450 km from t1) while t1 -> t0 valid
      [51.5, -0.1, 15.0], // index 17: beyond mismatched t1/t2 array bounds
    ];
    const t1Raw: unknown[] = [
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [10, 10, 10],
      [0.0, 179.5, 18.0], // index 13: 1 deg east across ±180° in 1h (~111.195 km, 90° E)
      [0.0, -179.5, 17.0], // index 14: 1 deg west across ±180° in 1h (~111.195 km, 270° W)
      [42.0, -64.0, 20.0], // index 15: ~579 km > 450 km jump
      [35.0, 138.0, 18.0], // index 16: ~91 km from t0
    ];
    const t2Raw: unknown[] = new Array(17).fill(null);
    t2Raw[13] = [0.0, 178.5, 16.5]; // valid T-2h -> T-1h step (~111.195 km)
    t2Raw[15] = [42.0, -63.5, 19.5];
    t2Raw[16] = [10.0, 10.0, 18.0]; // >450 km from t1 -> omitted from trail

    const balloons = parseWindBorneConstellation(t0Raw, t1Raw, t2Raw, DCA, {
      timestampMs: t0Ms,
    });
    expect(balloons.map((b) => b.constellationId)).toEqual([
      'WB-GSB-014',
      'WB-GSB-015',
      'WB-GSB-016',
      'WB-GSB-017',
      'WB-GSB-018',
    ]);

    for (const b of balloons) {
      expect(Number.isFinite(b.lat)).toBe(true);
      expect(Number.isFinite(b.lon)).toBe(true);
      expect(Number.isFinite(b.altM)).toBe(true);
      expect(Number.isFinite(b.speedMs)).toBe(true);
      expect(Number.isFinite(b.headingDeg)).toBe(true);
      expect(Number.isFinite(b.vertRateMs)).toBe(true);
      expect(b.subSource).toBe('windborne');
    }

    // Antimeridian eastbound: 179.5° -> -179.5° (~111.195 km in 3600s = ~30.89 m/s, ~90°)
    const eastCrossing = balloons.find((b) => b.constellationId === 'WB-GSB-014')!;
    expect(eastCrossing.headingValid).toBe(true);
    expect(eastCrossing.headingDeg).toBeCloseTo(90, 0);
    expect(eastCrossing.speedMs).toBeCloseTo((haversineDistanceKm(0, 179.5, 0, -179.5) * 1000) / 3600, 3);
    expect(eastCrossing.speedMs).toBeLessThan(35);
    expect(eastCrossing.vertRateMs).toBeCloseTo(0.5, 3);
    expect(eastCrossing.trail).toHaveLength(3);
    expect(eastCrossing.trail.map((p) => p.lon)).toEqual([178.5, 179.5, -179.5]);

    // Antimeridian westbound: -179.5° -> 179.5° (~270°)
    const westCrossing = balloons.find((b) => b.constellationId === 'WB-GSB-015')!;
    expect(westCrossing.headingValid).toBe(true);
    expect(westCrossing.headingDeg).toBeCloseTo(270, 0);
    expect(westCrossing.speedMs).toBeCloseTo(30.89, 1);

    // >450 km hourly jump guard suppresses speed, heading, vertRate, and corrupt trail
    const teleported = balloons.find((b) => b.constellationId === 'WB-GSB-016')!;
    expect(teleported.speedMs).toBe(0);
    expect(teleported.headingValid).toBe(false);
    expect(teleported.vertRateMs).toBe(0);
    expect(teleported.burstState).toBe('float');
    expect(teleported.trail).toHaveLength(1);

    // Valid t1 -> t0 with >450 km t2 -> t1 drops only t2
    const t2Jump = balloons.find((b) => b.constellationId === 'WB-GSB-017')!;
    expect(t2Jump.headingValid).toBe(true);
    expect(t2Jump.trail).toHaveLength(2);

    // Mismatched beyond t1/t2 bounds keeps t0 safely
    const beyondT1 = balloons.find((b) => b.constellationId === 'WB-GSB-018')!;
    expect(beyondT1.speedMs).toBe(0);
    expect(beyondT1.headingValid).toBe(false);
    expect(beyondT1.trail).toHaveLength(1);
    expect(resolveSpriteForEntity(eastCrossing)).toBe('sprite-balloon-windborne');
  });

  it('[DEFECT-S3-04] fetchBalloons global scope must not mask SondeHub 503 + WindBorne cached seed behind status="live" and Date.now()', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    const seedCapturedAtMs = Date.UTC(2026, 10, 23, 18, 0, 0);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.v2.sondehub.org/sondes')) {
          return new Response('Service Unavailable', { status: 503 });
        }
        if (url.includes('api.v2.sondehub.org/amateur')) {
          return new Response('{}', { status: 200 });
        }
        if (url.includes('data/windborne-balloons.json')) {
          return new Response(
            JSON.stringify({
              capturedAtMs: seedCapturedAtMs,
              t0: [[38.9, -77.1, 18.0]],
              t1: [[38.8, -77.2, 17.5]],
            }),
            { status: 200 }
          );
        }
        return new Response('WindBorne unavailable', { status: 503 });
      })
    );

    const res = await fetchBalloons(DCA, 120, undefined, {
      scope: 'global',
      includeWindBorne: true,
      includeSondeHub: true,
      force: true,
      resetBreakers: true,
    });

    expect(res.entities).toHaveLength(1);
    expect(res.entities[0].isCachedSeed).toBe(true);
    expect(res.status).toBe('cached');
    expect(res.timestampMs).toBe(seedCapturedAtMs);
  });

  it('deduplicates global /v2/mil + /v2/ladd + /v2/pia by hex and isolates globalFlightsCircuitBreaker from local flightsCircuitBreaker', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v2/mil')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'AE0170',
                  flight: 'RCH101',
                  t: 'C17',
                  lat: 38.9,
                  lon: -77.1,
                  alt_baro: 32000,
                  gs: 430,
                  track: 90,
                  dbFlags: 1,
                },
                {
                  hex: 'ae0999',
                  flight: 'ORDER66',
                  t: 'F16',
                  lat: 36.1,
                  lon: -115.1,
                  alt_baro: 25000,
                  gs: 480,
                  track: 180,
                  dbFlags: 0,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v2/ladd')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae0170',
                  flight: 'RCH101',
                  t: 'C17',
                  lat: 38.9,
                  lon: -77.1,
                  alt_baro: 32000,
                  gs: 430,
                  track: 90,
                  dbFlags: 8,
                },
                {
                  hex: 'a88001',
                  flight: 'EXEC88',
                  lat: 34.0,
                  lon: -118.2,
                  alt_baro: 41000,
                  gs: 460,
                  track: 270,
                  dbFlags: 8,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v2/pia')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae0170',
                  flight: 'RCH101',
                  lat: 38.9,
                  lon: -77.1,
                  alt_baro: 32000,
                  gs: 430,
                  track: 90,
                  dbFlags: 4,
                },
                {
                  hex: 'a88001',
                  flight: 'EXEC88',
                  lat: 34.0,
                  lon: -118.2,
                  alt_baro: 41000,
                  gs: 460,
                  track: 270,
                  dbFlags: 4,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const merged = await fetchGlobalSpecialFlights(DCA, undefined, { force: true });
    expect(merged.status).toBe('live');
    expect(merged.entities.map((e) => e.icaoHex).sort()).toEqual(['a88001', 'ae0170', 'ae0999']);

    const sharedMil = merged.entities.find((e) => e.icaoHex === 'ae0170')!;
    expect(sharedMil.isMilitary).toBe(true);
    expect(sharedMil.isLadd).toBe(true);
    expect(sharedMil.isPia).toBe(true);
    expect(sharedMil.category).toBe('military');

    const laddPiaCivil = merged.entities.find((e) => e.icaoHex === 'a88001')!;
    expect(laddPiaCivil.isMilitary).toBe(false);
    expect(laddPiaCivil.isLadd).toBe(true);
    expect(laddPiaCivil.isPia).toBe(true);
    expect(laddPiaCivil.category).toBe('military');

    // Now prove strict circuit-breaker isolation between global /v2/{mil,ladd,pia} and local /v2/point
    clearFlightsServiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v2/mil') || url.includes('/v2/ladd') || url.includes('/v2/pia')) {
          return new Response('Rate limited', { status: 429 });
        }
        if (url.includes('/v2/point') || url.includes('opendata.adsb.fi/api/v3/')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'a12345',
                  flight: 'DAL202',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 9500,
                  gs: 250,
                  track: 90,
                  seen_pos: 2,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Service Unavailable', { status: 503 });
      })
    );

    for (let i = 0; i < 3; i += 1) {
      const failGlobal = await fetchGlobalSpecialFlights(DCA, undefined, { force: true });
      expect(failGlobal.status).toBe('rate-limited');
      expect(failGlobal.httpStatus).toBe(429);
    }

    expect(globalFlightsCircuitBreaker.getState('global-mil-relay-adsb-lol')).toBe('open');
    expect(globalFlightsCircuitBreaker.getState('global-ladd-relay-adsb-lol')).toBe('open');
    expect(globalFlightsCircuitBreaker.getState('global-pia-relay-adsb-lol')).toBe('open');
    expect(flightsCircuitBreaker.getState('cors-relay-adsb-fi')).toBe('closed');
    expect(flightsCircuitBreaker.getState('adsb.lol')).toBe('closed');

    // Local /v2/point cascade remains completely unaffected and live
    const localRes = await fetchFlightsCascade(DCA, 120, undefined, {
      force: true,
      resetBreakers: false,
    });
    expect(localRes.status).toBe('live');
    expect(localRes.entities.map((e) => e.callsign)).toEqual(['DAL202']);
  });

  it('[DEFECT-S3-03] global /v2/mil + /v2/ladd + /v2/pia hex merge must not downgrade heavy/heli airframeClass when downstream feed omits type', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v2/mil')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae0170',
                  flight: 'RCH101',
                  t: 'C17',
                  lat: 38.9,
                  lon: -77.1,
                  alt_baro: 32000,
                  gs: 430,
                  track: 90,
                  dbFlags: 1,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v2/ladd')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae0170',
                  flight: 'RCH101',
                  lat: 38.9,
                  lon: -77.1,
                  alt_baro: 32000,
                  gs: 430,
                  track: 90,
                  dbFlags: 8,
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (url.includes('/v2/pia')) {
          return new Response(JSON.stringify({ ac: [] }), { status: 200 });
        }
        return new Response('Down', { status: 503 });
      })
    );

    const res = await fetchGlobalSpecialFlights(DCA, undefined, { force: true });
    const c17 = res.entities.find((e) => e.icaoHex === 'ae0170');
    expect(c17).toBeDefined();
    expect(c17!.airframeClass).toBe('heavy');
    expect(resolveSpriteForEntity(c17!)).toBe('sprite-heavy-military');
  });

  it('retains high-altitude alt_baro:null + alt_geom:62000, B6 military UAS, B2 LTA balloons, and gs < 5 kts hovering targets', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    const dcAirspace: AirspaceData = {
      uasfm: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { CEILING: 400, UNIT: 'FT' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-77.2, 38.7], [-76.9, 38.7], [-76.9, 39.0], [-77.2, 39.0], [-77.2, 38.7]]],
            },
          },
        ],
      },
      sua: { type: 'FeatureCollection', features: [] },
      usCoverage: true,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae5420',
                  flight: 'FORTE10',
                  t: 'RQ4',
                  category: 'B6',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: null,
                  alt_geom: 55000,
                  gs: 320,
                  track: 90,
                  dbFlags: 0,
                  seen_pos: 2,
                },
                {
                  hex: 'ae5421',
                  flight: 'REAP09',
                  t: 'MQ9',
                  category: 'B6',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 22000,
                  gs: 165,
                  track: 45,
                  dbFlags: 0,
                  seen_pos: 2,
                },
                {
                  hex: 'a123b2',
                  flight: 'HBAL701',
                  t: 'BALL',
                  category: 'B2',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: null,
                  alt_geom: 62000,
                  gs: 3.5,
                  track: 110,
                  seen_pos: 2,
                },
                {
                  hex: 'a12300',
                  flight: 'HOVER1',
                  t: 'B407',
                  category: 'A7',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 1200,
                  gs: 2.0,
                  track: null,
                  seen_pos: 2,
                },
                {
                  hex: 'ae9999',
                  flight: 'DRGN99',
                  t: 'U2',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: null,
                  alt_geom: 62000,
                  gs: 410,
                  track: 270,
                  dbFlags: 1,
                  seen_pos: 2,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );

    const res = await fetchFlightsCascade(DCA, 120, undefined, {
      force: true,
      airspace: dcAirspace,
    });
    expect(res.status).toBe('live');

    // HOVER1 (gs < 5 kts) & U2 (alt_baro: null, alt_geom: 62000) retained in entities
    expect(res.entities.map((e) => e.callsign).sort()).toEqual(['DRGN99', 'HOVER1']);
    const hover = res.entities.find((e) => e.callsign === 'HOVER1')!;
    expect(hover.speedMs).toBeCloseTo(2.0 * 0.514444, 3);
    expect(hover.airframeClass).toBe('heli');
    const u2 = res.entities.find((e) => e.callsign === 'DRGN99')!;
    expect(u2.altM).toBeCloseTo(62000 * 0.3048, 1);
    expect(u2.isMilitary).toBe(true);

    // B6 MQ-9 / RQ-4 routed to uasEntities with isMilitary: true and NO false FL550 UASFM breach
    expect(res.uasEntities?.map((u) => u.callsign).sort()).toEqual(['FORTE10', 'REAP09']);
    for (const uas of res.uasEntities ?? []) {
      expect(uas.subSource).toBe('adsb-uas');
      expect(uas.isMilitary).toBe(true);
      expect(uas.hasOperatorLocation).toBe(false);
      expect(uas.uaType).toBe('fixed-wing');
      expect(uas.ceilingBreach).toBe(false);
      expect(resolveSpriteForEntity(uas)).toBe('sprite-drone-hale');
    }

    // B2 LTA routed to balloonEntities with alt_geom: 62000 & gs: 3.5 retained
    expect(res.balloonEntities).toHaveLength(1);
    const lta = res.balloonEntities![0];
    expect(lta.callsign).toBe('HBAL701');
    expect(lta.subSource).toBe('adsb-lta');
    expect(lta.altM).toBeCloseTo(62000 * 0.3048, 1);
    expect(lta.speedMs).toBeCloseTo(3.5 * 0.514444, 3);
  });

  it('[DEFECT-S3-07] globalViteProxyUnavailable must not latch on secondary proxy 404, and B6 UAS compliance checks AGL rather than MSL', async () => {
    // Part A: Secondary proxy /api-proxy/airplanes-live/v2/ladd returning 404 during primary 503 must not permanently kill primary /api-proxy/adsb-lol
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const seenProxyUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        seenProxyUrls.push(url);
        if (url === '/api-proxy/adsb-lol/v2/mil') {
          return new Response(
            JSON.stringify({
              ac: [{ hex: 'ae0101', flight: 'RCH1', lat: 38.9, lon: -77.1, alt_baro: 25000, gs: 400, track: 90, dbFlags: 1 }],
            }),
            { status: 200 }
          );
        }
        if (url === '/api-proxy/adsb-lol/v2/ladd') {
          return new Response('Transient upstream error', { status: 503 });
        }
        if (url === '/api-proxy/airplanes-live/v2/ladd') {
          return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
        }
        if (url.includes('/v2/pia')) {
          return new Response(JSON.stringify({ ac: [] }), { status: 200 });
        }
        return new Response('Fallback', { status: 503 });
      })
    );

    await fetchGlobalSpecialFlights(DCA, undefined, { force: true });
    seenProxyUrls.length = 0;
    await fetchGlobalSpecialFlights(DCA, undefined, { force: true, resetBreakers: false });
    expect(seenProxyUrls).toContain('/api-proxy/adsb-lol/v2/mil');

    // Part B: High-elevation US airport (Denver 1,655m MSL) low-AGL B6 UAS breach check
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    const denver: ObserverLocation = {
      lat: 39.8561,
      lon: -104.6737,
      altM: 1655,
      label: 'KDEN',
      source: 'manual',
    };
    const denverAirspace: AirspaceData = {
      uasfm: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { CEILING: 400, UNIT: 'FT' },
            geometry: {
              type: 'Polygon',
              coordinates: [[[-104.8, 39.7], [-104.5, 39.7], [-104.5, 40.0], [-104.8, 40.0], [-104.8, 39.7]]],
            },
          },
        ],
      },
      sua: { type: 'FeatureCollection', features: [] },
      usCoverage: true,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'a77001',
                  flight: 'SCAN01',
                  t: 'SCAN',
                  category: 'B6',
                  lat: 39.86,
                  lon: -104.68,
                  alt_baro: null,
                  alt_geom: 5905, // ~1800m MSL = 145m (476 ft) AGL over 1655m Denver -> exceeds 400 ft ceiling!
                  gs: 65,
                  track: 90,
                  seen_pos: 1,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const kdenRes = await fetchFlightsCascade(denver, 120, undefined, {
      force: true,
      airspace: denverAirspace,
    });
    expect(kdenRes.uasEntities).toHaveLength(1);
    expect(kdenRes.uasEntities![0].ceilingBreach).toBe(true);
  });

  it('maintains latency and memory hygiene under 1,000 WindBorne balloons + 500 global military flights + 2,000 satellites', async () => {
    const fs = await loadNodeFs();
    const seedJson = JSON.parse(
      fs.readFileSync(repoFileUrl('public/data/windborne-balloons.json'), 'utf8')
    ) as { count: number; t0: unknown[]; t1: unknown[] };
    expect(seedJson.count).toBe(1000);
    expect(seedJson.t0).toHaveLength(1000);
    expect(seedJson.t1).toHaveLength(1000);

    // 1. 1,000 WindBorne constellation balloons
    const t2Synthetic = seedJson.t1.map((row) =>
      Array.isArray(row) && typeof row[0] === 'number' && typeof row[1] === 'number' && typeof row[2] === 'number'
        ? [row[0] - 0.1, normalizeLonDeg(row[1] - 0.1), row[2]]
        : null
    );
    const wbStart = performance.now();
    const wbEntities = parseWindBorneConstellation(seedJson.t0, seedJson.t1, t2Synthetic, DCA, {
      timestampMs: Date.now(),
    });
    const wbElapsedMs = performance.now() - wbStart;
    expect(wbEntities).toHaveLength(1000);
    expect(wbElapsedMs).toBeLessThan(150);
    for (const b of wbEntities) {
      expect(b.trail.length).toBeLessThanOrEqual(24);
    }

    // 2. 500 global military flights
    const milAc = Array.from({ length: 500 }, (_, i) => ({
      hex: `ae${i.toString(16).padStart(4, '0')}`,
      flight: `RCH${i}`,
      t: i % 3 === 0 ? 'C17' : 'F16',
      lat: -60 + ((i * 17) % 120),
      lon: -175 + ((i * 29) % 350),
      alt_baro: 31000,
      gs: 430,
      track: (i * 37) % 360,
      dbFlags: 1,
      seen_pos: 2,
    }));
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/v2/mil')) return new Response(JSON.stringify({ ac: milAc }), { status: 200 });
        if (url.includes('/v2/ladd') || url.includes('/v2/pia')) {
          return new Response(JSON.stringify({ ac: [] }), { status: 200 });
        }
        return new Response('Down', { status: 503 });
      })
    );
    const milStart = performance.now();
    const milRes = await fetchGlobalSpecialFlights(DCA, undefined, { force: true });
    const milElapsedMs = performance.now() - milStart;
    expect(milRes.entities).toHaveLength(500);
    expect(milElapsedMs).toBeLessThan(200);

    // 3. 2,000 satellites SGP4 batch
    const records: TleRecord[] = [];
    for (let i = 0; i < 2000; i += 1) {
      records.push(makeSynthesizedTle(i));
    }
    const pool = selectSatellitePool(parseTleRecords(records), true);
    const satStart = performance.now();
    const { kinematics, meta } = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: DCA,
      radiusKm: 250,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });
    const unpacked = unpackSatelliteKinematics(kinematics, meta, ISS_EPOCH_MS);
    const satElapsedMs = performance.now() - satStart;
    expect(satElapsedMs).toBeLessThan(100);
    expect(unpacked.length).toBeGreaterThan(0);

    // Log scale benchmark for audit report
    console.info(
      `[Challenge 8] scale bench: wb1000=${wbElapsedMs.toFixed(2)}ms, mil500=${milElapsedMs.toFixed(2)}ms, sat2000=${satElapsedMs.toFixed(2)}ms`
    );
  });

  it('[DEFECT-S3-06] App.tsx must gate 60fps pushAtmospheric on active layers and prune global WindBorne balloons synchronously on GLOBAL -> LOCAL', () => {
    const scopeEffect = appSourceRaw.slice(
      appSourceRaw.indexOf('// React to Atmospheric Scope'),
      appSourceRaw.indexOf('// Manual Sweep trigger')
    );
    expect(scopeEffect).toContain('rawGlobalFlights.clear()');
    expect(scopeEffect).toContain('globalAdsbBalloonsRef.current.clear()');
    expect(scopeEffect).toContain('globalAdsbDronesRef.current.clear()');
    // Global WindBorne entries in rawBalloons must also be pruned synchronously on GLOBAL -> LOCAL
    expect(
      scopeEffect.includes('rawBalloons') &&
        (scopeEffect.includes("subSource === 'windborne'") || scopeEffect.includes('groundDistKm')),
      'App.tsx GLOBAL -> LOCAL transition must synchronously prune out-of-range / WindBorne entries from liveKinematicsRegistry.rawBalloons instead of relying on rAF or async network completion'
    ).toBe(true);

    // 60fps stepKinematics must not extrapolate 1,000 balloons or 500 military flights when their layer is disabled
    const stepCallsSlice = appSourceRaw.slice(
      appSourceRaw.indexOf('pushAtmospheric(liveKinematicsRegistry.rawFlights'),
      appSourceRaw.indexOf('// Orbital satellites: smooth micro-interpolation')
    );
    expect(
      stepCallsSlice.includes('st.layers.balloon') && stepCallsSlice.includes('st.layers.military'),
      'App.tsx stepKinematics executes 60fps WGS-84 extrapolation on rawBalloons and rawGlobalFlights even when layers.balloon or layers.military is false'
    ).toBe(true);
  });

  it('verifies sw.js krunked-skymap-v5 bypass of /api-proxy/windborne and same-origin .json data while caching manifest.json', async () => {
    const fs = await loadNodeFs();
    const vm = await loadNodeVm();
    const swSource = fs.readFileSync(repoFileUrl('public/sw.js'), 'utf8');
    const viteConfig = fs.readFileSync(repoFileUrl('vite.config.ts'), 'utf8').replace(/\r\n/g, '\n');

    expect(swSource).toContain("const CACHE_VERSION = 'krunked-skymap-v5'");
    expect(viteConfig).toContain("'/api-proxy/windborne': createAdsbProxyEntry('/api-proxy/windborne', 'https://a.windbornesystems.com')");

    const listeners = new Map<string, (ev: unknown) => void>();
    const mockFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    const openedCaches = new Map<string, Map<string, Response>>();

    const sandboxSelf = {
      location: {
        origin: 'https://example.github.io',
        href: 'https://example.github.io/krunked_skymap/sw.js',
      },
      addEventListener(type: string, cb: (ev: unknown) => void) {
        listeners.set(type, cb);
      },
      skipWaiting: vi.fn(async () => {}),
      clients: { claim: vi.fn(async () => {}) },
    };

    const sandboxCaches = {
      async open(name: string) {
        let store = openedCaches.get(name);
        if (!store) {
          store = new Map<string, Response>();
          openedCaches.set(name, store);
        }
        return {
          async add() {},
          async put(req: Request | string, res: Response) {
            store!.set(typeof req === 'string' ? req : req.url, res);
          },
        };
      },
      async keys() {
        return ['krunked-skymap-v5'];
      },
      async delete() {
        return true;
      },
      async match() {
        return undefined;
      },
    };

    vm.runInNewContext(swSource, {
      self: sandboxSelf,
      caches: sandboxCaches,
      fetch: mockFetch,
      URL,
      Request,
      Response,
      Promise,
    });

    const fetchListener = listeners.get('fetch')!;
    const s3BypassUrls = [
      'https://example.github.io/krunked_skymap/api-proxy/windborne/treasure/00.json',
      'https://example.github.io/krunked_skymap/data/windborne-balloons.json',
      'https://example.github.io/krunked_skymap/api/live-odid.json',
      'https://r.jina.ai/https://a.windbornesystems.com/treasure/00.json?_=123',
      'https://api.adsb.lol/v2/mil',
      'https://api.adsb.lol/v2/ladd',
      'https://api.adsb.lol/v2/pia',
    ];
    for (const url of s3BypassUrls) {
      const respondWith = vi.fn();
      fetchListener({
        request: { method: 'GET', cache: 'default', mode: 'same-origin', url },
        respondWith,
      });
      expect(respondWith, `sw.js must bypass ${url}`).not.toHaveBeenCalled();
    }

    // manifest.json MUST still be handled by networkFirst
    const manifestRespondWith = vi.fn();
    fetchListener({
      request: {
        method: 'GET',
        cache: 'default',
        mode: 'same-origin',
        url: 'https://example.github.io/krunked_skymap/manifest.json',
      },
      respondWith: manifestRespondWith,
    });
    expect(manifestRespondWith).toHaveBeenCalledTimes(1);
    await manifestRespondWith.mock.calls[0][0];
  });

  it('[DEFECT-S3-01] Ctrl+K / ⌘K toggles Command Palette without duplicate-listener self-cancellation and / respects OpenDroneIdModal', async () => {
    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);

      await act(async () => {
        appMount.window.dispatchEvent(
          new appMount.window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
        );
      });
      expect(
        useSkyStore.getState().commandPaletteOpen,
        'Ctrl+K cancelled itself out because both ControlDock and App registered toggle listeners on window'
      ).toBe(true);

      // Pressing '/' while OpenDroneIdModal is open must NOT open CommandPalette
      await act(async () => {
        useSkyStore.getState().setCommandPaletteOpen(false);
        useSkyStore.getState().setOdidModalOpen(true);
      });
      await act(async () => {
        appMount.window.dispatchEvent(
          new appMount.window.KeyboardEvent('keydown', { key: '/', bubbles: true })
        );
      });
      expect(
        useSkyStore.getState().commandPaletteOpen,
        "'/' bypassed odidModalOpen guard inside ControlDock.tsx"
      ).toBe(false);
    } finally {
      await appMount.cleanup();
    }
  }, 15_000);

  it('[DEFECT-S3-02] Escape key must dismiss strictly one top overlay layer at a time without cascading into TargetInspector', async () => {
    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      const mockEntity: FlightEntity = {
        id: 'flight:ae0170',
        category: 'military',
        callsign: 'RCH101',
        subtitle: 'C17 · SQK 1234',
        country: 'United States',
        lat: 38.9,
        lon: -77.1,
        altM: 9000,
        speedMs: 220,
        headingDeg: 90,
        headingValid: true,
        vertRateMs: 0,
        timestampMs: Date.now(),
        topocentric: {
          azimuthDeg: 45,
          elevationDeg: 15,
          slantRangeKm: 35,
          groundDistKm: 33,
          belowHorizon: false,
        },
        trail: [],
        icaoHex: 'ae0170',
        onGround: false,
        isMilitary: true,
        airframeClass: 'heavy',
      };

      // Case 1: TargetInspector + TopBar Diagnostics Popover open -> first Escape closes Diagnostics ONLY
      await act(async () => {
        liveKinematicsRegistry.entities.set(mockEntity.id, mockEntity);
        useSkyStore.getState().selectEntity(mockEntity.id, true);
        useSkyStore.getState().setSelectedEntitySnapshot(mockEntity);
        useSkyStore.getState().setDiagnosticsOpen(true);
      });
      await act(async () => {
        appMount.window.dispatchEvent(
          new appMount.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(useSkyStore.getState().diagnosticsOpen).toBe(false);
      expect(
        useSkyStore.getState().inspectorOpen,
        'Escape on Diagnostics Popover cascaded through App.tsx + TargetInspector.tsx and closed TargetInspector too'
      ).toBe(true);

      // Case 2: TargetInspector + ControlDock sub-filter tray open -> first Escape closes sub-tray ONLY
      const orbitalChevron = appMount.container.querySelector(
        'button[aria-label="Open ORBITAL sub-filters"]'
      ) as HTMLButtonElement | null;
      expect(orbitalChevron).not.toBeNull();
      await act(async () => {
        orbitalChevron!.click();
      });
      expect(appMount.container.querySelector('.dock-subtray')).not.toBeNull();
      await act(async () => {
        appMount.window.dispatchEvent(
          new appMount.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(appMount.container.querySelector('.dock-subtray')).toBeNull();
      expect(
        useSkyStore.getState().inspectorOpen,
        'Escape on ControlDock sub-filter tray also closed TargetInspector'
      ).toBe(true);

      // Case 3: TargetInspector + CommandPalette (focus on body, not input) -> first Escape closes CommandPalette ONLY
      await act(async () => {
        useSkyStore.getState().setCommandPaletteOpen(true);
        (appMount.document.activeElement as HTMLElement | null)?.blur?.();
      });
      await act(async () => {
        appMount.window.dispatchEvent(
          new appMount.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);
      expect(
        useSkyStore.getState().inspectorOpen,
        'Escape on CommandPalette (non-input focus) also closed TargetInspector'
      ).toBe(true);
    } finally {
      await appMount.cleanup();
    }
  });

  it('[DEFECT-S3-05] TopTelemetryBar system beacon must surface flights error instead of green FEEDS LIVE when balloons are live', async () => {
    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      await act(async () => {
        useSkyStore.getState().setFeedState('flights', { status: 'error', errorMsg: 'HTTP 503' });
        useSkyStore.getState().setFeedState('military', { status: 'idle' });
        useSkyStore.getState().setFeedState('balloons', { status: 'live' });
      });

      const beacon = appMount.container.querySelector(
        '[data-testid="hud-feed-diagnostics"]'
      ) as HTMLElement | null;
      expect(beacon).not.toBeNull();
      expect(beacon!.className).not.toContain('topbar-beacon-pill--live');
      expect(beacon!.textContent).not.toContain('FEEDS LIVE');
    } finally {
      await appMount.cleanup();
    }
  });

  it('[DEFECT-S3-08] cockpit.css & PolarSkyDome must wrap dock-pill at tablet widths with open inspector and lift PolarSkyDome legend on mobile', async () => {
    const fs = await loadNodeFs();
    const cockpitCssRaw = fs.readFileSync(repoFileUrl('src/styles/cockpit.css'), 'utf8');
    const tabletInspectorSection = cockpitCssRaw.slice(
      cockpitCssRaw.indexOf('@media (min-width: 768px) and (max-width: 1440px)'),
      cockpitCssRaw.indexOf('@media (max-width: 767px)')
    );
    expect(
      /\.dock-pill[\s\S]{0,240}flex-wrap:\s*wrap/.test(tabletInspectorSection),
      'cockpit.css lacks .dock-pill flex-wrap at 768px-1120px when TargetInspector constrains .control-dock-wrap to right: 364px'
    ).toBe(true);

    expect(
      polarDomeSourceRaw.includes('skydome-legend') && cockpitCssRaw.includes('.skydome-legend'),
      'PolarSkyDome bottom-right legend lacks a .skydome-legend CSS hook lifted clear of the mobile ControlDock on <=767px'
    ).toBe(true);
  });
});


// ---------------------------------------------------------------------------
// Challenge 9 — Sprint 04 3D Sky-Dome, Celestial/TCA, Zero-GC & Hotkey Audit
// ---------------------------------------------------------------------------
import {
  projectToSkyDome as c9Project,
  unprojectFromSkyDome as c9Unproject,
  projectEnuToSkyDome as c9ProjectEnu,
  computeTargetEnuState as c9EnuState,
  computeSkyDomeTrajectoryTangent as c9Tangent,
  computeSolarLunarTopocentric as c9Celestial,
  computeClosestApproach as c9Tca,
} from '../../src/math/geodesy';
import {
  solveDomeLabelLayout as c9SolveLabels,
  type DomeLabelCandidate as C9Candidate,
} from '../../src/components/skydome/PolarSkyDome';
import { pruneLiveKinematicsRegistry as c9Prune } from '../../src/store/useSkyStore';

describe('Challenge 9 — Sprint 04 3D Sky-Dome, Celestial/TCA, Zero-GC & Hotkey Audit', () => {
  it('9.1 below-horizon targets are culled in both zoom modes; zenith culls el<30; no -5deg/OTH tolerance in source', () => {
    for (let i = 0; i < 1000; i += 1) {
      const el = -85 + (84.99 * i) / 999;
      const az = (i * 37) % 360;
      expect(c9Project(az, el, 200, 200, 180, 'hemisphere').visible, `hemi el=${el}`).toBe(false);
      expect(c9Project(az, el, 200, 200, 180, 'zenith').visible, `zenith el=${el}`).toBe(false);
    }
    for (let el = 0; el < 30; el += 0.5) {
      expect(c9Project(10, el, 200, 200, 180, 'zenith').visible, `zenith el=${el}`).toBe(false);
    }
    expect(/-5\s*°/.test(polarDomeSourceRaw)).toBe(false);
    expect(/\bOTH\b/.test(polarDomeSourceRaw)).toBe(false);
    expect(/EL_MIN\s*=\s*-5/.test(polarDomeSourceRaw)).toBe(false);
  });

  it('9.2 zenith overflight and antimeridian crossing: tangent finite, smooth (<2deg/step), ENU projection finite', () => {
    const observer = { lat: 0, lon: 179.99, altM: 0 };
    const run = (label: string, mk: (i: number) => { lat: number; lon: number }, headingDeg: number) => {
      let prev: number | null = null;
      let maxStep = 0;
      for (let i = 0; i < 61; i += 1) {
        const p = mk(i);
        const target = { ...p, altM: 3000, speedMs: 200, headingDeg, headingValid: true, vertRateMs: 0 };
        const ang = c9Tangent(observer, target, 200, 200, 180, 'hemisphere');
        expect(Number.isFinite(ang), `${label} i=${i}`).toBe(true);
        const st = c9EnuState(observer, target);
        const pr = c9ProjectEnu(st.e, st.n, st.u, 200, 200, 180, 'hemisphere', true);
        expect(Number.isFinite(pr.x) && Number.isFinite(pr.y), `${label} enu i=${i}`).toBe(true);
        if (prev !== null) {
          let d = Math.abs(ang - prev) % (2 * Math.PI);
          if (d > Math.PI) d = 2 * Math.PI - d;
          maxStep = Math.max(maxStep, (d * 180) / Math.PI);
        }
        prev = ang;
      }
      expect(maxStep, `${label} max tangent step deg`).toBeLessThan(2);
    };
    // Due-east track crossing the antimeridian directly overhead (observer at lon 179.99).
    run('antimeridian', (i) => ({ lat: 0, lon: normalizeLonDeg(179.99 - 0.03 + i * 0.001) }), 90);
    // Northbound track through zenith (az flips 180).
    run('zenith', (i) => ({ lat: -0.03 + i * 0.001, lon: 179.99 }), 0);
  });

  it('9.3 project/unproject round-trip < 0.01deg across canvases, DPR and zoom modes', () => {
    const canvases: Array<[number, number]> = [[156, 156], [240, 240], [390, 844], [1440, 900], [3840, 2160]];
    for (const [w, h] of canvases) {
      for (const dpr of [1, 2, 3]) {
        const cw = w * dpr;
        const ch = h * dpr;
        const radius = Math.min(cw, ch) / 2 - 12 * dpr;
        const cx = cw / 2;
        const cy = ch / 2;
        for (const zoom of ['hemisphere', 'zenith'] as const) {
          const minEl = zoom === 'zenith' ? 30 : 0;
          for (let az = 0; az < 360; az += 23) {
            for (let el = minEl + 0.5; el <= 89.5; el += 7.3) {
              const p = c9Project(az, el, cx, cy, radius, zoom);
              expect(p.visible).toBe(true);
              const u = c9Unproject(p.x, p.y, cx, cy, radius, zoom);
              let dAz = Math.abs(u.azimuthDeg - az);
              if (dAz > 180) dAz = 360 - dAz;
              expect(dAz * Math.cos((el * Math.PI) / 180), `az ${w}x${h}@${dpr} ${zoom} ${az}/${el}`).toBeLessThan(0.01);
              expect(Math.abs(u.elevationDeg - el), `el ${w}x${h}@${dpr} ${zoom} ${az}/${el}`).toBeLessThan(0.01);
            }
          }
        }
      }
    }
  });

  it('9.4 celestial ephemeris edge cases are finite and in range; TCA handles zero/receding/approaching', () => {
    const lats = [89.9, -89.9, 0];
    const lons = [0, 179.999, -179.999, 180];
    const stamps = [0, NaN, Date.UTC(2100, 5, 21, 12)];
    for (const lat of lats) {
      for (const lon of lons) {
        for (const ts of stamps) {
          const c = c9Celestial({ lat, lon, altM: 0 }, ts);
          const tag = `${lat},${lon},${ts}`;
          for (const v of [c.sun.azimuthDeg, c.sun.elevationDeg, c.moon.azimuthDeg, c.moon.elevationDeg, c.moon.phaseFraction, c.moon.illuminationFraction]) {
            expect(Number.isFinite(v), tag).toBe(true);
          }
          expect(c.sun.azimuthDeg >= 0 && c.sun.azimuthDeg < 360, tag).toBe(true);
          expect(c.moon.azimuthDeg >= 0 && c.moon.azimuthDeg < 360, tag).toBe(true);
          expect(Math.abs(c.sun.elevationDeg)).toBeLessThanOrEqual(90);
          expect(Math.abs(c.moon.elevationDeg)).toBeLessThanOrEqual(90);
          expect(c.moon.phaseFraction >= 0 && c.moon.phaseFraction <= 1, tag).toBe(true);
          expect(c.moon.illuminationFraction >= 0 && c.moon.illuminationFraction <= 1, tag).toBe(true);
          expect(['day', 'civil', 'nautical', 'astronomical', 'night'].length).toBeGreaterThan(0);
          expect(typeof c.twilightState).toBe('string');
        }
      }
    }
    const obs = { lat: 40, lon: -75, altM: 0 };
    const stationary = c9Tca(obs, { lat: 40.05, lon: -75, altM: 3000, speedMs: 0, headingDeg: 0, headingValid: true });
    for (const v of [stationary.tcaSeconds, stationary.peakElevationDeg, stationary.minSlantRangeKm, stationary.peakAzimuthDeg]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(stationary.isApproaching).toBe(false);
    const receding = c9Tca(obs, { lat: 40.05, lon: -75, altM: 3000, speedMs: 200, headingDeg: 0, headingValid: true });
    expect(receding.isApproaching).toBe(false);
    expect(Number.isFinite(receding.minSlantRangeKm)).toBe(true);
    const approaching = c9Tca(obs, { lat: 40.4, lon: -75, altM: 3000, speedMs: 200, headingDeg: 180, headingValid: true });
    expect(approaching.isApproaching).toBe(true);
    expect(approaching.tcaSeconds).toBeGreaterThan(0);
    expect(approaching.tcaSeconds).toBeLessThanOrEqual(600);
    expect(approaching.peakElevationDeg).toBeGreaterThan(60);
  });

  it('9.5 label layout: 80 aircraft in a 15deg zenith cone obey caps, no overlap, margins; registry prune is synchronous', () => {
    const W = 800;
    const H = 800;
    const cx = 400;
    const cy = 400;
    const radius = 380;
    const cands: C9Candidate[] = [];
    for (let i = 0; i < 80; i += 1) {
      const el = 75 + ((i * 7) % 15) + 0.01;
      const p = c9Project((i * 47) % 360, Math.min(90, el), cx, cy, radius, 'zenith');
      cands.push({
        id: `ac${i}`, x: p.x, y: p.y, w: 64, h: 16, elDeg: Math.min(90, el), slantRangeKm: 5 + i,
        isSelected: false, isHovered: false, isEmergency: false, isBreach: false, text: `AC${i}`, color: '#fff',
      });
    }
    const inside = (l: { x: number; y: number; w: number; h: number }) =>
      l.x >= 8 && l.y >= 8 && l.x + l.w <= W - 8 && l.y + l.h <= H - 8;
    for (const [mode, cap] of [['dome', 12], ['split', 7], ['pip', 0]] as const) {
      const r = c9SolveLabels({ candidates: cands, width: W, height: H, cx, cy, radius, mode, zoomMode: 'zenith', labelsEnabled: true });
      const L = r.labels.slice(0, r.count);
      expect(r.count, mode).toBeLessThanOrEqual(cap);
      for (let i = 0; i < L.length; i += 1) {
        expect(inside(L[i]), `${mode} margin ${L[i].id}`).toBe(true);
        for (let j = i + 1; j < L.length; j += 1) {
          const a = L[i];
          const b = L[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${mode} overlap ${a.id}/${b.id}`).toBe(false);
        }
      }
    }
    const low = cands.map((c) => ({ ...c, elDeg: 7.9 }));
    expect(c9SolveLabels({ candidates: low, width: W, height: H, cx, cy, radius, mode: 'dome', zoomMode: 'hemisphere', labelsEnabled: true }).count).toBe(0);

    // Registry prune
    const st = useSkyStore.getState();
    const ctx = {
      layers: { ...st.layers, flight: false, military: true },
      satGroups: st.satGroups,
      balloonSublayers: st.balloonSublayers,
      droneSublayers: st.droneSublayers,
      atmosphericScope: 'local' as const,
      observer: { lat: 40, lon: -75, altM: 0 },
      radiusKm: 100,
    };
    liveKinematicsRegistry.entities.clear();
    const mk = (id: string, category: string, lat: number, lon: number, extra: Record<string, unknown> = {}) =>
      liveKinematicsRegistry.entities.set(id, { id, category, lat, lon, altM: 1000, ...extra } as unknown as SkyEntity);
    mk('f1', 'flight', 40, -75);
    mk('m1', 'military', 40, -75);
    mk('mFar', 'military', 10, 10);
    mk('bw', 'balloon', 40, -75, { subSource: 'windborne' });
    const pruned = c9Prune(ctx as unknown as Parameters<typeof c9Prune>[0]);
    expect(pruned).toBe(3);
    expect([...liveKinematicsRegistry.entities.keys()]).toEqual(['m1']);
    liveKinematicsRegistry.entities.clear();
  });

  it('9.6 hotkeys M/S/D/P/L/Esc work on body, are ignored in <input>, and ignored with odid modal / palette open', async () => {
    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      const press = async (target: EventTarget, key: string) => {
        await act(async () => {
          target.dispatchEvent(new appMount.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
      };
      const body = appMount.document.body;
      const s = () => useSkyStore.getState();
      await act(async () => { s().setLayout('map'); });
      await press(body, 'd');
      expect(s().layout).toBe('dome');
      await press(body, 's');
      expect(s().layout).toBe('split');
      await press(body, 'm');
      expect(s().layout).toBe('map');
      await press(body, 'p');
      const pipAfterP = s().skyDomePip;
      await press(body, 'p');
      expect(s().skyDomePip).toBe(!pipAfterP);
      const labels0 = s().domeLabelsEnabled;
      await press(body, 'l');
      expect(s().domeLabelsEnabled).toBe(!labels0);

      const input = appMount.document.createElement('input');
      body.appendChild(input);
      await press(input, 'd');
      expect(s().layout, 'D inside <input>').toBe('map');
      const lbl = s().domeLabelsEnabled;
      await press(input, 'l');
      expect(s().domeLabelsEnabled, 'L inside <input>').toBe(lbl);

      await act(async () => { s().setOdidModalOpen(true); });
      await press(body, 'd');
      expect(s().layout, 'D under odid modal').toBe('map');
      await press(body, 'Escape');
      expect(s().odidModalOpen).toBe(false);

      await act(async () => { s().setCommandPaletteOpen(true); });
      await press(body, 's');
      expect(s().layout, 'S under palette').toBe('map');
      await press(body, 'Escape');
      expect(s().commandPaletteOpen).toBe(false);
    } finally {
      await appMount.cleanup();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Challenge 10 — Sprint 05 Translucent Dome, Compass/Touch-Lock, Portal Modal,
//                Right +33% PIP & Overhead Lock Audit
// ---------------------------------------------------------------------------
import {
  shortestAngleDeltaDeg as c10ShortestDelta,
  smoothCompassHeadingDeg as c10SmoothCompass,
  computeScreenCompensatedHeadingDeg as c10ScreenHeading,
  deriveCompassHeadingDeg as c10DeriveCompass,
  normalizeAzimuthDeg as c10NormAz,
} from '../../src/math/geodesy';
import {
  PolarSkyDome as C10PolarSkyDome,
  extractCompassHeadingDeg as c10ExtractCompass,
} from '../../src/components/skydome/PolarSkyDome';
import { computeLayoutCameraPadding as c10ComputePadding } from '../../src/components/map/TacticalMap';

function makeMockCanvas2dContext(): Record<string, unknown> {
  const mkGrad = () => ({ addColorStop: () => {} });
  return {
    save: () => {},
    restore: () => {},
    setTransform: () => {},
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    arcTo: () => {},
    ellipse: () => {},
    bezierCurveTo: () => {},
    roundRect: () => {},
    fill: () => {},
    stroke: () => {},
    clip: () => {},
    translate: () => {},
    rotate: () => {},
    scale: () => {},
    setLineDash: () => {},
    fillText: () => {},
    measureText: (txt: string) => ({ width: txt.length * 6 }),
    createRadialGradient: mkGrad,
    createLinearGradient: mkGrad,
    createConicGradient: mkGrad,
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
}

function makeOverheadTestFlight(id: string, callsign: string, elevationDeg: number): FlightEntity {
  return {
    id,
    category: 'flight',
    callsign,
    subtitle: 'B738 · TEST',
    country: 'United States',
    lat: 38.86,
    lon: -77.04,
    altM: 9500,
    speedMs: 220,
    headingDeg: 90,
    headingValid: true,
    vertRateMs: 0,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 45,
      elevationDeg,
      slantRangeKm: Math.max(10, 90 - elevationDeg),
      groundDistKm: Math.max(5, 85 - elevationDeg),
      belowHorizon: elevationDeg < 0,
    },
    trail: [],
    icaoHex: id.replace(/[^a-f0-9]/gi, '').slice(0, 6).padEnd(6, '0'),
    onGround: false,
    isMilitary: false,
    airframeClass: 'jet',
  };
}

describe('Challenge 10 — Sprint 05 Translucent Dome, Compass/Touch-Lock, Portal Modal, Right +33% PIP & Overhead Lock Audit', () => {
  const DCA: ObserverLocation = {
    lat: 38.8512,
    lon: -77.0402,
    altM: 12,
    label: 'DC / Potomac Corridor',
    source: 'preset',
  };

  beforeEach(() => {
    liveKinematicsRegistry.entities.clear();
    liveKinematicsRegistry.orbitOverlay = null;
    useSkyStore.getState().selectEntity(null, false);
    useSkyStore.setState({
      observer: { ...DCA },
      locationStatus: 'ready',
      locationError: null,
      radiusKm: 120,
      layout: 'split',
      skyDomePip: true,
      skyDomeZoom: 'hemisphere',
      domeRotationDeg: 0,
      domeRotationLocked: false,
      domeCompassActive: false,
      domeCompassSupported: null,
      layers: {
        flight: true,
        military: true,
        satellite: true,
        balloon: true,
        drone: true,
      },
      satGroups: { stations: true, visual: true, starlink: true },
      balloonSublayers: { windborne: true, sondehub: true, adsbLta: true },
      droneSublayers: { liveUas: true, airspace: true, simOdid: false },
      commandPaletteOpen: false,
      odidModalOpen: false,
      diagnosticsOpen: false,
      settingsOpen: false,
      inspectorOpen: false,
      selectedId: null,
      hoveredId: null,
      selectedEntitySnapshot: null,
      counts: {
        flight: 0,
        military: 0,
        satellite: 0,
        balloon: 0,
        drone: 0,
        overhead: 0,
        overheadConeDeg: 45,
        total: 0,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    liveKinematicsRegistry.entities.clear();
  });

  it('10.1a compass North-crossing jitter, landscape screen compensation, iOS webkitCompassHeading priority & rotated dome round-trip < 0.05 deg', () => {
    // 1. 359.9° <-> 0.1° magnetometer jitter: shortest arc (< 0.5°/step), never spins backwards 359°
    let heading = 359.9;
    for (let i = 0; i < 40; i += 1) {
      const target = i % 2 === 0 ? 0.1 : 359.9;
      const next = c10SmoothCompass(heading, target, 0.18);
      const step = Math.abs(c10ShortestDelta(heading, next));
      expect(step, `jitter step ${i}: ${heading} -> ${next}`).toBeLessThan(0.5);
      expect(Math.abs(c10ShortestDelta(0, next)), `jitter stays near North at step ${i}`).toBeLessThan(0.2);
      heading = next;
    }

    // Converges cleanly across North seam in both directions
    let cw = 359.9;
    for (let i = 0; i < 40; i += 1) {
      const next = c10SmoothCompass(cw, 0.1, 0.18);
      expect(Math.abs(c10ShortestDelta(cw, next))).toBeLessThan(0.5);
      expect(c10ShortestDelta(cw, next)).toBeGreaterThanOrEqual(0);
      cw = next;
    }
    expect(Math.abs(c10ShortestDelta(cw, 0.1))).toBeLessThan(0.01);

    let ccw = 0.1;
    for (let i = 0; i < 40; i += 1) {
      const next = c10SmoothCompass(ccw, 359.9, 0.18);
      expect(Math.abs(c10ShortestDelta(ccw, next))).toBeLessThan(0.5);
      expect(c10ShortestDelta(ccw, next)).toBeLessThanOrEqual(0);
      ccw = next;
    }
    expect(Math.abs(c10ShortestDelta(ccw, 359.9))).toBeLessThan(0.01);

    // 2. Landscape 90° / 270° / 180° screen orientation compensation & iOS webkitCompassHeading precedence
    const orientCases: Array<{ alpha: number; screen: number; expected: number }> = [
      { alpha: 45, screen: 0, expected: 315 },
      { alpha: 45, screen: 90, expected: 45 },
      { alpha: 45, screen: 180, expected: 135 },
      { alpha: 45, screen: 270, expected: 225 },
      { alpha: 45, screen: -90, expected: 225 },
      { alpha: 0, screen: 90, expected: 90 },
      { alpha: 0, screen: 270, expected: 270 },
      { alpha: 350, screen: 180, expected: 190 },
    ];
    for (const c of orientCases) {
      expect(c10ScreenHeading(c.alpha, c.screen)).toBeCloseTo(c.expected, 6);
      expect(
        c10DeriveCompass({ alpha: c.alpha, absolute: true, screenAngle: c.screen })
      ).toBeCloseTo(c.expected, 6);
      expect(
        c10ExtractCompass({ alpha: c.alpha, absolute: true, type: 'deviceorientationabsolute' }, c.screen)
      ).toBeCloseTo(c.expected, 6);
    }

    // iOS webkitCompassHeading takes strict priority over alpha + screen orientation
    expect(
      c10DeriveCompass({ webkitCompassHeading: 212.5, alpha: 30, absolute: true, screenAngle: 90 })
    ).toBeCloseTo(212.5, 6);
    expect(
      c10ExtractCompass({ webkitCompassHeading: 212.5, alpha: 30, absolute: true }, 90)
    ).toBeCloseTo(212.5, 6);

    // Relative-only (absolute: false) readings without webkitCompassHeading must return null
    expect(c10DeriveCompass({ alpha: 120, absolute: false, screenAngle: 90 })).toBeNull();
    expect(c10ExtractCompass({ alpha: 120, absolute: false, type: 'deviceorientation' }, 90)).toBeNull();

    // 3. Rotated unprojectFromSkyDome + projectEnuToSkyDome + computeSkyDomeTrajectoryTangent (< 0.05°)
    const rotations = [0, 45, 90, 143.7, 180, 270, 359.9];
    const cx = 200;
    const cy = 200;
    const radius = 170;
    const obs = { lat: 38.8512, lon: -77.0402, altM: 12 };

    for (const zoom of ['hemisphere', 'zenith'] as const) {
      const minEl = zoom === 'zenith' ? 30 : 0;
      for (const rot of rotations) {
        // Heading `rot` sits at 12 o'clock (x ≈ cx, y < cy)
        const topPt = c9Project(rot, 45, cx, cy, radius, zoom, rot);
        expect(topPt.visible).toBe(true);
        expect(Math.abs(topPt.x - cx)).toBeLessThan(1e-6);
        expect(topPt.y).toBeLessThan(cy);

        for (let az = 0; az < 360; az += 30) {
          for (let el = minEl + 2; el <= 88; el += 18) {
            const p = c9Project(az, el, cx, cy, radius, zoom, rot);
            expect(p.visible).toBe(true);

            // ENU direct projection must match projectToSkyDome identically under rotation
            const elRad = (el * Math.PI) / 180;
            const azRad = (az * Math.PI) / 180;
            const e = Math.cos(elRad) * Math.sin(azRad) * 10_000;
            const n = Math.cos(elRad) * Math.cos(azRad) * 10_000;
            const u = Math.sin(elRad) * 10_000;
            const pEnu = c9ProjectEnu(e, n, u, cx, cy, radius, zoom, false, rot);
            expect(Math.hypot(p.x - pEnu.x, p.y - pEnu.y)).toBeLessThan(1e-6);

            // Unproject recovers exact true topocentric (az, el) < 0.05°
            const inv = c9Unproject(p.x, p.y, cx, cy, radius, zoom, rot);
            expect(inv.inBounds).toBe(true);
            expect(Math.abs(c10ShortestDelta(az, inv.azimuthDeg)), `az rot=${rot} zoom=${zoom}`).toBeLessThan(0.05);
            expect(Math.abs(inv.elevationDeg - el), `el rot=${rot} zoom=${zoom}`).toBeLessThan(0.05);
          }
        }

        // Trajectory tangent rotates coherently by -rot degrees relative to rot=0
        const tgt = {
          lat: 38.92,
          lon: -76.98,
          altM: 10_000,
          speedMs: 240,
          headingDeg: 65,
          headingValid: true,
          vertRateMs: 0,
        };
        const tan0 = c9Tangent(obs, tgt, cx, cy, radius, zoom, 0);
        const tanRot = c9Tangent(obs, tgt, cx, cy, radius, zoom, rot);
        expect(Number.isFinite(tanRot)).toBe(true);
        const expectedTanDeg = c10NormAz((tan0 * 180) / Math.PI - rot);
        const actualTanDeg = c10NormAz((tanRot * 180) / Math.PI);
        expect(
          Math.abs(c10ShortestDelta(expectedTanDeg, actualTanDeg)),
          `tangent rotation delta rot=${rot} zoom=${zoom}`
        ).toBeLessThan(0.05);
      }
    }

    // Smooth zenith overflight at arbitrary rotation (143.7°)
    let prevTan: number | null = null;
    for (let i = 0; i < 41; i += 1) {
      const target = {
        lat: obs.lat - 0.02 + i * 0.001,
        lon: obs.lon,
        altM: 4000,
        speedMs: 200,
        headingDeg: 0,
        headingValid: true,
        vertRateMs: 0,
      };
      const ang = c9Tangent(obs, target, cx, cy, radius, 'hemisphere', 143.7);
      expect(Number.isFinite(ang)).toBe(true);
      if (prevTan !== null) {
        let diff = Math.abs(ang - prevTan) % (2 * Math.PI);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        expect((diff * 180) / Math.PI).toBeLessThan(2);
      }
      prevTan = ang;
    }
  });

  it('10.1b PolarSkyDome JSDOM torture: iOS requestPermission rejection, desktop missing-sensor fallback, drag parking + stopPropagation, <6px tap & LOCK + N▲ reset', async () => {
    const jsdomMod = (await import('jsdom')) as {
      JSDOM: new (
        html: string,
        opts?: Record<string, unknown>
      ) => { window: Window & typeof globalThis };
    };
    const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://krunked-fpv.github.io/krunked_skymap/',
    });
    Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });
    Object.defineProperty(dom.window.document, 'visibilityState', {
      value: 'visible',
      configurable: true,
    });

    const w = dom.window as unknown as Record<string, unknown>;
    const rafCallbacks: Array<(ts: number) => void> = [];
    let rafSeq = 1;
    const scheduleRaf = (cb: (ts: number) => void): number => {
      rafCallbacks.push(cb);
      return rafSeq++;
    };
    const flushOneRaf = (ts: number) => {
      const batch = rafCallbacks.splice(0, rafCallbacks.length);
      for (const cb of batch) cb(ts);
    };

    // Build JSDOM-safe pointer events without WebIDL subclassing quirks
    const makePointerEvent = (
      type: string,
      init: {
        clientX: number;
        clientY: number;
        button?: number;
        buttons?: number;
        pointerId?: number;
        pointerType?: string;
        isPrimary?: boolean;
      }
    ): Event => {
      const ev = new dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: dom.window,
        clientX: init.clientX,
        clientY: init.clientY,
        button: init.button ?? 0,
        buttons: init.buttons ?? 0,
      });
      Object.defineProperties(ev, {
        pointerId: { value: init.pointerId ?? 1, configurable: true },
        pointerType: { value: init.pointerType ?? 'touch', configurable: true },
        isPrimary: { value: init.isPrimary ?? true, configurable: true },
      });
      return ev;
    };
    w.PointerEvent = dom.window.MouseEvent;
    w.requestAnimationFrame = scheduleRaf;
    w.cancelAnimationFrame = () => {};
    w.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    const mockCtx = makeMockCanvas2dContext();
    vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => mockCtx) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext
    );
    const fixedRect: DOMRect = {
      left: 0,
      top: 0,
      width: 400,
      height: 400,
      right: 400,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    };
    vi.spyOn(dom.window.Element.prototype, 'getBoundingClientRect').mockReturnValue(fixedRect);

    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLCanvasElement', dom.window.HTMLCanvasElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('PointerEvent', dom.window.MouseEvent);
    vi.stubGlobal('requestAnimationFrame', scheduleRaf);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');

    const parentDownSpy = vi.fn();
    const parentMoveSpy = vi.fn();
    const parentUpSpy = vi.fn();

    const container = dom.window.document.getElementById('root')!;
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(
          React.createElement(
            'div',
            {
              onPointerDown: parentDownSpy,
              onPointerMove: parentMoveSpy,
              onPointerUp: parentUpSpy,
            },
            React.createElement(C10PolarSkyDome)
          )
        );
      });

      const canvas = container.querySelector('canvas') as HTMLCanvasElement | null;
      expect(canvas).not.toBeNull();
      const capturedPointers = new Set<number>();
      (canvas as unknown as Record<string, unknown>).setPointerCapture = (id: number) =>
        capturedPointers.add(id);
      (canvas as unknown as Record<string, unknown>).hasPointerCapture = (id: number) =>
        capturedPointers.has(id);
      (canvas as unknown as Record<string, unknown>).releasePointerCapture = (id: number) =>
        capturedPointers.delete(id);

      // Step an initial render frame with a Zenith target at (200, 200) so tap hit-testing works
      const zenithFlight = makeOverheadTestFlight('flight:zenith1', 'ZEN01', 90);
      liveKinematicsRegistry.entities.set(zenithFlight.id, zenithFlight);
      await act(async () => {
        flushOneRaf(100);
      });

      // A. iOS DeviceOrientationEvent.requestPermission() rejection / NotAllowedError
      const requestPermissionMock = vi.fn(() =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
      );
      w.DeviceOrientationEvent = { requestPermission: requestPermissionMock };
      const compassBtn = container.querySelector(
        '[data-testid="skydome-compass-toggle"]'
      ) as HTMLButtonElement | null;
      expect(compassBtn).not.toBeNull();

      await act(async () => {
        compassBtn!.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(requestPermissionMock).toHaveBeenCalledTimes(1);
      expect(useSkyStore.getState().domeCompassActive).toBe(false);
      const deniedStatus = container.querySelector('[data-testid="skydome-compass-status"]');
      expect(deniedStatus?.textContent).toMatch(/permission denied/i);

      // B1. Desktop missing-sensor graceful fallback (DeviceOrientationEvent absent)
      delete w.DeviceOrientationEvent;
      await act(async () => {
        compassBtn!.click();
      });
      expect(useSkyStore.getState().domeCompassActive).toBe(false);
      expect(useSkyStore.getState().domeCompassSupported).toBe(false);
      expect(
        container.querySelector('[data-testid="skydome-compass-status"]')?.textContent
      ).toMatch(/No device compass detected/i);

      // B2. Desktop Chromium present DeviceOrientationEvent with 1.5s silent timeout fallback
      vi.useFakeTimers();
      w.DeviceOrientationEvent = function FakeDevOrient() {};
      await act(async () => {
        useSkyStore.setState({ domeCompassSupported: null, domeCompassActive: false });
      });
      await act(async () => {
        compassBtn!.click();
      });
      expect(useSkyStore.getState().domeCompassActive).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      expect(useSkyStore.getState().domeCompassActive).toBe(false);
      expect(useSkyStore.getState().domeCompassSupported).toBe(false);
      expect(
        container.querySelector('[data-testid="skydome-compass-status"]')?.textContent
      ).toMatch(/No device compass detected/i);
      vi.useRealTimers();

      // C. < 6px micro-movement acts as a tap/click (selects target) and does NOT alter domeRotationDeg
      await act(async () => {
        useSkyStore.setState({
          domeRotationDeg: 0,
          domeRotationLocked: false,
          domeCompassActive: false,
          selectedId: null,
          inspectorOpen: false,
        });
      });
      await act(async () => {
        canvas!.dispatchEvent(
          makePointerEvent('pointerdown', {
            clientX: 200,
            clientY: 200,
            button: 0,
            buttons: 1,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointermove', {
            clientX: 203,
            clientY: 202,
            button: 0,
            buttons: 1,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointerup', {
            clientX: 203,
            clientY: 202,
            button: 0,
            buttons: 0,
            pointerId: 7,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
      });
      expect(useSkyStore.getState().domeRotationDeg).toBe(0);
      expect(useSkyStore.getState().selectedId).toBe(zenithFlight.id);
      expect(parentDownSpy).not.toHaveBeenCalled();
      expect(parentMoveSpy).not.toHaveBeenCalled();
      expect(parentUpSpy).not.toHaveBeenCalled();

      // D. Drag-and-release parking: CCW drag to ~143.7°, disengages active compass, stays parked, stopPropagation()
      await act(async () => {
        useSkyStore.getState().selectEntity(null, false);
        useSkyStore.setState({
          domeRotationDeg: 0,
          domeRotationLocked: false,
          domeCompassActive: true,
        });
      });

      const r = 100;
      const ptAtDeg = (deg: number) => ({
        x: 200 + r * Math.cos((deg * Math.PI) / 180),
        y: 200 + r * Math.sin((deg * Math.PI) / 180),
      });
      const p0 = ptAtDeg(-90); // 12 o'clock
      const p1 = ptAtDeg(-161.85); // -71.85° CCW
      const p2 = ptAtDeg(126.3); // another -71.85° CCW -> total +143.7° dome heading

      await act(async () => {
        canvas!.dispatchEvent(
          makePointerEvent('pointerdown', {
            clientX: p0.x,
            clientY: p0.y,
            button: 0,
            buttons: 1,
            pointerId: 11,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointermove', {
            clientX: p1.x,
            clientY: p1.y,
            button: 0,
            buttons: 1,
            pointerId: 11,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointermove', {
            clientX: p2.x,
            clientY: p2.y,
            button: 0,
            buttons: 1,
            pointerId: 11,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointerup', {
            clientX: p2.x,
            clientY: p2.y,
            button: 0,
            buttons: 0,
            pointerId: 11,
            pointerType: 'touch',
            isPrimary: true,
          })
        );
      });

      const parkedDeg = useSkyStore.getState().domeRotationDeg;
      expect(parkedDeg).toBeCloseTo(143.7, 1);
      expect(useSkyStore.getState().domeCompassActive).toBe(false);
      expect(parentDownSpy).not.toHaveBeenCalled();
      expect(parentMoveSpy).not.toHaveBeenCalled();
      expect(parentUpSpy).not.toHaveBeenCalled();

      // Step multiple animation frames post-release -> ZERO snap-back
      await act(async () => {
        flushOneRaf(200);
        flushOneRaf(216);
        flushOneRaf(232);
      });
      expect(useSkyStore.getState().domeRotationDeg).toBeCloseTo(parkedDeg, 6);

      // E. LOCK state strictly blocks pointer drag, setDomeRotationDeg, and compass updates, while N▲ still resets to 000°
      const lockBtn = container.querySelector(
        '[data-testid="skydome-lock-toggle"]'
      ) as HTMLButtonElement | null;
      expect(lockBtn).not.toBeNull();
      await act(async () => {
        lockBtn!.click();
      });
      expect(useSkyStore.getState().domeRotationLocked).toBe(true);

      // Direct store mutation without force is blocked
      useSkyStore.getState().setDomeRotationDeg(275);
      expect(useSkyStore.getState().domeRotationDeg).toBeCloseTo(parkedDeg, 6);

      // Pointer drag while locked is blocked
      await act(async () => {
        canvas!.dispatchEvent(
          makePointerEvent('pointerdown', {
            clientX: p0.x,
            clientY: p0.y,
            button: 0,
            buttons: 1,
            pointerId: 12,
            pointerType: 'mouse',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointermove', {
            clientX: 300,
            clientY: 200,
            button: 0,
            buttons: 1,
            pointerId: 12,
            pointerType: 'mouse',
            isPrimary: true,
          })
        );
        canvas!.dispatchEvent(
          makePointerEvent('pointerup', {
            clientX: 300,
            clientY: 200,
            button: 0,
            buttons: 0,
            pointerId: 12,
            pointerType: 'mouse',
            isPrimary: true,
          })
        );
      });
      expect(useSkyStore.getState().domeRotationDeg).toBeCloseTo(parkedDeg, 6);

      // Compass sensor updates while locked are strictly blocked
      await act(async () => {
        useSkyStore.getState().setDomeCompassActive(true);
      });
      const absEvent = new dom.window.Event('deviceorientationabsolute');
      Object.defineProperty(absEvent, 'alpha', { value: 90 });
      Object.defineProperty(absEvent, 'absolute', { value: true });
      await act(async () => {
        dom.window.dispatchEvent(absEvent);
        flushOneRaf(300);
        flushOneRaf(316);
      });
      expect(useSkyStore.getState().domeRotationDeg).toBeCloseTo(parkedDeg, 6);

      // Explicit N▲ reset button still resets cleanly to 000° North even while LOCKED
      const northResetBtn = container.querySelector(
        '[data-testid="skydome-north-reset"]'
      ) as HTMLButtonElement | null;
      expect(northResetBtn).not.toBeNull();
      expect(northResetBtn!.textContent).toContain('N▲');
      await act(async () => {
        northResetBtn!.click();
      });
      expect(useSkyStore.getState().domeRotationDeg).toBe(0);
      expect(useSkyStore.getState().domeCompassActive).toBe(false);

      // F. Live unlocked hardware compass smoothly follows deviceorientationabsolute across North seam (359.9° -> 0.1°)
      await act(async () => {
        useSkyStore.setState({
          domeRotationDeg: 359.9,
          domeRotationLocked: false,
          domeCompassActive: true,
        });
      });
      const northCrossEv = new dom.window.Event('deviceorientationabsolute');
      Object.defineProperty(northCrossEv, 'alpha', { value: 359.9 }); // 360 - 359.9 = 0.1°
      Object.defineProperty(northCrossEv, 'absolute', { value: true });
      await act(async () => {
        dom.window.dispatchEvent(northCrossEv);
        for (let f = 0; f < 10; f += 1) {
          flushOneRaf(400 + f * 16);
        }
      });
      const smoothedHeading = useSkyStore.getState().domeRotationDeg;
      expect(Math.abs(c10ShortestDelta(smoothedHeading, 0.1))).toBeLessThan(0.05);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
    }
  }, 15_000);

  it('10.2 Location Command Palette mounts via document.body Portal with pointer-events/z-index stacking, coordinate submit, preset jump, X & backdrop close', async () => {
    const fs = await loadNodeFs();
    const cockpitCssRaw = fs.readFileSync(repoFileUrl('src/styles/cockpit.css'), 'utf8');

    // Audit cockpit.css modal pointer-events & top-layer z-index rules
    const backdropCssMatch = cockpitCssRaw.match(/\.cockpit-modal-backdrop\s*\{([\s\S]*?)\}/);
    expect(backdropCssMatch).not.toBeNull();
    expect(backdropCssMatch![1]).toMatch(/pointer-events:\s*auto/);
    const backdropZMatch = backdropCssMatch![1].match(/z-index:\s*(\d+)/);
    expect(backdropZMatch).not.toBeNull();
    expect(Number(backdropZMatch![1])).toBeGreaterThanOrEqual(100);

    const paletteCssMatch = cockpitCssRaw.match(/\.command-palette\s*\{([\s\S]*?)\}/);
    expect(paletteCssMatch).not.toBeNull();
    expect(paletteCssMatch![1]).toMatch(/pointer-events:\s*auto/);

    expect(controlDockSourceRaw).toContain('createPortal(');

    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      await act(async () => {
        useSkyStore.setState({ observer: { ...DCA }, locationStatus: 'ready' });
      });

      const omniboxBtn = appMount.container.querySelector(
        '[data-testid="omnibox-trigger"]'
      ) as HTMLButtonElement | null;
      expect(omniboxBtn).not.toBeNull();

      // 1. Click omnibox trigger -> opens Command Palette portaled directly under document.body
      await act(async () => {
        omniboxBtn!.click();
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(true);

      const backdrop = appMount.document.body.querySelector(
        '[data-testid="command-palette-backdrop"]'
      ) as HTMLElement | null;
      expect(backdrop).not.toBeNull();
      expect(backdrop!.className).toContain('cockpit-modal-backdrop');
      expect(backdrop!.parentElement).toBe(appMount.document.body);

      const dockWrap = appMount.container.querySelector('.control-dock-wrap');
      expect(dockWrap).not.toBeNull();
      expect(dockWrap!.contains(backdrop)).toBe(false);

      // 2. Clicking INSIDE .command-palette dialog card must NOT close modal
      const dialog = appMount.document.body.querySelector(
        '[data-testid="command-palette-dialog"]'
      ) as HTMLElement | null;
      expect(dialog).not.toBeNull();
      await act(async () => {
        dialog!.dispatchEvent(new appMount.window.MouseEvent('mousedown', { bubbles: true }));
        dialog!.dispatchEvent(new appMount.window.MouseEvent('click', { bubbles: true }));
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(true);

      // 3. Typing coordinates (33.9416, -118.4085) and clicking GO submits, moves observer & closes modal
      const input = appMount.document.body.querySelector(
        '[data-testid="command-palette-input"]'
      ) as HTMLInputElement | null;
      const submitBtn = appMount.document.body.querySelector(
        '[data-testid="command-palette-submit"]'
      ) as HTMLButtonElement | null;
      expect(input).not.toBeNull();
      expect(submitBtn).not.toBeNull();

      const valueSetter = Object.getOwnPropertyDescriptor(
        appMount.window.HTMLInputElement.prototype,
        'value'
      )?.set;
      await act(async () => {
        valueSetter?.call(input, '33.9416, -118.4085');
        input!.dispatchEvent(new appMount.window.Event('input', { bubbles: true }));
      });
      expect(submitBtn!.disabled).toBe(false);

      await act(async () => {
        submitBtn!.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useSkyStore.getState().observer.lat).toBeCloseTo(33.9416, 4);
      expect(useSkyStore.getState().observer.lon).toBeCloseTo(-118.4085, 4);
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);

      // 4. Reopen modal -> clicking Hotspot Preset jumps observer and closes modal
      await act(async () => {
        omniboxBtn!.click();
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(true);

      const hanedaBtn = appMount.document.body.querySelector(
        '[data-testid="preset-tokyo-haneda"]'
      ) as HTMLButtonElement | null;
      expect(hanedaBtn).not.toBeNull();
      await act(async () => {
        hanedaBtn!.click();
      });
      expect(useSkyStore.getState().observer.lat).toBeCloseTo(35.5494, 4);
      expect(useSkyStore.getState().observer.lon).toBeCloseTo(139.7798, 4);
      expect(useSkyStore.getState().observer.source).toBe('preset');
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);

      // 5. Reopen modal -> clicking X close button closes cleanly
      await act(async () => {
        omniboxBtn!.click();
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(true);
      const closeBtn = appMount.document.body.querySelector(
        '[data-testid="command-palette-close"]'
      ) as HTMLButtonElement | null;
      expect(closeBtn).not.toBeNull();
      await act(async () => {
        closeBtn!.click();
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);

      // 6. Reopen modal -> clicking outer backdrop closes cleanly
      await act(async () => {
        omniboxBtn!.click();
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(true);
      const reopenedBackdrop = appMount.document.body.querySelector(
        '[data-testid="command-palette-backdrop"]'
      ) as HTMLElement | null;
      expect(reopenedBackdrop).not.toBeNull();
      await act(async () => {
        reopenedBackdrop!.dispatchEvent(
          new appMount.window.MouseEvent('click', { bubbles: true })
        );
      });
      expect(useSkyStore.getState().commandPaletteOpen).toBe(false);
    } finally {
      await appMount.cleanup();
    }
  }, 15_000);

  it('10.3 PIP + Inspector geometry, translucent canvas, continuous dome-mode map & OVERHEAD quick-lock cycling integrity', async () => {
    const fs = await loadNodeFs();
    const cockpitCssRaw = fs.readFileSync(repoFileUrl('src/styles/cockpit.css'), 'utf8');

    // 1. Continuous map pane in dome mode & dynamic split padding
    const mapPaneCssMatch = cockpitCssRaw.match(/\.stage-map-pane,\s*\[data-pane='map'\]\s*\{([\s\S]*?)\}/);
    expect(mapPaneCssMatch).not.toBeNull();
    expect(mapPaneCssMatch![1]).toMatch(/display:\s*block\s*!important/);
    expect(cockpitCssRaw).not.toMatch(/\[data-layout='dome'\][^\{]*stage-map-pane[^\{]*\{[^\}]*display:\s*none/);

    const mapFrameLoopHead = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.indexOf('const frameLoop = (nowMs: number) => {'),
      tacticalMapSourceRaw.indexOf('const layoutChanged = state.layout !== lastLayout;')
    );
    expect(mapFrameLoopHead).not.toMatch(/if\s*\(\s*state\.layout\s*===\s*'dome'\s*\)\s*\{[^}]*\breturn;/);
    expect(tacticalMapSourceRaw).toContain('targetMap.setPadding(next)');
    expect(tacticalMapSourceRaw).toContain('computeLayoutCameraPadding');

    // Verify dynamic camera padding values across split/map/dome and desktop/mobile
    expect(c10ComputePadding('split', 1440, 900)).toEqual({ top: 0, bottom: 0, left: 0, right: 605 });
    expect(c10ComputePadding('split', 390, 844)).toEqual({ top: 0, bottom: 405, left: 0, right: 0 });
    expect(c10ComputePadding('map', 1440, 900)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
    expect(c10ComputePadding('dome', 1440, 900)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });

    // 2. Translucent Sky-Dome container (alpha 0.24..0.40, blur <= 4px, no blur(16px+)) + transparent root + clearRect w/o full-canvas fillRect
    const domePaneCssMatch = cockpitCssRaw.match(/\.stage-dome-pane,\s*\[data-pane='dome'\]\s*\{([\s\S]*?)\}/);
    expect(domePaneCssMatch).not.toBeNull();
    const domeBgAlpha = domePaneCssMatch![1].match(/rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\)/);
    expect(domeBgAlpha).not.toBeNull();
    expect(Number(domeBgAlpha![1])).toBeGreaterThanOrEqual(0.24);
    expect(Number(domeBgAlpha![1])).toBeLessThanOrEqual(0.40);
    const domeBlurMatch = domePaneCssMatch![1].match(/backdrop-filter:\s*blur\((\d+(?:\.\d+)?)px\)/);
    expect(domeBlurMatch).not.toBeNull();
    expect(Number(domeBlurMatch![1])).toBeLessThanOrEqual(4);
    expect(domePaneCssMatch![1]).not.toMatch(/blur\((?:1[6-9]|[2-9]\d)px\)|var\(--glass-blur\)/);

    expect(polarDomeSourceRaw).toContain("backgroundColor: 'transparent'");
    expect(polarDomeSourceRaw).toContain('ctx.clearRect(0, 0, canvas.width, canvas.height)');
    expect(polarDomeSourceRaw).not.toMatch(/ctx\.fillRect\(\s*0\s*,\s*0\s*,\s*(?:width|canvas\.width|m\.width)/);

    // 3. Desktop right-side +33% PIP (320x320, right-anchored, left: auto) & Inspector left-shift (zero 1440px overlap) + mobile clamp
    expect(cockpitCssRaw).toMatch(/--inspector-width:\s*340px;/);
    const pipDesktopMatch = cockpitCssRaw.match(
      /\.skymap-stage\[data-layout='map'\]\[data-pip='true'\]\s*\.stage-dome-pane,\s*\.skymap-stage--map\[data-pip='true'\]\s*\.stage-dome-pane\s*\{([\s\S]*?)\}/
    );
    expect(pipDesktopMatch).not.toBeNull();
    expect(pipDesktopMatch![1]).toMatch(/width:\s*320px/);
    expect(pipDesktopMatch![1]).toMatch(/height:\s*320px/);
    expect(pipDesktopMatch![1]).toMatch(/right:/);
    expect(pipDesktopMatch![1]).toMatch(/left:\s*auto/);

    const pipShiftMatch = cockpitCssRaw.match(
      /@media\s*\(min-width:\s*768px\)\s*\{[\s\S]*?:has\(\.target-inspector\.is-open\)\s*\.stage-dome-pane\s*\{([\s\S]*?)\}/
    );
    expect(pipShiftMatch).not.toBeNull();
    expect(pipShiftMatch![1]).toMatch(
      /transform:\s*translateX\(calc\(-1\s*\*\s*\(var\(--inspector-width\)\s*\+\s*12px\)\)\)/
    );

    // Explicit 1440px desktop non-overlap verification: PIP [756, 1076] vs Inspector [1088, 1428]
    const viewportW = 1440;
    const inspectorW = 340;
    const edgeGap = 12;
    const pipW = 320;
    const shiftPx = inspectorW + edgeGap; // 352px
    const inspectorLeft = viewportW - edgeGap - inspectorW; // 1088
    const inspectorRight = viewportW - edgeGap; // 1428
    const pipShiftedRight = viewportW - edgeGap - shiftPx; // 1076
    const pipShiftedLeft = pipShiftedRight - pipW; // 756
    expect(shiftPx).toBeGreaterThanOrEqual(352);
    expect([pipShiftedLeft, pipShiftedRight]).toEqual([756, 1076]);
    expect([inspectorLeft, inspectorRight]).toEqual([1088, 1428]);
    expect(pipShiftedRight).toBeLessThan(inspectorLeft);

    // Mobile PIP (<= 767px) clamped within calc(100vw - 24px) -> zero 390x844 overflow
    const mobileSection = cockpitCssRaw.slice(cockpitCssRaw.indexOf('@media (max-width: 767px)'));
    const mobilePipMatch = mobileSection.match(
      /\.skymap-stage\[data-layout='map'\]\[data-pip='true'\]\s*\.stage-dome-pane,\s*\.skymap-stage--map\[data-pip='true'\]\s*\.stage-dome-pane\s*\{([\s\S]*?)\}/
    );
    expect(mobilePipMatch).not.toBeNull();
    expect(mobilePipMatch![1]).toMatch(/width:\s*min\(208px,\s*calc\(100vw\s*-\s*24px\)\)/);
    expect(mobilePipMatch![1]).toMatch(/height:\s*min\(208px,\s*calc\(100vw\s*-\s*24px\)\)/);
    expect(Math.min(208, 390 - 24)).toBeLessThanOrEqual(366);

    // 4. Zero passive ZENITH UI labels remain in TopTelemetryBar.tsx and PolarSkyDome.tsx
    expect(topTelemetryBarSourceRaw).not.toMatch(/ZENITH/);
    expect(topTelemetryBarSourceRaw).toContain('OVERHEAD');
    expect(topTelemetryBarSourceRaw).toContain('OVERHEAD 2×');
    expect(topTelemetryBarSourceRaw).toContain('FULL SKY');

    expect(polarDomeSourceRaw).not.toMatch(/ZENITH/);
    expect(polarDomeSourceRaw).toContain('OVERHEAD 2×');
    expect(polarDomeSourceRaw).toContain('FULL SKY');

    // 5. JSDOM behavioral test of [data-testid="topbar-overhead-lock"] cycling + TargetInspector opening
    const appMount = await mountAppInJsdom();
    try {
      const { act } = await import('react');
      await act(async () => {
        useSkyStore.setState({ observer: { ...DCA }, locationStatus: 'ready' });
      });

      const overheadBtn = appMount.container.querySelector(
        '[data-testid="topbar-overhead-lock"]'
      ) as HTMLButtonElement | null;
      expect(overheadBtn).not.toBeNull();
      expect(overheadBtn!.textContent).toContain('OVERHEAD');

      // 0 targets: clicking never throws and keeps TargetInspector closed
      liveKinematicsRegistry.entities.clear();
      await act(async () => {
        expect(() => overheadBtn!.click()).not.toThrow();
      });
      expect(useSkyStore.getState().selectedId).toBeNull();
      expect(useSkyStore.getState().inspectorOpen).toBe(false);

      // Fallback cone (25°, 35° — none >= 45°): locks 35° first, cycles to 25°, wraps to 35°
      const f25 = makeOverheadTestFlight('flight:el25', 'EL25', 25);
      const f35 = makeOverheadTestFlight('flight:el35', 'EL35', 35);
      liveKinematicsRegistry.entities.set(f25.id, f25);
      liveKinematicsRegistry.entities.set(f35.id, f35);

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el35');
      expect(useSkyStore.getState().inspectorOpen).toBe(true);
      const inspectorEl = appMount.container.querySelector('[data-testid="target-inspector"]');
      expect(inspectorEl?.getAttribute('data-open')).toBe('true');
      expect(inspectorEl?.className).toContain('is-open');
      expect(inspectorEl?.textContent).toContain('EL35');

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el25');
      expect(inspectorEl?.textContent).toContain('EL25');

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el35');

      // Primary cone (50°, 72°, plus 30°): locks 72° first, cycles to 50°, wraps back to 72° (never 30°)
      liveKinematicsRegistry.entities.clear();
      const f30 = makeOverheadTestFlight('flight:el30', 'EL30', 30);
      const f50 = makeOverheadTestFlight('flight:el50', 'EL50', 50);
      const f72 = makeOverheadTestFlight('flight:el72', 'EL72', 72);
      liveKinematicsRegistry.entities.set(f30.id, f30);
      liveKinematicsRegistry.entities.set(f50.id, f50);
      liveKinematicsRegistry.entities.set(f72.id, f72);

      await act(async () => {
        useSkyStore.getState().selectEntity(null, false);
      });
      expect(useSkyStore.getState().inspectorOpen).toBe(false);

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el72');
      expect(useSkyStore.getState().inspectorOpen).toBe(true);
      expect(appMount.container.querySelector('[data-testid="target-inspector"]')?.textContent).toContain(
        'EL72'
      );

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el50');
      expect(appMount.container.querySelector('[data-testid="target-inspector"]')?.textContent).toContain(
        'EL50'
      );

      await act(async () => {
        overheadBtn!.click();
      });
      expect(useSkyStore.getState().selectedId).toBe('flight:el72');
    } finally {
      await appMount.cleanup();
    }
  }, 15_000);
});
