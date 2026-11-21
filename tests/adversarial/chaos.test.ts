import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fallbackAirspaceRaw from '../../public/data/fallback-airspace.geojson?raw';
import stationsTleRaw from '../../public/data/tle/stations.tle?raw';
import visualTleRaw from '../../public/data/tle/visual.tle?raw';
import starlinkTleRaw from '../../public/data/tle/starlink.tle?raw';
import appSourceRaw from '../../src/App.tsx?raw';
import balloonsSourceRaw from '../../src/services/balloonsService.ts?raw';
import controlDockSourceRaw from '../../src/components/hud/ControlDock.tsx?raw';
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
  fetchFlightsCascade,
  normalizeAdsbxAircraft,
  normalizeOpenSkyState,
} from '../../src/services/flightsService';
import { fetchBalloons, normalizeSondeRecord } from '../../src/services/balloonsService';
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
import { useSkyStore } from '../../src/store/useSkyStore';
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
    const pruneSlice = polarDomeSourceRaw.slice(
      polarDomeSourceRaw.indexOf('// Immediately prune stale trail cache entries'),
      polarDomeSourceRaw.indexOf('// Draw lowest priority first')
    );
    expect(pruneSlice).toContain('if (!activeIds.has(key))');
    expect(pruneSlice).toContain('polarTrailsRef.current.delete(key)');
    expect(pruneSlice).toContain('lastTrailSampleRef.current.delete(key)');

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
        return ['krunked-skymap-v1', 'krunked-skymap-v2'];
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

    // Activate deletes old cache versions while keeping current CACHE_VERSION
    const activateTasks: Array<Promise<unknown>> = [];
    listeners.get('activate')?.({
      waitUntil(p: Promise<unknown>) {
        activateTasks.push(p);
      },
    });
    await Promise.all(activateTasks);
    expect(deletedCaches).toEqual(['krunked-skymap-v1']);

    // Telemetry and /api-proxy/ URLs MUST bypass respondWith()
    const fetchListener = listeners.get('fetch')!;
    const bypassUrls = [
      'https://api.adsb.lol/v2/point/38.85/-77.04/65',
      'https://opensky-network.org/api/states/all?lamin=38&lomin=-78&lamax=39&lomax=-76',
      'https://api.v2.sondehub.org/sondes?lat=38.85&lon=-77.04',
      'https://example.github.io/krunked_skymap/api-proxy/adsb-fi/api/v2/lat/38.85/lon/-77.04/dist/65',
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

    const viteConfig = fs.readFileSync(repoFileUrl('vite.config.ts'), 'utf8');
    expect(viteConfig).toContain("base: './'");
    expect(viteConfig).toContain("'/api-proxy/adsb-fi'");
    expect(viteConfig).toContain("'/api-proxy/adsb-lol'");
    expect(viteConfig).toContain("'/api-proxy/airplanes-live'");
  });
});
