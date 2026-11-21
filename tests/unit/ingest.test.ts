import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AirspaceData, FlightEntity, ObserverLocation } from '../../src/types/sky-contracts';
import {
  computeBearingDeg,
  computeTopocentricLookAngles,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeLonDeg,
  pointInGeoJsonFeature,
} from '../../src/services/geoHelpers';
import {
  CircuitBreaker,
  CircuitOpenError,
  HttpError,
  TokenBucketRateLimiter,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
} from '../../src/services/httpClient';
import {
  classifyMilitary,
  clearFlightsServiceCache,
  fetchFlightsCascade,
  normalizeAdsbxAircraft,
  normalizeOpenSkyState,
} from '../../src/services/flightsService';
import {
  clearTleCache,
  loadInitialTles,
  parseTleText,
  refreshTlesIfStale,
} from '../../src/services/satellitesService';
import { fetchBalloons, normalizeSondeRecord } from '../../src/services/balloonsService';
import {
  evaluateDroneAirspaceCompliance,
  fetchAirspace,
  isInsideContinentalUsOrTerritories,
} from '../../src/services/airspaceService';
import {
  OpenDroneIdClient,
  normalizeOdidPayload,
  stepSimulatedDrones,
} from '../../src/services/openDroneIdService';
import {
  parseDirectCoordinates,
  searchLocation,
} from '../../src/services/geocodingService';

const DCA_OBSERVER: ObserverLocation = {
  lat: 38.8512,
  lon: -77.0402,
  altM: 12,
  label: 'DC / Potomac Corridor',
  source: 'preset',
};

const TOKYO_OBSERVER: ObserverLocation = {
  lat: 35.5494,
  lon: 139.7798,
  altM: 11,
  label: 'Tokyo Haneda / Kanto',
  source: 'preset',
};

const SAMPLE_ISS_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26324.51234567  .00016717  00000-0  10270-3 0  9005',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
].join('\n');

const SAMPLE_NOAA_TLE = [
  '0 NOAA 19',
  '1 33591U 09005A   26324.21000000  .00000123  00000-0  91234-4 0  9991',
  '2 33591  99.1900 120.5000 0014500  45.1000 315.1000 14.12500000800001',
].join('\n');

const SAMPLE_AIRSPACE: AirspaceData = {
  usCoverage: true,
  uasfm: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { CEILING: 200, UNIT: 'FT', APT1_ICAO: 'KDCA' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-77.08, 38.82],
              [-77.0, 38.82],
              [-77.0, 38.88],
              [-77.08, 38.88],
              [-77.08, 38.82],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { CEILING: 400, UNIT: 'FT', APT1_ICAO: 'KIAD' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-77.2, 38.82],
              [-77.06, 38.82],
              [-77.06, 38.88],
              [-77.2, 38.88],
              [-77.2, 38.82],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { CEILING: 0, UNIT: 'FT', APT1_ICAO: 'KDCA-RWY' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-77.045, 38.845],
              [-77.035, 38.845],
              [-77.035, 38.855],
              [-77.045, 38.855],
              [-77.045, 38.845],
            ],
          ],
        },
      },
    ],
  },
  sua: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { NAME: 'DC FRZ P-56', TYPE_CODE: 'P' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-77.05, 38.89],
              [-77.01, 38.89],
              [-77.01, 38.91],
              [-77.05, 38.91],
              [-77.05, 38.89],
            ],
          ],
        },
      },
    ],
  },
};

describe('geoHelpers self-contained WGS-84 & GeoJSON primitives', () => {
  it('computes zenith look angle, greatCircleDestination roundtrip, and polygon holes', () => {
    const zenith = computeTopocentricLookAngles(
      { lat: 38.8512, lon: -77.0402, altM: 12 },
      { lat: 38.8512, lon: -77.0402, altM: 10012 }
    );
    expect(zenith.elevationDeg).toBeCloseTo(90, 4);
    expect(zenith.slantRangeKm).toBeCloseTo(10, 3);
    expect(zenith.belowHorizon).toBe(false);

    const dest = greatCircleDestination(38.8512, -77.0402, 90, 50);
    expect(haversineDistanceKm(38.8512, -77.0402, dest.lat, dest.lon)).toBeCloseTo(50, 1);
    expect(normalizeLonDeg(185)).toBe(-175);
    expect(normalizeLonDeg(-190)).toBe(170);

    const donutFeature: GeoJSON.Feature = {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1],
            [-1, -1],
          ],
          [
            [-0.25, -0.25],
            [0.25, -0.25],
            [0.25, 0.25],
            [-0.25, 0.25],
            [-0.25, -0.25],
          ],
        ],
      },
    };
    expect(pointInGeoJsonFeature(0.5, 0.5, donutFeature)).toBe(true);
    expect(pointInGeoJsonFeature(0, 0, donutFeature)).toBe(false);
  });
});

describe('httpClient resilience primitives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('enforces TokenBucketRateLimiter >= 10s per key while isolating separate keys', () => {
    let now = 100_000;
    const limiter = new TokenBucketRateLimiter({
      minIntervalMs: 10_000,
      capacity: 1,
      nowFn: () => now,
    });

    expect(limiter.tryConsume('key-a')).toBe(true);
    expect(limiter.tryConsume('key-a')).toBe(false);
    expect(limiter.tryConsume('key-b')).toBe(true);

    now += 9_999;
    expect(limiter.canConsume('key-a')).toBe(false);
    expect(limiter.getWaitMs('key-a')).toBe(1);

    now += 1;
    expect(limiter.tryConsume('key-a')).toBe(true);
  });

  it('opens CircuitBreaker after failure threshold and recovers after cooldown', async () => {
    let now = 50_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
      nowFn: () => now,
    });

    await expect(
      breaker.execute(async () => {
        throw new Error('upstream 503');
      }, 'adsb.lol')
    ).rejects.toThrow('upstream 503');
    expect(breaker.getState('adsb.lol')).toBe('closed');

    await expect(
      breaker.execute(async () => {
        throw new Error('upstream 503');
      }, 'adsb.lol')
    ).rejects.toThrow('upstream 503');
    expect(breaker.getState('adsb.lol')).toBe('open');

    await expect(
      breaker.execute(async () => 'ok', 'adsb.lol')
    ).rejects.toBeInstanceOf(CircuitOpenError);

    now += 30_001;
    expect(breaker.getState('adsb.lol')).toBe('half-open');
    const result = await breaker.execute(async () => 'recovered', 'adsb.lol');
    expect(result).toBe('recovered');
    expect(breaker.getState('adsb.lol')).toBe('closed');
  });

  it('fetches text, throws HttpError on non-2xx, and aborts on timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('PLAIN TLE TEXT', { status: 200 }))
        .mockResolvedValueOnce(
          new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' })
        )
    );

    await expect(fetchTextWithTimeout('https://example.test/tle')).resolves.toBe('PLAIN TLE TEXT');
    await expect(fetchJsonWithTimeout('https://example.test/api')).rejects.toBeInstanceOf(
      HttpError
    );

    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const promise = fetchJsonWithTimeout('https://example.test/slow', { timeoutMs: 1200 });
    const assertion = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1250);
    await assertion;
  });
});

describe('flightsService classification, normalization & cascade', () => {
  beforeEach(() => {
    clearFlightsServiceCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('accurately classifies military targets by dbFlags, ICAO hex ranges, and callsign', () => {
    // Civil US N-number tail boundary (A00001 - ADF7C7) vs US DoD (ADF7C8 - AFFFFF)
    expect(classifyMilitary('a00001', 'N1', 0)).toBe(false);
    expect(classifyMilitary('adf7c7', 'N99999', 0)).toBe(false);
    expect(classifyMilitary('adf7c8', 'N/A', 0)).toBe(true);
    expect(classifyMilitary('ae1234', 'BOXER12', 0)).toBe(true);
    expect(classifyMilitary('afffff', '', 0)).toBe(true);

    // UK RAF (43C000-43CFFF), Luftwaffe (3F4000-3FBFFF), RAAF (7CF800-7CFFFF)
    expect(classifyMilitary('43c123', 'RRR221', 0)).toBe(true);
    expect(classifyMilitary('3f4100', 'GAF101', 0)).toBe(true);
    expect(classifyMilitary('7cf812', 'ASY401', 0)).toBe(true);

    // dbFlags bit 0
    expect(classifyMilitary('a12345', 'UAL418', 1)).toBe(true);
    expect(classifyMilitary('a12345', 'UAL418', 8)).toBe(false); // LADD only

    // Callsigns
    expect(classifyMilitary('a11111', 'RCH842', 0)).toBe(true);
    expect(classifyMilitary('a11111', 'SAM45', 0)).toBe(true);
    expect(classifyMilitary('a11111', 'PAT104', 0)).toBe(true);
    expect(classifyMilitary('a11111', 'UAL418', 0)).toBe(false);
    expect(classifyMilitary('a11111', 'SAMA100', 0)).toBe(false);
  });

  it('normalizes ADSBx v2 edge cases: ground, negative baro alt, nulls, squawk 7700, trails', () => {
    const grounded = normalizeAdsbxAircraft(
      {
        hex: 'A1B2C3',
        flight: 'DAL902  ',
        lat: 38.85,
        lon: -77.04,
        alt_baro: 'ground',
        gs: null,
        track: null,
        baro_rate: null,
        t: 'A359',
        category: 'A5',
        dbFlags: 8,
      },
      DCA_OBSERVER
    );

    expect(grounded).not.toBeNull();
    expect(grounded?.id).toBe('flight:a1b2c3');
    expect(grounded?.callsign).toBe('DAL902');
    expect(grounded?.onGround).toBe(true);
    expect(grounded?.altBaroM).toBe(0);
    expect(grounded?.altM).toBe(0);
    expect(grounded?.speedMs).toBe(0);
    expect(grounded?.headingDeg).toBe(0);
    expect(grounded?.headingValid).toBe(false);
    expect(grounded?.vertRateMs).toBe(0);
    expect(grounded?.airframeClass).toBe('heavy');
    expect(grounded?.isLadd).toBe(true);

    // Negative barometric altitude (high local QNH) without alt_geom
    const negBaro = normalizeAdsbxAircraft(
      {
        hex: 'a22222',
        flight: 'TEST01',
        lat: 38.9,
        lon: -77.02,
        alt_baro: -200,
        gs: 120,
        track: 365,
        squawk: '7700',
      },
      DCA_OBSERVER
    );
    expect(negBaro).not.toBeNull();
    expect(negBaro?.onGround).toBe(false);
    expect(negBaro?.altBaroM).toBeCloseTo(-60.96, 2);
    expect(negBaro?.altM).toBe(0);
    expect(negBaro?.headingDeg).toBe(5);
    expect(negBaro?.headingValid).toBe(true);
    expect(negBaro?.emergencyFlag).toContain('7700');

    // Trail preservation
    const t0 = Date.now();
    const secondTick = normalizeAdsbxAircraft(
      {
        hex: 'a22222',
        flight: 'TEST01',
        lat: 38.92,
        lon: -77.0,
        alt_baro: 1500,
        gs: 140,
        track: 45,
      },
      DCA_OBSERVER,
      negBaro ?? undefined,
      t0 + 5000
    );
    expect(secondTick?.trail.length).toBe(2);

    // Trail resets on > 90s gap or > 25km jump
    const staleGapTick = normalizeAdsbxAircraft(
      {
        hex: 'a22222',
        flight: 'TEST01',
        lat: 38.921,
        lon: -77.001,
        alt_baro: 1500,
        gs: 140,
        track: 45,
      },
      DCA_OBSERVER,
      secondTick ?? undefined,
      t0 + 100_000
    );
    expect(staleGapTick?.trail).toHaveLength(1);

    const teleportTick = normalizeAdsbxAircraft(
      {
        hex: 'a22222',
        flight: 'TEST01',
        lat: 39.3,
        lon: -77.0,
        alt_baro: 1500,
        gs: 140,
        track: 45,
      },
      DCA_OBSERVER,
      secondTick ?? undefined,
      t0 + 10_000
    );
    expect(teleportTick?.trail).toHaveLength(1);

    // Dead Sea -390m preserved; corrupt alt (< -500m / > 60000m), corrupt speed (<0 / >1200 m/s), Null Island rejected
    const deadSeaObs: ObserverLocation = {
      lat: 31.5,
      lon: 35.5,
      altM: -410,
      label: 'Dead Sea',
      source: 'manual',
    };
    const deadSea = normalizeAdsbxAircraft(
      {
        hex: 'a33333',
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
    expect(deadSea).not.toBeNull();
    expect(deadSea?.altM).toBeCloseTo(-390, 0);
    expect(deadSea?.headingValid).toBe(false);

    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 0, lon: 0, alt_baro: 5000 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 0.00005, lon: -0.00005, alt_baro: 5000 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 38.85, lon: -77.04, alt_geom: -2000 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 38.85, lon: -77.04, alt_baro: 250_000 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 38.85, lon: -77.04, alt_baro: 5000, gs: -10 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 38.85, lon: -77.04, alt_baro: 5000, gs: 2600 }, DCA_OBSERVER)
    ).toBeNull();

    // Malformed / missing coordinates rejected cleanly
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: null, lon: -77.04 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: '', lat: 38.85, lon: -77.04 }, DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeAdsbxAircraft({ hex: 'a12345', lat: 95, lon: -77.04 }, DCA_OBSERVER)
    ).toBeNull();
  });

  it('computes headingValid=false when track is null without prior fix, and derives headingValid=true bearing when delta > 50m', () => {
    const t0 = 1_760_000_000_000;
    const first = normalizeAdsbxAircraft(
      { hex: 'a55555', flight: 'BRG1', lat: 38.85, lon: -77.04, alt_baro: 5000, gs: 120, track: null },
      DCA_OBSERVER,
      undefined,
      t0
    );
    expect(first).not.toBeNull();
    expect(first?.headingValid).toBe(false);
    expect(first?.headingDeg).toBe(0);

    // Small jitter (<= 50m) stays headingValid=false
    const tinyMove = normalizeAdsbxAircraft(
      { hex: 'a55555', flight: 'BRG1', lat: 38.8501, lon: -77.04, alt_baro: 5000, gs: 120, track: null },
      DCA_OBSERVER,
      first ?? undefined,
      t0 + 2000
    );
    expect(tinyMove?.headingValid).toBe(false);
    expect(tinyMove?.headingDeg).toBe(0);

    // Significant movement (> 50m eastbound) derives bearing ~90° with headingValid=true
    const movedEast = greatCircleDestination(38.85, -77.04, 90, 0.25);
    const derived = normalizeAdsbxAircraft(
      {
        hex: 'a55555',
        flight: 'BRG1',
        lat: movedEast.lat,
        lon: movedEast.lon,
        alt_baro: 5000,
        gs: 120,
        track: null,
      },
      DCA_OBSERVER,
      first ?? undefined,
      t0 + 4000
    );
    expect(derived?.headingValid).toBe(true);
    expect(derived?.headingDeg).toBeCloseTo(computeBearingDeg(38.85, -77.04, movedEast.lat, movedEast.lon), 1);
    expect(derived?.headingDeg).toBeCloseTo(90, 0);

    // OpenSky track=null without prior vs with >50m delta
    const osFirst = normalizeOpenSkyState(
      ['a66666', 'OSK1', 'US', Math.floor(t0 / 1000), Math.floor(t0 / 1000), -77.04, 38.85, 5000, false, 150, null],
      DCA_OBSERVER,
      undefined,
      t0
    );
    expect(osFirst?.headingValid).toBe(false);
    expect(osFirst?.headingDeg).toBe(0);

    const osNorth = greatCircleDestination(38.85, -77.04, 0, 0.3);
    const osSecond = normalizeOpenSkyState(
      ['a66666', 'OSK1', 'US', Math.floor(t0 / 1000) + 5, Math.floor(t0 / 1000) + 5, osNorth.lon, osNorth.lat, 5000, false, 150, null],
      DCA_OBSERVER,
      osFirst ?? undefined,
      t0 + 5000
    );
    expect(osSecond?.headingValid).toBe(true);
    expect(osSecond?.headingDeg).toBeCloseTo(0, 0);
  });

  it('normalizes OpenSky state tuples and drops malformed, Null Island, and corrupt rows safely', () => {
    const milTuple = [
      'ae4567',
      'RCH312 ',
      'United States',
      1760000000,
      1760000005,
      -77.12,
      38.95,
      7315.2,
      false,
      235.5,
      280,
      -3.2,
      null,
      7400.0,
      '4411',
      false,
      0,
    ];
    const entity = normalizeOpenSkyState(milTuple, DCA_OBSERVER);
    expect(entity).not.toBeNull();
    expect(entity?.category).toBe('military');
    expect(entity?.isMilitary).toBe(true);
    expect(entity?.callsign).toBe('RCH312');
    expect(entity?.altM).toBe(7400);
    expect(entity?.altBaroM).toBe(7315.2);
    expect(entity?.speedMs).toBe(235.5);
    expect(entity?.headingValid).toBe(true);
    expect(entity?.topocentric.groundDistKm).toBeGreaterThan(5);

    // Null lat/lon, Null Island, corrupt speed/alt, or short tuple returns null
    expect(
      normalizeOpenSkyState(['a11111', 'UAL1', 'US', null, 1, null, 38.9, 1000, false, 100, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeOpenSkyState(['a11111', 'NULLIS', 'US', null, 1, 0, 0, 1000, false, 100, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeOpenSkyState(['a11111', 'NEGV', 'US', null, 1, -77.1, 38.9, 1000, false, -5, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeOpenSkyState(['a11111', 'FAST', 'US', null, 1, -77.1, 38.9, 1000, false, 1500, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeOpenSkyState(['a11111', 'LOWALT', 'US', null, 1, -77.1, 38.9, -600, false, 100, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(
      normalizeOpenSkyState(['a11111', 'HIALT', 'US', null, 1, -77.1, 38.9, 65000, false, 100, 90], DCA_OBSERVER)
    ).toBeNull();
    expect(normalizeOpenSkyState(['a11111', 'BAD'], DCA_OBSERVER)).toBeNull();
  });

  it('uses localhost Vite proxies in order, enforces 10s rate-limit cache, and returns 0 phantom planes when all APIs fail', async () => {
    const calledUrls: string[] = [];
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calledUrls.push(url);
        if (url.startsWith('/api-proxy/adsb-lol/')) {
          return new Response(
            JSON.stringify({
              ac: [{ hex: 'a11111', flight: 'AAL100', lat: 38.86, lon: -77.05, alt_baro: 9000, gs: 280, track: 90 }],
            }),
            { status: 200 }
          );
        }
        return new Response('err', { status: 500 });
      })
    );

    const liveProxyRes = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(liveProxyRes.status).toBe('live');
    expect(liveProxyRes.provider).toBe('vite-proxy:adsb.lol');
    expect(liveProxyRes.entities).toHaveLength(1);
    expect(calledUrls[0]).toContain('/api-proxy/adsb-fi/');
    expect(calledUrls[1]).toContain('/api-proxy/adsb-lol/');

    // Immediate second call hits 10s rate-limit cache without invoking fetch again
    const callsBeforeCache = calledUrls.length;
    const cachedRes = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(cachedRes.status).toBe('cached');
    expect(cachedRes.entities).toHaveLength(1);
    expect(calledUrls.length).toBe(callsBeforeCache);

    // Test codetabs relay with valid ac[] schema
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.codetabs.com')) {
          return new Response(
            JSON.stringify({
              ac: [{ hex: 'a77777', flight: 'JAL12', lat: 35.58, lon: 139.8, alt_baro: 12000, gs: 320, track: 45 }],
            }),
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );
    const relayRes = await fetchFlightsCascade(TOKYO_OBSERVER, 130, undefined, { force: true });
    expect(relayRes.status).toBe('live');
    expect(relayRes.provider).toBe('codetabs-relay:adsb.lol');

    // Test codetabs schema rejection -> ZERO phantom flights, honest error status, never fetches fallback-flights.json
    const rejectedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.codetabs.com')) {
        return new Response(JSON.stringify({ Error: 'Proxy limit reached' }), { status: 200 });
      }
      return new Response('Service Unavailable', { status: 503 });
    });
    vi.stubGlobal('fetch', rejectedFetch);

    const errRes = await fetchFlightsCascade(TOKYO_OBSERVER, 130, undefined, { force: true });
    expect(errRes.status).toBe('error');
    expect(errRes.entities).toEqual([]);
    expect(errRes.httpStatus).toBe(503);
    expect(errRes.timestampMs).toBe(relayRes.timestampMs);
    expect(
      rejectedFetch.mock.calls.some((c) => String(c[0]).includes('fallback-flights.json'))
    ).toBe(false);
  });

  it('returns 0 phantom planes and honest statuses across 503, 429, TypeError, corrupt JSON, offline, and fresh prevMap delayed fallback', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });

    const failureScenarios: Array<{
      name: string;
      handler: () => Promise<Response>;
      expectedStatus: 'error' | 'rate-limited' | 'offline';
      expectedHttpStatus?: number;
      offline?: boolean;
    }> = [
      {
        name: 'HTTP 503',
        handler: async () => new Response('Unavailable', { status: 503 }),
        expectedStatus: 'error',
        expectedHttpStatus: 503,
      },
      {
        name: 'HTTP 429',
        handler: async () => new Response('Too Many Requests', { status: 429 }),
        expectedStatus: 'rate-limited',
        expectedHttpStatus: 429,
      },
      {
        name: 'TypeError network failure',
        handler: async () => {
          throw new TypeError('Failed to fetch');
        },
        expectedStatus: 'error',
      },
      {
        name: 'Corrupt truncated JSON',
        handler: async () => new Response('{"ac":[{"hex":"a12', { status: 200 }),
        expectedStatus: 'error',
      },
      {
        name: 'Navigator offline',
        handler: async () => {
          throw new TypeError('Failed to fetch');
        },
        expectedStatus: 'offline',
        offline: true,
      },
    ];

    for (const scenario of failureScenarios) {
      clearFlightsServiceCache();
      vi.stubGlobal('navigator', { onLine: !scenario.offline });
      const fetchMock = vi.fn(scenario.handler);
      vi.stubGlobal('fetch', fetchMock);

      // Non-forced initial call fails -> returns empty [] and caches failure status under rateKey
      const first = await fetchFlightsCascade(DCA_OBSERVER, 120);
      expect(first.entities, `${scenario.name} entities`).toEqual([]);
      expect(first.status, `${scenario.name} status`).toBe(scenario.expectedStatus);
      expect(first.timestampMs, `${scenario.name} timestampMs`).toBe(0);
      if (scenario.expectedHttpStatus !== undefined) {
        expect(first.httpStatus, `${scenario.name} httpStatus`).toBe(scenario.expectedHttpStatus);
      }

      // Immediate second non-forced call within 10s must hit cooldown even when entities is []
      const callsAfterFirst = fetchMock.mock.calls.length;
      const second = await fetchFlightsCascade(DCA_OBSERVER, 120);
      expect(fetchMock.mock.calls.length, `${scenario.name} bypassed limiter`).toBe(callsAfterFirst);
      expect(second.status, `${scenario.name} cooldown status`).toBe(scenario.expectedStatus);
      expect(second.entities).toEqual([]);
    }

    // Verified fresh prevMap aircraft (<= 45s) preserved with 'delayed' / 'rate-limited'; stale/ground/sim/out-of-range excluded
    clearFlightsServiceCache();
    vi.stubGlobal('navigator', { onLine: true });
    const nowMs = Date.now();
    const freshLive = normalizeAdsbxAircraft(
      { hex: 'a10101', flight: 'FRESH1', lat: 38.86, lon: -77.05, alt_baro: 8000, gs: 250, track: 90, seen_pos: 10 },
      DCA_OBSERVER,
      undefined,
      nowMs
    )!;
    const stalePrev = normalizeAdsbxAircraft(
      { hex: 'a10102', flight: 'OLD1', lat: 38.86, lon: -77.05, alt_baro: 8000, gs: 250, track: 90, seen_pos: 50 },
      DCA_OBSERVER,
      undefined,
      nowMs
    )!;
    const simulatedPrev: FlightEntity = { ...freshLive, id: 'flight:sim', isSimulated: true };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    );
    const delayedRes = await fetchFlightsCascade(
      DCA_OBSERVER,
      120,
      [freshLive, stalePrev, simulatedPrev]
    );
    expect(delayedRes.status).toBe('delayed');
    expect(delayedRes.entities.map((e) => e.id)).toEqual([freshLive.id]);
    expect(delayedRes.timestampMs).toBe(freshLive.timestampMs);

    // Cooldown preserves 'delayed'
    const delayedCooldown = await fetchFlightsCascade(DCA_OBSERVER, 120, delayedRes.entities);
    expect(delayedCooldown.status).toBe('delayed');
    expect(delayedCooldown.entities).toHaveLength(1);

    // 429 with fresh prevMap returns 'rate-limited' with those fresh entities
    clearFlightsServiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Rate limited', { status: 429 }))
    );
    const rateLimitedDelayed = await fetchFlightsCascade(DCA_OBSERVER, 120, [freshLive]);
    expect(rateLimitedDelayed.status).toBe('rate-limited');
    expect(rateLimitedDelayed.httpStatus).toBe(429);
    expect(rateLimitedDelayed.entities).toHaveLength(1);
  });

  it('purges onGround, seen_pos > 60s, Null Island, and out-of-range aircraft from fetchFlightsCascade', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const farEast = greatCircleDestination(DCA_OBSERVER.lat, DCA_OBSERVER.lon, 90, 125);
    const insideEdge = greatCircleDestination(DCA_OBSERVER.lat, DCA_OBSERVER.lon, 90, 118);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.adsb.lol/')) {
        return new Response(
          JSON.stringify({
            ac: [
              { hex: 'a10001', flight: 'GROUND1', lat: 38.86, lon: -77.05, alt_baro: 'ground', gs: 10, track: 90, seen_pos: 2 },
              { hex: 'a10002', flight: 'STALE61', lat: 38.86, lon: -77.05, alt_baro: 5000, gs: 200, track: 90, seen_pos: 61 },
              { hex: 'a10003', flight: 'NULLISL', lat: 0, lon: 0, alt_baro: 5000, gs: 200, track: 90, seen_pos: 2 },
              { hex: 'a10004', flight: 'OUT125', lat: farEast.lat, lon: farEast.lon, alt_baro: 12000, gs: 300, track: 90, seen_pos: 2 },
              { hex: 'a10005', flight: 'VALID1', lat: insideEdge.lat, lon: insideEdge.lon, alt_baro: 12000, gs: 300, track: 90, seen_pos: 5 },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('err', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(res.status).toBe('live');
    expect(res.entities.map((e) => e.callsign)).toEqual(['VALID1']);
    // Upstream radiusNm uses Math.ceil(120 / 1.852) = 65 NM
    expect(String(fetchMock.mock.calls[0][0])).toContain('/65');
  });

  it('treats valid empty { ac: [] } or OpenSky { states: [] } as authoritative live without calling downstream providers', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const adsbEmptySpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.adsb.lol/')) {
        return new Response(JSON.stringify({ ac: [] }), { status: 200 });
      }
      throw new Error(`Unexpected downstream call to ${url}`);
    });
    vi.stubGlobal('fetch', adsbEmptySpy);

    const emptyLive = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(emptyLive.status).toBe('live');
    expect(emptyLive.provider).toBe('adsb.lol');
    expect(emptyLive.entities).toEqual([]);
    expect(adsbEmptySpy).toHaveBeenCalledTimes(1);

    // Non-forced call within 10s after empty live response must still respect cooldown
    const emptyCooldown = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(emptyCooldown.status).toBe('cached');
    expect(emptyCooldown.entities).toEqual([]);
    expect(adsbEmptySpy).toHaveBeenCalledTimes(1);

    // OpenSky antimeridian split: splits across +-180 instead of querying lomin=-180&lomax=180
    clearFlightsServiceCache();
    const antimeridianObs: ObserverLocation = {
      lat: 0,
      lon: 179.95,
      altM: 0,
      label: 'Fiji',
      source: 'manual',
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const openSkyCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        openSkyCalls.push(url);
        if (url.startsWith('https://opensky-network.org/')) {
          expect(url).not.toContain('lomin=-180.0000&lamax=1.0780&lomax=180.0000');
          if (url.includes('lomax=180.0000')) {
            return new Response(
              JSON.stringify({
                states: [['a90001', 'AMW1', 'FJ', nowSec, nowSec, 179.8, 0.1, 10000, false, 240, 90]],
              }),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify({ states: [] }), { status: 200 });
        }
        return new Response('Down', { status: 503 });
      })
    );
    const amRes = await fetchFlightsCascade(antimeridianObs, 120, undefined, { force: true });
    expect(amRes.status).toBe('live');
    expect(amRes.provider).toBe('opensky-network');
    expect(amRes.entities).toHaveLength(1);
    const osUrls = openSkyCalls.filter((u) => u.startsWith('https://opensky-network.org/'));
    expect(osUrls).toHaveLength(2);
    expect(osUrls.some((u) => u.includes('lomax=180.0000') && !u.includes('lomin=-180.0000'))).toBe(true);
    expect(osUrls.some((u) => u.includes('lomin=-180.0000') && !u.includes('lomax=180.0000'))).toBe(true);

    // OpenSky empty states: [] returns live immediately without calling codetabs relay
    clearFlightsServiceCache();
    const osEmptySpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://opensky-network.org/')) {
        return new Response(JSON.stringify({ states: [] }), { status: 200 });
      }
      if (url.includes('api.codetabs.com')) {
        throw new Error('Should not invoke codetabs after empty OpenSky live response');
      }
      return new Response('Down', { status: 503 });
    });
    vi.stubGlobal('fetch', osEmptySpy);
    const osEmpty = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(osEmpty.status).toBe('live');
    expect(osEmpty.provider).toBe('opensky-network');
    expect(osEmpty.entities).toEqual([]);
  });

  it('enforces proxy & direct cascade order, OpenSky stale/ground filtering, polar guard, and data.Error rejection', async () => {
    // Localhost proxy order: adsb.fi -> adsb.lol -> airplanes.live
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const proxyUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        proxyUrls.push(url);
        if (url.startsWith('/api-proxy/adsb-fi/')) {
          return new Response(JSON.stringify({ Error: 'upstream limit', ac: [] }), { status: 200 });
        }
        if (url.startsWith('/api-proxy/airplanes-live/')) {
          return new Response(
            JSON.stringify({
              ac: [{ hex: 'a12121', flight: 'ALV1', lat: 38.86, lon: -77.05, alt_baro: 7000, gs: 210, track: 180 }],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const proxyOrderRes = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(proxyOrderRes.status).toBe('live');
    expect(proxyOrderRes.provider).toBe('vite-proxy:airplanes.live');
    expect(proxyUrls[0]).toContain('/api-proxy/adsb-fi/');
    expect(proxyUrls[1]).toContain('/api-proxy/adsb-lol/');
    expect(proxyUrls[2]).toContain('/api-proxy/airplanes-live/');

    // Direct cascade order: adsb.lol -> airplanes.live -> opensky-network (filters ground/stale) -> codetabs
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const directUrls: string[] = [];
    const nowSec = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        directUrls.push(url);
        if (url.startsWith('https://opensky-network.org/')) {
          return new Response(
            JSON.stringify({
              states: [
                ['a20001', 'GND1', 'US', nowSec, nowSec, -77.05, 38.86, 10, true, 5, 90],
                ['a20002', 'OLD1', 'US', nowSec - 90, nowSec - 90, -77.05, 38.86, 5000, false, 200, 90],
                ['a20003', 'AIR1', 'US', nowSec - 5, nowSec - 5, -77.05, 38.86, 5000, false, 200, 90],
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const osFiltered = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(osFiltered.status).toBe('live');
    expect(osFiltered.provider).toBe('opensky-network');
    expect(osFiltered.entities.map((e) => e.callsign)).toEqual(['AIR1']);
    expect(directUrls[0]).toContain('https://api.adsb.lol/');
    expect(directUrls[1]).toContain('https://api.airplanes.live/');
    expect(directUrls[2]).toContain('https://opensky-network.org/');

    // Polar observer skips OpenSky without issuing a 360° global request
    clearFlightsServiceCache();
    const polarObs: ObserverLocation = { lat: 89.5, lon: 0, altM: 0, label: 'North Pole', source: 'manual' };
    const polarUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        polarUrls.push(String(input));
        return new Response('Down', { status: 503 });
      })
    );
    const polarRes = await fetchFlightsCascade(polarObs, 120);
    expect(polarRes.status).toBe('error');
    expect(polarRes.entities).toEqual([]);
    expect(polarUrls.some((u) => u.includes('opensky-network.org'))).toBe(false);
  });
});

describe('satellitesService TLE parsing & 2-hour IndexedDB TTL', () => {
  beforeEach(() => {
    clearTleCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses 3-line, 2-line, Space-Track 0-prefixed, and Alpha-5 TLE sets while skipping bad pairs', () => {
    const twoLineIss = SAMPLE_ISS_TLE.split('\n').slice(1).join('\n');
    const alpha5 = [
      'STARLINK-99999',
      '1 T0123U 24001A   26324.50000000  .00010000  00000-0  50000-4 0  9990',
      '2 T0123  53.2100 100.0000 0001500  80.0000 280.0000 15.06400000000012',
    ].join('\n');
    const mismatched = [
      'BROKEN SAT',
      '1 12345U 99001A   26324.50000000  .00000000  00000-0  00000-0 0  9991',
      '2 54321  51.6000 100.0000 0001000  10.0000  20.0000 15.50000000000010',
    ].join('\n');

    const parsedStations = parseTleText(
      `${SAMPLE_ISS_TLE}\r\n${SAMPLE_NOAA_TLE}\n${mismatched}\nGARBAGE LINE`,
      'stations'
    );
    expect(parsedStations).toHaveLength(2);
    expect(parsedStations[0]).toMatchObject({ name: 'ISS (ZARYA)', noradId: 25544, group: 'stations' });
    expect(parsedStations[1]).toMatchObject({ name: 'NOAA 19', noradId: 33591, group: 'stations' });

    const parsedTwoLine = parseTleText(twoLineIss, 'visual');
    expect(parsedTwoLine).toHaveLength(1);
    expect(parsedTwoLine[0].name).toBe('SAT-25544');
    expect(parsedTwoLine[0].noradId).toBe(25544);

    const parsedAlpha5 = parseTleText(alpha5, 'starlink');
    expect(parsedAlpha5).toHaveLength(1);
    expect(parsedAlpha5[0].noradId).toBe(270123);
  });

  it('loads cold-start static TLEs with deduplication and enforces 2-hour cache TTL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/tle/stations.tle')) return new Response(SAMPLE_ISS_TLE, { status: 200 });
        if (url.includes('/tle/visual.tle')) return new Response(`${SAMPLE_ISS_TLE}\n${SAMPLE_NOAA_TLE}`, { status: 200 });
        if (url.includes('/tle/starlink.tle')) return new Response('', { status: 200 });
        return new Response('', { status: 404 });
      })
    );
    const coldTles = await loadInitialTles();
    expect(coldTles).toHaveLength(2);
    expect(coldTles.find((r) => r.noradId === 25544)?.group).toBe('stations');

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('GROUP=stations')) return new Response(SAMPLE_ISS_TLE, { status: 200 });
      if (url.includes('GROUP=visual')) return new Response(SAMPLE_NOAA_TLE, { status: 200 });
      if (url.includes('GROUP=starlink')) return new Response('', { status: 200 });
      return new Response('', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const t0 = 1_700_000_000_000;
    const first = await refreshTlesIfStale(false, { nowMs: t0 });
    expect(first.status).toBe('live');
    expect(first.fromNetwork).toBe(true);
    expect(first.records).toHaveLength(2);
    const initialCalls = fetchMock.mock.calls.length;

    // 1h 59m later -> still cached, zero network calls
    const cached = await refreshTlesIfStale(false, { nowMs: t0 + 7_140_000 });
    expect(cached.status).toBe('cached');
    expect(cached.fromNetwork).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(initialCalls);

    // Force refresh -> hits network
    const forced = await refreshTlesIfStale(true, { nowMs: t0 + 7_140_000 });
    expect(forced.status).toBe('live');
    expect(forced.fromNetwork).toBe(true);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);

    // Offline after TTL expiry -> falls back cleanly to stale cache without throwing
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network offline')));
    const offlineStale = await refreshTlesIfStale(false, { nowMs: t0 + 15_000_000 });
    expect(offlineStale.status).toBe('cached');
    expect(offlineStale.records).toHaveLength(2);
  });
});

describe('balloonsService SondeHub parsing & nearestSondeHint', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('classifies burstState, merges /sondes + /amateur, and computes nearestSondeHint when 0 local', async () => {
    const asc = normalizeSondeRecord(
      { serial: 'R100', lat: 38.86, lon: -77.05, alt: 5200, vel_v: 5.4, vel_h: 18, type: 'RS41' },
      DCA_OBSERVER
    );
    const desc = normalizeSondeRecord(
      { serial: 'R101', lat: 38.86, lon: -77.05, alt: 9000, vel_v: -9.8, vel_h: 22 },
      DCA_OBSERVER
    );
    const floater = normalizeSondeRecord(
      { serial: 'HAB1', lat: 38.86, lon: -77.05, alt: 14000, vspeed: 0.2, hspeed: 14 },
      DCA_OBSERVER,
      { isAmateur: true }
    );
    expect(asc?.burstState).toBe('ascending');
    expect(desc?.burstState).toBe('descending');
    expect(floater?.burstState).toBe('float');

    // Live local balloons from both endpoints
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/sondes')) {
          return new Response(
            JSON.stringify([
              {
                serial: 'R4100999',
                lat: 38.9,
                lon: -77.01,
                alt: 12400,
                vel_v: 5.1,
                vel_h: 16.5,
                subtype: 'RS41-SGP',
                temp: -42.3,
              },
            ]),
            { status: 200 }
          );
        }
        if (url.includes('/amateur')) {
          return new Response(
            JSON.stringify({
              'W3HAB-11': {
                payload_callsign: 'W3HAB-11',
                lat: 38.82,
                lon: -77.12,
                alt: 18500,
                vspeed: -6.5,
                hspeed: 24.0,
              },
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 404 });
      })
    );
    const liveRes = await fetchBalloons(DCA_OBSERVER, 120);
    expect(liveRes.status).toBe('live');
    expect(liveRes.entities).toHaveLength(2);
    expect(liveRes.nearestSondeHint).toBeNull();

    // 0 balloons inside radiusKm -> widened hint
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('distance=1000000')) {
          return new Response(
            JSON.stringify([
              {
                serial: 'S9991234',
                lat: 40.4,
                lon: -76.9,
                alt: 18200,
                vel_v: 4.9,
                vel_h: 25,
                type: 'RS41',
              },
            ]),
            { status: 200 }
          );
        }
        if (url.includes('/sondes')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (url.includes('/amateur')) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      })
    );

    const hintRes = await fetchBalloons(DCA_OBSERVER, 120);
    expect(hintRes.status).toBe('live');
    expect(hintRes.entities).toHaveLength(0);
    expect(hintRes.nearestSondeHint).toContain('S9991234');
    expect(hintRes.nearestSondeHint).toContain('km');
  });

  it('resets balloon trail when time gap > 300s or spatial jump > 30km', () => {
    const t0 = 1_760_000_000_000;
    const b1 = normalizeSondeRecord(
      { serial: 'R200', lat: 38.86, lon: -77.05, alt: 5000, datetime: new Date(t0).toISOString() },
      DCA_OBSERVER
    )!;
    const b2 = normalizeSondeRecord(
      { serial: 'R200', lat: 38.87, lon: -77.04, alt: 5500, datetime: new Date(t0 + 60_000).toISOString() },
      DCA_OBSERVER,
      { prev: b1 }
    )!;
    expect(b2.trail).toHaveLength(2);

    const bStale = normalizeSondeRecord(
      { serial: 'R200', lat: 38.871, lon: -77.039, alt: 5600, datetime: new Date(t0 + 370_000).toISOString() },
      DCA_OBSERVER,
      { prev: b2 }
    )!;
    expect(bStale.trail).toHaveLength(1);

    const jumped = greatCircleDestination(38.87, -77.04, 90, 35);
    const bJump = normalizeSondeRecord(
      { serial: 'R200', lat: jumped.lat, lon: jumped.lon, alt: 5700, datetime: new Date(t0 + 70_000).toISOString() },
      DCA_OBSERVER,
      { prev: b2 }
    )!;
    expect(bJump.trail).toHaveLength(1);
  });
});

describe('airspaceService & openDroneIdService compliance', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('detects US territorial coverage accurately', () => {
    expect(isInsideContinentalUsOrTerritories(38.8512, -77.0402)).toBe(true); // DCA
    expect(isInsideContinentalUsOrTerritories(34.0522, -118.2437)).toBe(true); // LAX
    expect(isInsideContinentalUsOrTerritories(61.1743, -149.9981)).toBe(true); // Anchorage
    expect(isInsideContinentalUsOrTerritories(21.3069, -157.8583)).toBe(true); // Honolulu
    expect(isInsideContinentalUsOrTerritories(18.4655, -66.1057)).toBe(true); // San Juan
    expect(isInsideContinentalUsOrTerritories(51.47, -0.4543)).toBe(false); // London
    expect(isInsideContinentalUsOrTerritories(35.5494, 139.7798)).toBe(false); // Tokyo
  });

  it('evaluates drone UASFM ceilings, overlapping grids, 0ft grids, and TFR/P-56 breaches', () => {
    const compliant = evaluateDroneAirspaceCompliance(38.865, -77.07, 150 * 0.3048, SAMPLE_AIRSPACE);
    expect(compliant).toEqual({ faaCeilingFt: 200, ceilingBreach: false, tfrBreach: false });

    const breaching = evaluateDroneAirspaceCompliance(38.865, -77.07, 480 * 0.3048, SAMPLE_AIRSPACE);
    expect(breaching).toEqual({ faaCeilingFt: 200, ceilingBreach: true, tfrBreach: false });

    const zeroGrid = evaluateDroneAirspaceCompliance(38.85, -77.04, 15, SAMPLE_AIRSPACE);
    expect(zeroGrid).toEqual({ faaCeilingFt: 0, ceilingBreach: true, tfrBreach: false });

    const p56 = evaluateDroneAirspaceCompliance(38.9, -77.03, 50, SAMPLE_AIRSPACE);
    expect(p56.tfrBreach).toBe(true);

    const open = evaluateDroneAirspaceCompliance(39.1, -77.5, 100, SAMPLE_AIRSPACE);
    expect(open).toEqual({ faaCeilingFt: null, ceilingBreach: false, tfrBreach: false });
  });

  it('caps UASFM ArcGIS query envelope to ±0.35°, skips outside US, and falls back to seeded GeoJSON', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const tokyoAirspace = await fetchAirspace(TOKYO_OBSERVER, 130);
    expect(tokyoAirspace.airspace.usCoverage).toBe(false);
    expect(tokyoAirspace.airspace.uasfm.features).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // Verify FAA ArcGIS query parameters & envelope <= ±0.35° even when radiusKm is 200
    const arcgisSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('FAA_UAS_FacilityMap_Data')) {
        return new Response(JSON.stringify(SAMPLE_AIRSPACE.uasfm), { status: 200 });
      }
      if (url.includes('Boundary_Airspace')) {
        return new Response(JSON.stringify(SAMPLE_AIRSPACE.sua), { status: 200 });
      }
      return new Response(
        JSON.stringify({ type: 'FeatureCollection', features: [] }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', arcgisSpy);

    const liveUs = await fetchAirspace(DCA_OBSERVER, 200);
    expect(liveUs.status).toBe('live');
    expect(liveUs.airspace.uasfm.features).toHaveLength(3);
    const uasfmUrl = String(
      arcgisSpy.mock.calls.find((c) => String(c[0]).includes('FAA_UAS_FacilityMap_Data'))?.[0] ?? ''
    );
    const parsedUasfmUrl = new URL(uasfmUrl);
    const whereClause = parsedUasfmUrl.searchParams.get('where') ?? '';
    const latMatch = whereClause.match(/LATITUDE BETWEEN ([-\d.]+) AND ([-\d.]+)/);
    expect(latMatch).not.toBeNull();
    if (latMatch) {
      const span = Number.parseFloat(latMatch[2]) - Number.parseFloat(latMatch[1]);
      expect(span).toBeLessThanOrEqual(0.7001); // ±0.35° max
    }
    expect(parsedUasfmUrl.searchParams.get('resultRecordCount')).toBe('1000');

    // Fall back to ./data/fallback-airspace.geojson when US fetches fail
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('fallback-airspace.geojson')) {
          return new Response(
            JSON.stringify({ uasfm: SAMPLE_AIRSPACE.uasfm, sua: SAMPLE_AIRSPACE.sua }),
            { status: 200 }
          );
        }
        return new Response('ArcGIS Down', { status: 500 });
      })
    );

    const dcFallback = await fetchAirspace(DCA_OBSERVER, 120);
    expect(dcFallback.status).toBe('fallback');
    expect(dcFallback.airspace.usCoverage).toBe(true);
    expect(dcFallback.airspace.uasfm.features.length).toBeGreaterThan(0);
  });

  it('steps 4 simulated ASTM F3411 drones, normalizes ODID JSON, and runs OpenDroneIdClient HTTP polling', async () => {
    const drones = stepSimulatedDrones(DCA_OBSERVER, 120, 12, SAMPLE_AIRSPACE);
    expect(drones).toHaveLength(4);
    for (const d of drones) {
      expect(d.isSimulated).toBe(true);
      expect(Number.isFinite(d.operatorLat)).toBe(true);
      expect(Number.isFinite(d.operatorLon)).toBe(true);
      expect(d.operatorDistM).toBeGreaterThan(0);
    }

    const breacher = drones.find((d) => d.callsign === 'UAS-BREACH-480');
    expect(breacher).toBeDefined();
    expect(Math.round((breacher?.altAglM ?? 0) / 0.3048)).toBe(480);
    expect(breacher?.ceilingBreach).toBe(true);
    expect(breacher?.emergencyFlag).toBe('UASFM BREACH');

    const parsedLive = normalizeOdidPayload(
      {
        drones: [
          {
            BasicID: { UASID: 'LIVE-UAS-99', UAType: 'vtol' },
            Location: {
              Latitude: 38.865,
              Longitude: -77.07,
              Height: 146.3, // ~480 ft AGL inside 200 ft cell
              SpeedHorizontal: 18,
              Direction: 90,
            },
            System: { OperatorLatitude: 38.863, OperatorLongitude: -77.071 },
          },
          {
            uasId: 'INVALID-SENTINEL',
            lat: 0,
            lon: 0,
          },
        ],
      },
      DCA_OBSERVER,
      SAMPLE_AIRSPACE
    );
    expect(parsedLive).toHaveLength(1);
    expect(parsedLive[0].uasId).toBe('LIVE-UAS-99');
    expect(parsedLive[0].uaType).toBe('vtol');
    expect(parsedLive[0].ceilingBreach).toBe(true);
    expect(parsedLive[0].isSimulated).toBe(false);

    // OpenDroneIdClient rejects unsafe protocols and polls HTTP cleanly
    const statuses: Array<{ transport: string; connected: boolean; lastError?: string }> = [];
    const received: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([{ uasId: 'HTTP-DRONE-1', lat: 38.865, lon: -77.07, altAglM: 50 }]),
          { status: 200 }
        )
      )
    );

    const client = new OpenDroneIdClient(DCA_OBSERVER, SAMPLE_AIRSPACE, {
      onDrones: (items) => received.push(items.length),
      onStatus: (s) => statuses.push(s),
    });

    client.connect('ftp://invalid.local/stream');
    expect(statuses[statuses.length - 1].connected).toBe(false);
    expect(statuses[statuses.length - 1].lastError).toContain('Unsupported protocol');

    client.connect('http://127.0.0.1:8088/odid.json', 5000);
    await vi.waitFor(() => {
      expect(received).toEqual([1]);
    });
    expect(statuses[statuses.length - 1]).toMatchObject({ transport: 'http', connected: true });
    client.disconnect();
  });

  it('resets drone trail when time gap > 60s or spatial jump > 30km', () => {
    vi.useFakeTimers();
    const t0 = 1_760_000_000_000;
    vi.setSystemTime(t0);

    const d1 = normalizeOdidPayload(
      [{ uasId: 'DRONE-TRL', lat: 38.86, lon: -77.05, altAglM: 60 }],
      DCA_OBSERVER,
      SAMPLE_AIRSPACE
    );
    expect(d1[0].trail).toHaveLength(1);

    vi.setSystemTime(t0 + 5_000);
    const d2 = normalizeOdidPayload(
      [{ uasId: 'DRONE-TRL', lat: 38.861, lon: -77.049, altAglM: 62 }],
      DCA_OBSERVER,
      SAMPLE_AIRSPACE,
      d1
    );
    expect(d2[0].trail).toHaveLength(2);

    // > 60s gap resets trail
    vi.setSystemTime(t0 + 70_000);
    const dStale = normalizeOdidPayload(
      [{ uasId: 'DRONE-TRL', lat: 38.862, lon: -77.048, altAglM: 64 }],
      DCA_OBSERVER,
      SAMPLE_AIRSPACE,
      d2
    );
    expect(dStale[0].trail).toHaveLength(1);

    // > 30km jump resets trail
    vi.setSystemTime(t0 + 10_000);
    const jumped = greatCircleDestination(38.861, -77.049, 90, 35);
    const dJump = normalizeOdidPayload(
      [{ uasId: 'DRONE-TRL', lat: jumped.lat, lon: jumped.lon, altAglM: 64 }],
      DCA_OBSERVER,
      SAMPLE_AIRSPACE,
      d2
    );
    expect(dJump[0].trail).toHaveLength(1);
  });
});

describe('geocodingService coordinate parsing & multi-provider search', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('parses decimal, N/S/E/W hemisphere, and DMS coordinate formats cleanly', () => {
    const p1 = parseDirectCoordinates('38.85, -77.04');
    expect(p1).toMatchObject({ lat: 38.85, lon: -77.04 });

    const p2 = parseDirectCoordinates('34.9054N 117.8839W');
    expect(p2?.lat).toBeCloseTo(34.9054, 4);
    expect(p2?.lon).toBeCloseTo(-117.8839, 4);

    const p3 = parseDirectCoordinates('34.9054° N, 117.8839° W');
    expect(p3?.lat).toBeCloseTo(34.9054, 4);
    expect(p3?.lon).toBeCloseTo(-117.8839, 4);

    const p4 = parseDirectCoordinates('N34.9054 W117.8839');
    expect(p4?.lat).toBeCloseTo(34.9054, 4);
    expect(p4?.lon).toBeCloseTo(-117.8839, 4);

    const p5 = parseDirectCoordinates(`38°51'04"N 77°02'25"W`);
    expect(p5?.lat).toBeCloseTo(38.8511, 3);
    expect(p5?.lon).toBeCloseTo(-77.0403, 3);

    expect(parseDirectCoordinates('95.0, -77.04')).toBeNull();
    expect(parseDirectCoordinates('Edwards Air Force Base')).toBeNull();
  });

  it('falls back cleanly from Open-Meteo to Nominatim and never throws offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('geocoding-api.open-meteo.com')) {
          return new Response(JSON.stringify({ results: [] }), { status: 200 });
        }
        if (url.includes('nominatim.openstreetmap.org')) {
          return new Response(
            JSON.stringify([
              {
                name: 'Edwards Air Force Base',
                display_name: 'Edwards Air Force Base, Kern County, California, United States',
                lat: '34.9054',
                lon: '-117.8839',
              },
            ]),
            { status: 200 }
          );
        }
        return new Response('error', { status: 500 });
      })
    );

    const results = await searchLocation('Edwards AFB');
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('nominatim');
    expect(results[0].lat).toBeCloseTo(34.9054, 4);

    // Direct coords shortcut requires zero fetch
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const directRes = await searchLocation('28.5729, -80.6490');
    expect(directRes).toHaveLength(1);
    expect(directRes[0].source).toBe('coords');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Total outage returns [] safely
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(searchLocation('Cape Canaveral')).resolves.toEqual([]);
  });
});
