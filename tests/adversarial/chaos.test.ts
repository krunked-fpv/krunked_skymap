import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fallbackFlightsRaw from '../../public/data/fallback-flights.json?raw';
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
} from '../../src/services/flightsService';
import { fetchBalloons, normalizeSondeRecord } from '../../src/services/balloonsService';
import {
  fetchAirspace,
  isInsideContinentalUsOrTerritories,
} from '../../src/services/airspaceService';
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

function makeFallbackAwareFetch(
  externalBehavior: (url: string) => Promise<Response> | never
): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('fallback-flights.json')) {
      return new Response(fallbackFlightsRaw, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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

    // Cross-antimeridian shortest path from (0, 179.95) to (0, -179.95)
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

  it('builds geodesicCirclePolygon rings across non-polar observers without >180 deg jumps', () => {
    const nonPolarCases: Array<{ id: string; lat: number; lon: number; radiusKm: number }> = [
      { id: 'equator-120', lat: 0, lon: 0, radiusKm: 120 },
      { id: 'sydney-250', lat: -33.86, lon: 151.2, radiusKm: 250 },
      { id: 'svalbard-250', lat: 78.22, lon: 15.63, radiusKm: 250 },
      { id: 'antimeridian-e-120', lat: 0, lon: 179.95, radiusKm: 120 },
      { id: 'antimeridian-w-250', lat: 0, lon: -179.95, radiusKm: 250 },
    ];

    for (const c of nonPolarCases) {
      const rings = geodesicCirclePolygon(c.lat, c.lon, c.radiusKm, 72);
      expect(rings.length, `${c.id} should return rings`).toBeGreaterThanOrEqual(1);
      for (let r = 0; r < rings.length; r++) {
        expect(rings[r].length).toBeGreaterThanOrEqual(4);
        expect(rings[r][0]).toEqual(rings[r][rings[r].length - 1]);
        assertAllFiniteCoords(rings[r], `${c.id}.ring[${r}]`);
      }
    }
  });

  it('[DEFECT-02] geodesicCirclePolygon jumps 360 deg across +-180 when closing polar-enclosing circles', () => {
    const polarCases: Array<{ id: string; lat: number; lon: number; radiusKm: number }> = [
      { id: 'south-pole-120', lat: -89.99, lon: 0, radiusKm: 120 },
      { id: 'svalbard-footprint-2200', lat: 78.22, lon: 15.63, radiusKm: 2200 },
    ];
    for (const c of polarCases) {
      const rings = geodesicCirclePolygon(c.lat, c.lon, c.radiusKm, 72);
      expect(rings.length).toBeGreaterThanOrEqual(1);
      for (let r = 0; r < rings.length; r++) {
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
  it('propagates valid ISS/LEO TLEs cleanly alongside corrupt/malformed TLEs without NaNs', () => {
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
      { name: 'EMPTY', noradId: 91000, group: 'visual', line1: '', line2: '' },
      null as unknown as TleRecord,
    ];

    const parsed = parseTleRecords(directRecords);
    expect(parsed.some((p) => p.meta.noradId === 25544)).toBe(true);
    expect(parsed.some((p) => p.meta.noradId === 33591)).toBe(true);

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

  it('[DEFECT-01] computeSatelliteOrbitOverlay crashes when SGP4 returns undefined position on decayed TLE', () => {
    const parsed = parseTleRecords([ISS_TLE, DECAYED_TLE]);
    const decayed = parsed.find((s) => s.meta.noradId === 90007);
    expect(decayed).toBeDefined();

    expect(() => {
      const ov = computeSatelliteOrbitOverlay(decayed!, ISS_EPOCH_MS, EXTREME_OBSERVERS[0].observer);
      expect(Number.isFinite(ov.footprintRadiusKm)).toBe(true);
    }).not.toThrow();
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

describe('Challenge 4 — Multi-API Blackout & Malformed Payload Chaos', () => {
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

  it('survives network TypeError, HTTP 429, HTTP 503, and truncated JSON across all 4 services with clean fallbacks', async () => {
    const chaosScenarios: Array<{
      name: string;
      external: (url: string) => Promise<Response>;
    }> = [
      {
        name: 'TypeError(Failed to fetch)',
        external: async () => {
          throw new TypeError('Failed to fetch');
        },
      },
      {
        name: 'HTTP 429 Rate Limited',
        external: async () =>
          new Response('Rate limit exceeded', { status: 429, statusText: 'Too Many Requests' }),
      },
      {
        name: 'HTTP 503 Service Unavailable',
        external: async () =>
          new Response('Upstream unavailable', { status: 503, statusText: 'Service Unavailable' }),
      },
      {
        name: 'Truncated / Corrupt JSON',
        external: async () => new Response('{"ac":[{"hex":"a12', { status: 200 }),
      },
    ];

    for (const scenario of chaosScenarios) {
      clearFlightsServiceCache();
      clearTleCache();
      vi.stubGlobal('fetch', makeFallbackAwareFetch(scenario.external));

      const flights = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
      expect(flights.status, `${scenario.name} flights.status`).toBe('fallback');
      expect(flights.entities.length, `${scenario.name} flights.entities`).toBeGreaterThan(0);

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

    // Total blackout where even ./data/* fallback assets fail with TypeError
    clearFlightsServiceCache();
    clearTleCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const totalBlackoutFlights = await fetchFlightsCascade(DCA, 120, undefined, { force: true });
    expect(totalBlackoutFlights.status).toBe('fallback');
    expect(totalBlackoutFlights.entities.length).toBeGreaterThan(0);

    const totalBlackoutAirspace = await fetchAirspace(DCA, 120);
    expect(totalBlackoutAirspace.status).toBe('error');
    expect(totalBlackoutAirspace.airspace.uasfm.features).toEqual([]);

    const totalBlackoutTles = await refreshTlesIfStale(true);
    expect(totalBlackoutTles.status).toBe('fallback');
    expect(totalBlackoutTles.records).toEqual([]);
  });

  it('normalizes ADS-B edge cases: alt_baro="ground", Dead Sea -390m, lat=undefined, track=null, dbFlags 1/4/8, and Heathrow coverage', async () => {
    const deadSeaObs: ObserverLocation = {
      lat: 31.5,
      lon: 35.5,
      altM: -410,
      label: 'Dead Sea',
      source: 'manual',
    };

    const grounded = normalizeAdsbxAircraft(
      {
        hex: 'a10001',
        flight: 'BAW101',
        lat: 51.47,
        lon: -0.4543,
        alt_baro: 'ground',
        gs: 12,
        track: null,
        dbFlags: 0,
      },
      HEATHROW
    );
    expect(grounded).not.toBeNull();
    expect(grounded?.onGround).toBe(true);
    expect(grounded?.altBaroM).toBe(0);
    expect(grounded?.altM).toBe(0);
    expect(grounded?.headingDeg).toBe(0);

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

    expect(
      normalizeAdsbxAircraft(
        { hex: 'a10003', lat: undefined, lon: -0.4543, alt_baro: 5000, track: null },
        HEATHROW
      )
    ).toBeNull();

    const milFlag = normalizeAdsbxAircraft(
      { hex: 'a10004', flight: 'CIV123', lat: 51.5, lon: -0.4, alt_baro: 10000, dbFlags: 1 },
      HEATHROW
    );
    expect(milFlag?.isMilitary).toBe(true);
    expect(milFlag?.category).toBe('military');
    expect(milFlag?.isPia).toBe(false);
    expect(milFlag?.isLadd).toBe(false);

    const piaFlag = normalizeAdsbxAircraft(
      { hex: 'a10005', flight: 'PIA777', lat: 51.5, lon: -0.4, alt_baro: 10000, dbFlags: 4 },
      HEATHROW
    );
    expect(piaFlag?.isMilitary).toBe(false);
    expect(piaFlag?.isPia).toBe(true);
    expect(piaFlag?.isLadd).toBe(false);

    const laddFlag = normalizeAdsbxAircraft(
      { hex: 'a10006', flight: 'N12345', lat: 51.5, lon: -0.4, alt_baro: 10000, dbFlags: 8 },
      HEATHROW
    );
    expect(laddFlag?.isMilitary).toBe(false);
    expect(laddFlag?.isPia).toBe(false);
    expect(laddFlag?.isLadd).toBe(true);

    expect(isInsideContinentalUsOrTerritories(HEATHROW.lat, HEATHROW.lon)).toBe(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const heathrowAirspace = await fetchAirspace(HEATHROW, 120);
    expect(heathrowAirspace.airspace.usCoverage).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('[DEFECT-09] flightsService rate-limiter must not mask fallback status as cached or bypass rate limit when prevEntities is empty', async () => {
    vi.stubGlobal(
      'fetch',
      makeFallbackAwareFetch(async () => new Response('Unavailable', { status: 503 }))
    );

    const first = await fetchFlightsCascade(DCA, 120);
    expect(first.status).toBe('fallback');

    const fetchCallsBeforeSecond = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const second = await fetchFlightsCascade(DCA, 120, first.entities);
    expect(
      second.status,
      'Cooldown hit after fallback masked status as "cached" instead of "fallback"'
    ).toBe('fallback');

    await fetchFlightsCascade(DCA, 120);
    const fetchCallsAfterThird = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(
      fetchCallsAfterThird,
      'Non-forced call within 10s cooldown bypassed rate limiter when prevEntities was empty'
    ).toBe(fetchCallsBeforeSecond);
  });
});

describe('Challenge 5 — 60fps Memory Hygiene, Cleanup & Adversarial Bug Probes', () => {
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

  it('[DEFECT-03] App.tsx checks "sat:" instead of "sat-", breaking OrbitOverlay & pass arcs for every satellite', () => {
    const parsed = parseTleRecords([ISS_TLE]);
    const pool = selectSatellitePool(parsed, true);
    const { kinematics, meta } = propagateSatellites(pool, ISS_EPOCH_MS, {
      observer: EXTREME_OBSERVERS[0].observer,
      radiusKm: 25_000,
      orbitalScope: 'hemisphere',
      activeGroups: { stations: true, visual: true, starlink: true },
      fullConstellation: true,
    });
    const unpacked = unpackSatelliteKinematics(kinematics, meta, ISS_EPOCH_MS);
    expect(unpacked[0].id).toBe('sat-25544');

    expect(
      appSourceRaw.includes("startsWith('sat-')"),
      'App.tsx line 340 checks selectedId.startsWith("sat:") instead of "sat-", preventing computeOrbit() from ever firing'
    ).toBe(true);
  });

  it('[DEFECT-04] App.tsx prunes SondeHub radiosondes after 5 min (300s) despite 3h/6h SondeHub fetch window', () => {
    expect(balloonsSourceRaw).toContain('last=10800');
    const match = appSourceRaw.match(
      /pushAtmospheric\(liveKinematicsRegistry\.rawBalloons,\s*\d+,\s*([\d_]+)\)/
    );
    expect(match).not.toBeNull();
    const pruneMs = Number(match![1].replaceAll('_', ''));
    expect(
      pruneMs,
      `App.tsx prunes balloons at ${pruneMs}ms (< 10,800,000ms SondeHub window), dropping valid active sondes immediately`
    ).toBeGreaterThanOrEqual(10_800_000);
  });

  it('[DEFECT-05] App.tsx buildUrlHashString drops alt & label params, and TargetInspector renders satellite altitude in NM', () => {
    const buildHashBlock = appSourceRaw.slice(
      appSourceRaw.indexOf('function buildUrlHashString'),
      appSourceRaw.indexOf('export default function App')
    );
    expect(
      buildHashBlock.includes("params.set('label'"),
      'buildUrlHashString omits label parameter parsed by parseUrlHashPatch'
    ).toBe(true);
    expect(
      buildHashBlock.includes("params.set('alt'"),
      'buildUrlHashString omits alt parameter parsed by parseUrlHashPatch'
    ).toBe(true);

    expect(
      formatInspectorAltitude(420_000, 'aviation'),
      'Inspector formatAltitude formats orbital altitude in NM instead of km'
    ).toMatch(/^420(\.0)? km$/);
    expect(
      formatInspectorSpeed(7660, 'aviation'),
      'Inspector formatSpeed formats orbital velocity in kt instead of km/s'
    ).toContain('km/s');
    expect(formatInspectorDoppler(8420)).toContain('kHz');
  });

  it('[DEFECT-06] App.tsx retains disconnected OpenDroneID webhook drones in liveWebhookDronesRef', () => {
    const cleanupSlice = appSourceRaw.slice(
      appSourceRaw.indexOf('// 5. OpenDroneID Live Client'),
      appSourceRaw.indexOf('// 6. Target Lock Audio Feedback')
    );
    expect(
      cleanupSlice.includes('liveWebhookDronesRef.current.clear()'),
      'OpenDroneID disconnect cleanup does not clear liveWebhookDronesRef, causing disconnected drones to resurrect every 1s'
    ).toBe(true);
  });

  it('[DEFECT-07] PolarSkyDome cursor style conflict & TacticalMap hover/cursor leak on missing/hidden targets', () => {
    const hasInlineCursorConflict = /style=\{\{[^}]*cursor:\s*'crosshair'/.test(polarDomeSourceRaw);
    expect(
      hasInlineCursorConflict,
      'PolarSkyDome mixes inline JSX cursor: crosshair with imperative canvas.style.cursor = pointer'
    ).toBe(false);

    const hoverSyncSlice = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.indexOf('// Refresh active hover tooltip'),
      tacticalMapSourceRaw.indexOf('const containerWidth')
    );
    expect(
      hoverSyncSlice.includes('setHoveredId(null)'),
      'TacticalMap frameLoop clears hoverTip without resetting hoveredId or canvas cursor when target vanishes/hides'
    ).toBe(true);
  });

  it('[DEFECT-08] Duplicate audio triggers, missing OrbitOverlay layer gating, and ControlDock post-select dropdown reopen', () => {
    const sweepCallers =
      (appSourceRaw.includes('playSweepPulse()') ? 1 : 0) +
      (polarDomeSourceRaw.includes('playSweepPulse()') ? 1 : 0);
    expect(sweepCallers, 'Both App.tsx and PolarSkyDome.tsx call playSweepPulse() on manual sweep').toBe(
      1
    );

    const mapOrbitScope = tacticalMapSourceRaw.slice(
      tacticalMapSourceRaw.indexOf('function buildOrbitOverlayFc'),
      tacticalMapSourceRaw.indexOf('// Smooth camera follow')
    );
    expect(
      mapOrbitScope.includes('satellite'),
      'TacticalMap orbit overlay ignores layers.satellite visibility toggle'
    ).toBe(true);

    const selectBlock = controlDockSourceRaw.slice(
      controlDockSourceRaw.indexOf('const selectSearchResult'),
      controlDockSourceRaw.indexOf('const handleSearchKeyDown')
    );
    expect(
      /Ref\.current\s*=|selectedLabel/.test(selectBlock),
      'ControlDock.selectSearchResult mutates query without suppressing debounced search, reopening dropdown 300ms after pick'
    ).toBe(true);
  });

  it('[DEFECT-10] AstroClient computeOrbit promise hangs indefinitely if worker posts { type: "error" }', async () => {
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
    expect(
      outcome,
      'AstroClient.computeOrbit promise hung when worker returned { type: "error" }'
    ).toBe('settled');
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
