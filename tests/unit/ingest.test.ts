import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AirspaceData,
  BalloonEntity,
  FlightEntity,
  ObserverLocation,
} from '../../src/types/sky-contracts';
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
  extractRelayedJsonValue,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
} from '../../src/services/httpClient';
import {
  adsbRateLimiter,
  classifyMilitary,
  clearFlightsServiceCache,
  extractRelayedJsonPayload,
  fetchFlightsCascade,
  fetchGlobalSpecialFlights,
  flightsCircuitBreaker,
  globalAdsbRateLimiter,
  globalFlightsCircuitBreaker,
  isLocalDevOrLanRuntime,
  normalizeAdsbxAircraft,
  normalizeOpenSkyState,
} from '../../src/services/flightsService';
import {
  clearTleCache,
  loadInitialTles,
  parseTleText,
  refreshTlesIfStale,
} from '../../src/services/satellitesService';
import {
  WINDBORNE_DB_NAME,
  WINDBORNE_TTL_MS,
  balloonsCircuitBreaker,
  clearBalloonsCache,
  fetchBalloons,
  normalizeSondeRecord,
  parseWindBorneConstellation,
  windborneCircuitBreaker,
} from '../../src/services/balloonsService';
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
    expect(breaker.getLastError('adsb.lol')).toBeInstanceOf(Error);
    expect((breaker.getLastError('adsb.lol') as Error).message).toBe('upstream 503');

    await expect(
      breaker.execute(async () => 'ok', 'adsb.lol')
    ).rejects.toBeInstanceOf(CircuitOpenError);

    now += 30_001;
    expect(breaker.getState('adsb.lol')).toBe('half-open');
    const result = await breaker.execute(async () => 'recovered', 'adsb.lol');
    expect(result).toBe('recovered');
    expect(breaker.getState('adsb.lol')).toBe('closed');
    expect(breaker.getLastError('adsb.lol')).toBeUndefined();

    // Backward-compatible recordFailure without error preserves existing lastError
    const err429 = new HttpError(429, 'https://example.test/api', 'HTTP 429');
    breaker.recordFailure('legacy', err429);
    breaker.recordFailure('legacy');
    expect(breaker.getLastError('legacy')).toBe(err429);
    breaker.recordSuccess('legacy');
    expect(breaker.getLastError('legacy')).toBeUndefined();
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

    // Test Stage 2 CORS simple-GET relay (r.jina.ai -> adsb.lol) with Jina Markdown Content wrapper
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/https://api.adsb.lol/')) {
          return new Response(
            `Title: \n\nURL Source: ${url}\n\nMarkdown Content:\n${JSON.stringify({
              ac: [{ hex: 'a77777', flight: 'JAL12', lat: 35.58, lon: 139.8, alt_baro: 12000, gs: 320, track: 45 }],
            })}`,
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );
    const relayRes = await fetchFlightsCascade(TOKYO_OBSERVER, 130, undefined, { force: true });
    expect(relayRes.status).toBe('live');
    expect(relayRes.provider).toBe('cors-relay:adsb.lol');

    // Test relay schema rejection -> ZERO phantom flights, honest error status, never fetches fallback-flights.json
    const rejectedFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/')) {
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

  it('treats valid empty { ac: [] } / { aircraft: [] } or OpenSky { states: [] } as authoritative live without calling downstream providers', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const adsbEmptySpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
        return new Response(JSON.stringify({ aircraft: [] }), { status: 200 });
      }
      throw new Error(`Unexpected downstream call to ${url}`);
    });
    vi.stubGlobal('fetch', adsbEmptySpy);

    const emptyLive = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(emptyLive.status).toBe('live');
    expect(emptyLive.provider).toBe('cors-relay:adsb.fi');
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

    // OpenSky empty states: [] returns live immediately without calling downstream fallback
    clearFlightsServiceCache();
    const osEmptySpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://opensky-network.org/')) {
        return new Response(JSON.stringify({ states: [] }), { status: 200 });
      }
      return new Response('Down', { status: 503 });
    });
    vi.stubGlobal('fetch', osEmptySpy);
    const osEmpty = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(osEmpty.status).toBe('live');
    expect(osEmpty.provider).toBe('opensky-network');
    expect(osEmpty.entities).toEqual([]);
  });

  it('enforces proxy, zero-preflight relay, & direct cascade order, OpenSky stale/ground filtering, polar guard, and data.Error rejection', async () => {
    // Stage 1 localhost proxy order: adsb.fi (v3) -> adsb.lol -> airplanes.live
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
    expect(proxyUrls[0]).toContain('/api-proxy/adsb-fi/api/v3/');
    expect(proxyUrls[1]).toContain('/api-proxy/adsb-lol/');
    expect(proxyUrls[2]).toContain('/api-proxy/airplanes-live/');

    // Stage 2 -> Stage 3 public domain cascade order:
    // cors-relay:adsb.fi -> cors-relay:adsb.lol -> adsb.lol -> opensky-network (filters ground/stale; never calls api.airplanes.live)
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const directCalls: Array<{ url: string; headers?: HeadersInit }> = [];
    const nowSec = Math.floor(Date.now() / 1000);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        directCalls.push({ url, headers: init?.headers });
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
    expect(directCalls[0].url).toContain('https://r.jina.ai/https://opendata.adsb.fi/api/v3/');
    expect(directCalls[0].headers).toBeUndefined();
    expect(directCalls[1].url).toContain('https://r.jina.ai/https://api.adsb.lol/v2/');
    expect(directCalls[1].headers).toBeUndefined();
    expect(directCalls[2].url).toContain('https://api.adsb.lol/v2/');
    expect(directCalls[3].url).toContain('https://opensky-network.org/');
    expect(directCalls.some((c) => c.url.includes('api.airplanes.live'))).toBe(false);

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

  it('extractRelayedJsonPayload parses Jina Markdown Content, direct JSON, Jina {data:{content}}, and rejects HTML, {Error}, and truncated JSON', () => {
    const jinaMarkdown = [
      'Title: ',
      '',
      'URL Source: https://opendata.adsb.fi/api/v3/lat/38.85/lon/-77.04/dist/65',
      '',
      'Markdown Content:',
      '{"aircraft":[{"hex":"a12345","flight":"UAL1"}]}',
    ].join('\n');
    expect(extractRelayedJsonPayload(jinaMarkdown, 'cors-relay:adsb.fi')).toEqual({
      aircraft: [{ hex: 'a12345', flight: 'UAL1' }],
    });

    const jinaMarkdownCrlf = `URL Source: https://api.adsb.lol/\r\n\r\nMarkdown Content:\r\n{"ac":[{"hex":"a54321"}]}`;
    expect(extractRelayedJsonPayload(jinaMarkdownCrlf, 'cors-relay:adsb.lol')).toEqual({
      ac: [{ hex: 'a54321' }],
    });

    expect(extractRelayedJsonPayload('  {"ac":[{"hex":"a99999"}]}  ', 'direct')).toEqual({
      ac: [{ hex: 'a99999' }],
    });

    const jinaEnvelope = JSON.stringify({
      code: 200,
      status: 20000,
      data: {
        title: '',
        content: '{"aircraft":[{"hex":"a77777"}]}',
      },
    });
    expect(extractRelayedJsonPayload(jinaEnvelope, 'cors-relay:adsb.fi')).toEqual({
      aircraft: [{ hex: 'a77777' }],
    });

    // Rejections: HTML, wrapped HTML, { Error }, truncated JSON, arrays, empty/unmarked text
    expect(() =>
      extractRelayedJsonPayload('<!doctype html><html><body>502 Bad Gateway</body></html>', 'relay')
    ).toThrow();
    expect(() =>
      extractRelayedJsonPayload('<html><body>Blocked</body></html>', 'relay')
    ).toThrow();
    expect(() =>
      extractRelayedJsonPayload('URL Source: x\n\nMarkdown Content:\n<!doctype html><html>403</html>', 'relay')
    ).toThrow();
    expect(() =>
      extractRelayedJsonPayload(JSON.stringify({ data: { content: '<html>err</html>' } }), 'relay')
    ).toThrow();
    expect(() =>
      extractRelayedJsonPayload('{"Error":"Rate limit exceeded"}', 'relay')
    ).toThrow('Rate limit exceeded');
    expect(() =>
      extractRelayedJsonPayload('Markdown Content:\n{"Error":"Upstream limit"}', 'relay')
    ).toThrow('Upstream limit');
    expect(() =>
      extractRelayedJsonPayload('{"ac":[{"hex":"a12', 'relay')
    ).toThrow();
    expect(() =>
      extractRelayedJsonPayload('Markdown Content:\n{"ac":[{"hex":"a12', 'relay')
    ).toThrow();
    expect(() => extractRelayedJsonPayload('[1, 2, 3]', 'relay')).toThrow('Invalid payload from relay');
    expect(() => extractRelayedJsonPayload('   ', 'relay')).toThrow('Invalid payload from relay');
  });

  it('detects local dev / LAN runtimes vs public domains and fast-bypasses static 404/HTML proxy responses cleanly', async () => {
    const devHosts = [
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      '192.168.1.42',
      '10.0.0.5',
      '172.20.0.2',
      '100.64.0.1',
      'macbook.local',
      'cockpit-dev',
    ];
    for (const hostname of devHosts) {
      vi.stubGlobal('window', { location: { hostname } });
      expect(isLocalDevOrLanRuntime(), `${hostname} should be local/LAN`).toBe(true);
    }

    const publicHosts = ['krunked-fpv.github.io', 'krunked.github.io', '172.32.0.1', '100.128.0.1'];
    for (const hostname of publicHosts) {
      vi.stubGlobal('window', { location: { hostname } });
      expect(isLocalDevOrLanRuntime(), `${hostname} should be public`).toBe(false);
    }

    // Static server at 127.0.0.1 returning 404 on /api-proxy/adsb-fi/ fast-bypasses Stage 1 without calling adsb-lol/airplanes-live proxies
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: '127.0.0.1' } });
    const bypassCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        bypassCalls.push(url);
        if (url.startsWith('/api-proxy/adsb-fi/')) {
          return new Response('Not Found', { status: 404, statusText: 'Not Found' });
        }
        if (url.startsWith('/api-proxy/adsb-lol/') || url.startsWith('/api-proxy/airplanes-live/')) {
          throw new Error(`Should have fast-bypassed ${url}`);
        }
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              aircraft: [{ hex: 'a88888', flight: 'LAN1', lat: 38.86, lon: -77.05, alt_baro: 10000, gs: 260, track: 90 }],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const bypassLive = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(bypassLive.status).toBe('live');
    expect(bypassLive.provider).toBe('cors-relay:adsb.fi');
    expect(bypassLive.httpStatus).toBeUndefined();
    expect(bypassCalls).toHaveLength(2);
    expect(bypassCalls[0]).toContain('/api-proxy/adsb-fi/');
    expect(bypassCalls[1]).toContain('https://r.jina.ai/https://opendata.adsb.fi/');

    // Subsequent call while viteProxyUnavailable is latched skips Stage 1 completely
    const callsAfterLatch: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        callsAfterLatch.push(url);
        throw new TypeError('Failed to fetch');
      })
    );
    const latchedErr = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    expect(latchedErr.status).toBe('error');
    expect(latchedErr.httpStatus).toBeUndefined();
    expect(callsAfterLatch.some((u) => u.startsWith('/api-proxy/'))).toBe(false);

    // Static 404 on fresh probe never leaks 404 into httpStatus when downstream fails with TypeError, and HTML SPA fallback also bypasses cleanly
    clearFlightsServiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api-proxy/adsb-fi/')) {
          return new Response('<!doctype html><html><body>SPA</body></html>', { status: 200 });
        }
        if (url.startsWith('/api-proxy/adsb-lol/') || url.startsWith('/api-proxy/airplanes-live/')) {
          throw new Error(`Should not call ${url} after HTML fast-bypass`);
        }
        throw new TypeError('Failed to fetch');
      })
    );
    const htmlBypassFail = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(htmlBypassFail.status).toBe('error');
    expect(htmlBypassFail.httpStatus).toBeUndefined();
    expect(htmlBypassFail.errorMsg).not.toContain('vite-proxy:adsb.fi');
  });

  it('recovers immediately with resetBreakers: true and preserves rate-limited + (HTTP 429) details on open 429 breakers', async () => {
    vi.stubGlobal('window', { location: { hostname: 'krunked-fpv.github.io' } });
    const rlUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        rlUrls.push(String(input));
        return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
      })
    );

    // 3 failed passes trip cors-relay:adsb.fi, adsb.lol, and opensky (cors-relay:adsb.lol skipped due to shared 429)
    for (let i = 0; i < 3; i++) {
      const res = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
      expect(res.status).toBe('rate-limited');
      expect(res.httpStatus).toBe(429);
    }
    expect(rlUrls.some((u) => u.includes('https://r.jina.ai/https://api.adsb.lol/'))).toBe(false);

    // 4th pass with healthy mock MUST still see open circuit breakers (0 fetch calls), preserving rate-limited + (HTTP 429)
    const liveMockAfterTrip = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
        return new Response(
          JSON.stringify({
            aircraft: [{ hex: 'a44444', flight: 'REC1', lat: 38.86, lon: -77.05, alt_baro: 9500, gs: 250, track: 110 }],
          }),
          { status: 200 }
        );
      }
      return new Response('Down', { status: 503 });
    });
    vi.stubGlobal('fetch', liveMockAfterTrip);

    const openRes = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    expect(liveMockAfterTrip).not.toHaveBeenCalled();
    expect(openRes.status).toBe('rate-limited');
    expect(openRes.httpStatus).toBe(429);
    expect(openRes.errorMsg).toContain('(HTTP 429)');

    // 5th pass with resetBreakers: true resets breakers immediately and recovers live traffic
    const recoveredRes = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, {
      force: true,
      resetBreakers: true,
    });
    expect(recoveredRes.status).toBe('live');
    expect(recoveredRes.provider).toBe('cors-relay:adsb.fi');
    expect(recoveredRes.entities.map((e) => e.callsign)).toEqual(['REC1']);
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

  it('resets balloonsCircuitBreaker when fetchBalloons is called with force: true', async () => {
    balloonsCircuitBreaker.reset();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    );

    for (let i = 0; i < 3; i++) {
      const errRes = await fetchBalloons(DCA_OBSERVER, 120);
      expect(errRes.status).toBe('error');
    }
    expect(balloonsCircuitBreaker.getState('sondehub-sondes')).toBe('open');
    expect(balloonsCircuitBreaker.getState('sondehub-amateur')).toBe('open');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/sondes')) {
          return new Response(
            JSON.stringify([{ serial: 'R4100888', lat: 38.9, lon: -77.01, alt: 12000, vel_v: 5.0, vel_h: 15 }]),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );

    const blockedRes = await fetchBalloons(DCA_OBSERVER, 120);
    expect(blockedRes.status).toBe('error');

    const recoveredRes = await fetchBalloons(DCA_OBSERVER, 120, undefined, { force: true });
    expect(recoveredRes.status).toBe('live');
    expect(recoveredRes.entities.map((e) => e.serial)).toEqual(['R4100888']);
    balloonsCircuitBreaker.reset();
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

describe('Sprint 03 Zero-Key Relay, WindBorne, Mil/LADD/PIA, ATC UAS & ADS-B LTA Ingest', () => {
  beforeEach(() => {
    clearFlightsServiceCache();
    clearBalloonsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('extractRelayedJsonValue parses arrays, objects, Jina envelopes & Published Time while rejecting HTML/{Error}/truncated', () => {
    // Direct object & direct array
    expect(extractRelayedJsonValue(' {"ac":[{"hex":"ae1234"}]} ', 'direct')).toEqual({
      value: { ac: [{ hex: 'ae1234' }] },
    });
    expect(extractRelayedJsonValue(' [[38.85, -77.04, 18.4]] ', 'direct')).toEqual({
      value: [[38.85, -77.04, 18.4]],
    });

    // Jina { data: { content, publishedTime } } envelope (including array inside content)
    const pubIso = '2026-11-23T20:15:00.000Z';
    const jinaJsonEnvelope = JSON.stringify({
      code: 200,
      data: {
        publishedTime: pubIso,
        content: '[[35.5, 139.7, 21.2]]',
      },
    });
    expect(extractRelayedJsonValue(jinaJsonEnvelope, 'jina-json')).toEqual({
      value: [[35.5, 139.7, 21.2]],
      publishedTimeMs: Date.parse(pubIso),
    });

    // Jina Markdown Content text envelope with valid Published Time
    const rfcTime = 'Mon, 23 Nov 2026 20:00:00 GMT';
    const mdWithPub = [
      'Title: ',
      '',
      'URL Source: https://a.windbornesystems.com/treasure/00.json',
      '',
      `Published Time: ${rfcTime}`,
      '',
      'Markdown Content:',
      '[[10.0, 179.95, 19.0]]',
    ].join('\n');
    expect(extractRelayedJsonValue(mdWithPub, 'jina-md')).toEqual({
      value: [[10.0, 179.95, 19.0]],
      publishedTimeMs: Date.parse(rfcTime),
    });

    // Empty or invalid Published Time must not bleed into Markdown Content
    const mdInvalidPub = [
      'Published Time: ',
      'Markdown Content:',
      '{"ac":[{"hex":"a12345"}]}',
    ].join('\n');
    expect(extractRelayedJsonValue(mdInvalidPub, 'jina-md')).toEqual({
      value: { ac: [{ hex: 'a12345' }] },
    });

    // Reject HTML, empty, truncated JSON, primitives, and { Error }
    expect(() => extractRelayedJsonValue('<!doctype html><html>502</html>', 'relay')).toThrow(
      'Invalid payload from relay'
    );
    expect(() => extractRelayedJsonValue('<html><body>Blocked</body></html>', 'relay')).toThrow(
      'Invalid payload from relay'
    );
    expect(() => extractRelayedJsonValue('<pre>err</pre>', 'relay')).toThrow(
      'Invalid payload from relay'
    );
    expect(() => extractRelayedJsonValue('   ', 'relay')).toThrow('Invalid payload from relay');
    expect(() => extractRelayedJsonValue('Markdown Content:\nnull', 'relay')).toThrow(
      'Invalid payload from relay'
    );
    expect(() => extractRelayedJsonValue('[[38.8, -77.0', 'relay')).toThrow();
    expect(() => extractRelayedJsonValue('{"Error":"Proxy limit"}', 'relay')).toThrow(
      'Proxy limit'
    );
    expect(() =>
      extractRelayedJsonValue(
        JSON.stringify({ data: { content: JSON.stringify({ Error: 'Upstream blocked' }) } }),
        'relay'
      )
    ).toThrow('Upstream blocked');
    expect(() => extractRelayedJsonValue(JSON.stringify({ Error: true }), 'relay')).toThrow(
      'Upstream error from relay'
    );
  });

  it('parseWindBorneConstellation derives 3D kinematics across Antimeridian, guards teleports & corrupt tuples, and caps trails <= 24', () => {
    const t0Ts = 1_760_000_000_000;
    const t0Raw: unknown[] = [
      [10.0, -179.9, 17.4], // index 0 -> WB-GSB-001 (ascending + eastbound across Antimeridian)
      [40.0, -75.0, 14.0], // index 1 -> WB-GSB-002 (descending)
      [50.0, 10.0, 20.0], // index 2 -> WB-GSB-003 (stationary -> float, headingValid=false)
      [0, 0, 15.0], // index 3 -> Null Island (skipped)
      [0.00005, -0.00005, 15.0], // index 4 -> Near Null Island (skipped)
      [95.0, 10.0, 15.0], // index 5 -> Out of bounds lat (skipped)
      [35.0, 190.0, 15.0], // index 6 -> Out of bounds lon (skipped)
      [35.0, -70.0, -0.8], // index 7 -> Out of bounds altKm (skipped)
      [35.0, -70.0, 62.0], // index 8 -> Out of bounds altKm (skipped)
      [Number.NaN, -70.0, 15.0], // index 9 -> NaN (skipped)
      [35.0, -70.0], // index 10 -> short tuple (skipped)
      null, // index 11 -> null (skipped)
      [25.0, 120.0, 18.0], // index 12 -> WB-GSB-013 (slot-reassignment teleport > 450 km from T-1h)
      [-15.0, -45.0, 16.5], // index 13 -> WB-GSB-014 (t0 longer than t1/t2)
    ];

    const t1Raw: unknown[] = [
      [10.0, 179.9, 12.0], // +0.2 deg east across Antimeridian (~21.9 km), +5.4 km alt -> +1.5 m/s
      [40.0, -75.2, 20.0], // -6.0 km alt -> -1.667 m/s
      [50.0, 10.0, 20.0], // 0 km move
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      [25.0, 126.0, 17.0], // ~605 km away -> > 450 km slot jump!
    ];

    const t2Raw: unknown[] = [
      [10.0, 179.7, 11.5], // T-2h -> T-1h is ~21.9 km (<= 450 km)
      [40.0, -82.0, 21.0], // T-2h -> T-1h is ~578 km (> 450 km teleport, T-2h skipped from trail)
    ];

    const parsed = parseWindBorneConstellation(t0Raw, t1Raw, t2Raw, DCA_OBSERVER, {
      timestampMs: t0Ts,
    });

    expect(parsed.map((b) => b.constellationId)).toEqual([
      'WB-GSB-001',
      'WB-GSB-002',
      'WB-GSB-003',
      'WB-GSB-013',
      'WB-GSB-014',
    ]);

    const wb1 = parsed[0];
    expect(wb1.id).toBe('balloon:WB-GSB-001');
    expect(wb1.subSource).toBe('windborne');
    expect(wb1.sondeType).toBe('WindBorne Global Sounding Balloon');
    expect(wb1.country).toBe('WindBorne Systems');
    expect(wb1.altM).toBeCloseTo(17_400, 1);
    const expectedDist1Km = haversineDistanceKm(10.0, 179.9, 10.0, -179.9);
    expect(expectedDist1Km).toBeCloseTo(21.9, 0);
    expect(wb1.speedMs).toBeCloseTo((expectedDist1Km * 1000) / 3600, 3);
    expect(wb1.headingValid).toBe(true);
    expect(wb1.headingDeg).toBeCloseTo(90, 0);
    expect(wb1.vertRateMs).toBeCloseTo(1.5, 3);
    expect(wb1.burstState).toBe('ascending');
    expect(wb1.subtitle).toContain('ASCENDING');
    expect(wb1.trail).toHaveLength(3);
    expect(wb1.trail.map((p) => p.ts)).toEqual([t0Ts - 7_200_000, t0Ts - 3_600_000, t0Ts]);

    const wb2 = parsed[1];
    expect(wb2.burstState).toBe('descending');
    expect(wb2.vertRateMs).toBeCloseTo(-6000 / 3600, 3);
    expect(wb2.trail).toHaveLength(2); // T-2h omitted due to >450 km step to T-1h

    const wb3 = parsed[2];
    expect(wb3.headingValid).toBe(false);
    expect(wb3.headingDeg).toBe(0);
    expect(wb3.speedMs).toBe(0);
    expect(wb3.burstState).toBe('float');

    const wb13 = parsed[3]; // >450 km slot jump -> zeroed kinematics & single-point trail
    expect(wb13.speedMs).toBe(0);
    expect(wb13.headingValid).toBe(false);
    expect(wb13.vertRateMs).toBe(0);
    expect(wb13.trail).toHaveLength(1);

    const wb14 = parsed[4]; // beyond t1/t2 length -> single-point trail
    expect(wb14.trail).toHaveLength(1);

    // Trail merging & MAX_TRAIL_POINTS = 24 cap across 30 consecutive polls
    let prevMap = new Map<string, BalloonEntity>(parsed.map((b) => [b.id, b]));
    for (let step = 1; step <= 30; step++) {
      const nextLat = 10.0 + step * 0.002;
      const stepEntities = parseWindBorneConstellation(
        [[nextLat, -179.9, 17.5]],
        [[10.0, 179.9, 12.0]],
        [[10.0, 179.7, 11.5]],
        DCA_OBSERVER,
        { timestampMs: t0Ts + step * 60_000, prevMap }
      );
      expect(stepEntities[0].trail.length).toBeLessThanOrEqual(24);
      prevMap = new Map(stepEntities.map((b) => [b.id, b]));
    }
    expect(prevMap.get('balloon:WB-GSB-001')?.trail).toHaveLength(24);
  });

  it('fetchBalloons enforces 5-min WindBorne TTL cache, zero-preflight proxy fast-bypass, scope clipping, and seed fallback', async () => {
    expect(WINDBORNE_TTL_MS).toBe(300_000);
    expect(WINDBORNE_DB_NAME).toBe('krunked_windborne_v1');

    // Localhost proxy 404 fast-bypasses to zero-preflight r.jina.ai relay and caches for 5 min
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const capturedCalls: Array<{ url: string; headers?: HeadersInit }> = [];
    const baseMs = 1_760_000_000_000;

    const farBalloon: [number, number, number] = [48.8566, 2.3522, 18.5]; // Paris (far from DCA)
    const localBalloon: [number, number, number] = [38.9, -77.1, 19.2]; // Near DCA

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        capturedCalls.push({ url, headers: init?.headers });
        if (url.startsWith('/api-proxy/windborne/')) {
          return new Response('Not Found', { status: 404 });
        }
        if (url.startsWith('https://r.jina.ai/https://a.windbornesystems.com/treasure/00.json')) {
          return new Response(
            `Published Time: Mon, 23 Nov 2026 20:00:00 GMT\n\nMarkdown Content:\n${JSON.stringify([
              farBalloon,
              localBalloon,
            ])}`,
            { status: 200 }
          );
        }
        if (url.startsWith('https://r.jina.ai/https://a.windbornesystems.com/treasure/01.json')) {
          return new Response(JSON.stringify([[48.8, 2.2, 18.0], [38.85, -77.15, 18.8]]), {
            status: 200,
          });
        }
        if (url.startsWith('https://r.jina.ai/https://a.windbornesystems.com/treasure/02.json')) {
          return new Response('Upstream blip', { status: 503 });
        }
        if (url.includes('/sondes')) {
          expect(url).toContain('distance=600000');
          return new Response(
            JSON.stringify([{ serial: 'R41-GLOBAL', lat: 45.0, lon: 10.0, alt: 11000, vel_v: 4.5, vel_h: 18 }]),
            { status: 200 }
          );
        }
        if (url.includes('/amateur')) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        return new Response('Unavailable', { status: 503 });
      })
    );

    const globalLive = await fetchBalloons(DCA_OBSERVER, 120, undefined, {
      scope: 'global',
      nowMs: baseMs,
    });
    expect(globalLive.status).toBe('live');
    expect(globalLive.windborneStatus).toBe('live');
    expect(globalLive.sourceCounts).toEqual({ windborne: 2, sondehub: 1 });
    expect(globalLive.entities.some((e) => e.subSource === 'windborne')).toBe(true);
    expect(globalLive.entities.some((e) => e.subSource === 'sondehub')).toBe(true);

    const relayCalls = capturedCalls.filter((c) => c.url.startsWith('https://r.jina.ai/'));
    expect(relayCalls.length).toBeGreaterThanOrEqual(1);
    for (const c of relayCalls) {
      expect(c.headers).toBeUndefined();
    }

    // Within 5-min TTL (< 300_000 ms), WindBorne uses cache with 0 WindBorne network fetches; local scope clips to radiusKm * 1.05
    const callsBeforeTtlHit = capturedCalls.length;
    const localCached = await fetchBalloons(DCA_OBSERVER, 120, undefined, {
      scope: 'local',
      includeWindBorne: true,
      nowMs: baseMs + 120_000,
    });
    expect(localCached.windborneStatus).toBe('cached');
    expect(localCached.sourceCounts?.windborne).toBe(1);
    expect(localCached.sourceCounts?.sondehub).toBe(0);
    const windborneCallsDuringTtl = capturedCalls
      .slice(callsBeforeTtlHit)
      .filter((c) => c.url.includes('windborne'));
    expect(windborneCallsDuringTtl).toHaveLength(0);

    // After 5-min TTL expires, live + relay fail -> falls back to ./data/windborne-balloons.json seed
    const seedTs = 1_759_000_000_000;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('windborne-balloons.json')) {
          return new Response(
            JSON.stringify({
              capturedAtMs: seedTs,
              t0: [[34.05, -118.24, 17.5]],
              t1: [[34.0, -118.3, 17.0]],
            }),
            { status: 200 }
          );
        }
        return new Response('Unavailable', { status: 503 });
      })
    );

    const seedFallback = await fetchBalloons(DCA_OBSERVER, 120, undefined, {
      scope: 'global',
      nowMs: baseMs + WINDBORNE_TTL_MS + 1000,
    });
    expect(seedFallback.status).toBe('cached');
    expect(seedFallback.windborneStatus).toBe('cached');
    expect(seedFallback.timestampMs).toBe(seedTs);
    expect(seedFallback.entities).toHaveLength(1);
    expect(seedFallback.entities[0].isCachedSeed).toBe(true);
    expect(seedFallback.entities[0].timestampMs).toBe(seedTs);
    expect(seedFallback.entities[0].subSource).toBe('windborne');

    // clearBalloonsCache resets breakers & proxy latch cleanly
    windborneCircuitBreaker.recordFailure('windborne-relay', new Error('err1'));
    windborneCircuitBreaker.recordFailure('windborne-relay', new Error('err2'));
    windborneCircuitBreaker.recordFailure('windborne-relay', new Error('err3'));
    expect(windborneCircuitBreaker.getState('windborne-relay')).toBe('open');
    clearBalloonsCache();
    expect(windborneCircuitBreaker.getState('windborne-relay')).toBe('closed');
  });

  it('flightsService expands military recognition, routes B6 ATC UAS & B2 LTA balloons, and preserves hovering/high-alt targets', async () => {
    // Expanded military hex (Canada, France), type codes (C17, F35, RQ4), callsigns (COAST, ORDER, NATO)
    expect(classifyMilitary('c0cdf9', 'CFC101', 0)).toBe(true);
    expect(classifyMilitary('3b0123', 'FAF200', 0)).toBe(true);
    expect(classifyMilitary('a12345', 'UAL418', 0, 'C17')).toBe(true);
    expect(classifyMilitary('a12345', 'UAL418', 0, 'F35')).toBe(true);
    expect(classifyMilitary('a11111', 'COAST12', 0)).toBe(true);
    expect(classifyMilitary('a11111', 'ORDER66', 0)).toBe(true);
    expect(classifyMilitary('a11111', 'NATO01', 0)).toBe(true);
    expect(classifyMilitary('a12345', 'UAL418', 8)).toBe(false);
    expect(classifyMilitary('a11111', 'SAMA100', 0)).toBe(false);

    // Military C17 preserves 'heavy' airframeClass; airborne LADD gets category 'military'
    const c17 = normalizeAdsbxAircraft(
      {
        hex: 'a12345',
        flight: 'RCH501',
        t: 'C17',
        lat: 38.86,
        lon: -77.05,
        alt_baro: 28000,
        gs: 420,
        track: 90,
      },
      DCA_OBSERVER
    );
    expect(c17?.category).toBe('military');
    expect(c17?.isMilitary).toBe(true);
    expect(c17?.airframeClass).toBe('heavy');

    const airborneLadd = normalizeAdsbxAircraft(
      {
        hex: 'a23456',
        flight: 'EXEC1',
        t: 'G650',
        lat: 38.86,
        lon: -77.05,
        alt_baro: 41000,
        gs: 480,
        track: 180,
        dbFlags: 8,
      },
      DCA_OBSERVER
    );
    expect(airborneLadd?.category).toBe('military');
    expect(airborneLadd?.isLadd).toBe(true);
    expect(airborneLadd?.isMilitary).toBe(false);
    expect(airborneLadd?.airframeClass).toBe('jet');

    // Altitude cap raised to 70,000 m (~230k ft) and gs: 0 hovering target preserved
    const highAlt = normalizeAdsbxAircraft(
      {
        hex: 'a34567',
        flight: 'TESTHI',
        lat: 38.86,
        lon: -77.05,
        alt_baro: null,
        alt_geom: 225_000,
        gs: 0,
        track: null,
      },
      DCA_OBSERVER
    );
    expect(highAlt).not.toBeNull();
    expect(highAlt?.altM).toBeCloseTo(225_000 * 0.3048, 1);
    expect(highAlt?.speedMs).toBe(0);

    // Fetch cascade routes B6/RQ4 -> uasEntities and B2/floater -> balloonEntities, excluding U2/WB57
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              aircraft: [
                {
                  hex: 'ae5401',
                  flight: 'FORTE10',
                  t: 'RQ4',
                  category: 'B6',
                  lat: 38.865,
                  lon: -77.07,
                  alt_baro: null,
                  alt_geom: 55000,
                  gs: 320,
                  track: 110,
                  seen_pos: 2,
                },
                {
                  hex: 'a77001',
                  flight: 'UASVTOL',
                  t: 'S100',
                  lat: 38.865,
                  lon: -77.07,
                  alt_baro: 450,
                  gs: 3,
                  track: 45,
                  seen_pos: 1,
                },
                {
                  hex: 'a77002',
                  flight: 'HBAL701',
                  category: 'B2',
                  lat: 38.9,
                  lon: -77.02,
                  alt_baro: null,
                  alt_geom: 62000,
                  gs: 12,
                  track: 75,
                  seen_pos: 3,
                },
                {
                  hex: 'a77003',
                  flight: 'NASA926',
                  t: 'WB57',
                  lat: 38.91,
                  lon: -77.01,
                  alt_baro: null,
                  alt_geom: 61000,
                  gs: 85,
                  track: 200,
                  seen_pos: 2,
                },
                {
                  hex: 'a77004',
                  flight: 'HELI01',
                  t: 'H135',
                  category: 'A7',
                  lat: 38.85,
                  lon: -77.05,
                  alt_baro: 800,
                  gs: 0,
                  track: 0,
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

    const res = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, {
      force: true,
      airspace: SAMPLE_AIRSPACE,
    });
    expect(res.status).toBe('live');

    // RQ4 and S100 routed to uasEntities; RQ4 FL550 must NEVER trip low-alt UASFM breach
    expect(res.uasEntities).toHaveLength(2);
    const rq4 = res.uasEntities?.find((d) => d.callsign === 'FORTE10');
    expect(rq4).toMatchObject({
      id: 'drone:adsb-ae5401',
      subSource: 'adsb-uas',
      hasOperatorLocation: false,
      isMilitary: true,
      uaType: 'fixed-wing',
      missionDesc: 'LIVE ATC UAS · MILITARY',
      ceilingBreach: false,
      faaCeilingFt: null,
    });
    expect(rq4?.altM).toBeCloseTo(55000 * 0.3048, 1);

    const s100 = res.uasEntities?.find((d) => d.callsign === 'UASVTOL');
    expect(s100).toMatchObject({
      subSource: 'adsb-uas',
      uaType: 'vtol',
      missionDesc: 'LIVE ATC UAS · ADS-B',
      ceilingBreach: true, // 450 ft <= 500 m inside 200 ft cell
    });

    // B2 routed to balloonEntities
    expect(res.balloonEntities).toHaveLength(1);
    expect(res.balloonEntities?.[0]).toMatchObject({
      id: 'balloon:adsb-a77002',
      subSource: 'adsb-lta',
      sondeType: 'ADS-B Stratospheric Balloon',
    });
    expect(res.balloonEntities?.[0].altM).toBeCloseTo(62000 * 0.3048, 1);

    // WB57 and hovering HELI01 remain in entities; B6/B2 are omitted
    expect(res.entities.map((e) => e.callsign).sort()).toEqual(['HELI01', 'NASA926']);
  });

  it('fetchGlobalSpecialFlights polls /v2/{mil,ladd,pia} safely, deduplicates by hex, and isolates breakers from local cascade', async () => {
    // Verify localhost proxy order & strict rule: NEVER hit adsb.fi /ladd or /pia
    vi.stubGlobal('window', { location: { hostname: 'localhost' } });
    const proxyUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        proxyUrls.push(url);
        if (url === '/api-proxy/adsb-lol/v2/mil') {
          return new Response(
            JSON.stringify({
              ac: [
                { hex: 'ae1001', flight: 'RCH101', t: 'C17', lat: 51.5, lon: -0.1, alt_baro: 32000, gs: 440, track: 90 },
                { hex: 'ae5401', flight: 'FORTE11', t: 'RQ4', category: 'B6', lat: 44.0, lon: 33.0, alt_baro: null, alt_geom: 54000, gs: 310, track: 180 },
              ],
            }),
            { status: 200 }
          );
        }
        if (url === '/api-proxy/adsb-lol/v2/ladd') {
          return new Response(
            JSON.stringify({
              ac: [
                { hex: 'ae1001', flight: 'RCH101', t: 'C17', lat: 51.5, lon: -0.1, alt_baro: 32000, gs: 440, track: 90, dbFlags: 8 },
                { hex: 'a90001', flight: 'LADD99', t: 'GLF5', lat: 34.0, lon: -118.0, alt_baro: 43000, gs: 470, track: 270 },
              ],
            }),
            { status: 200 }
          );
        }
        if (url === '/api-proxy/adsb-lol/v2/pia') {
          return new Response(
            JSON.stringify({
              ac: [
                { hex: '~2b1122', flight: 'PIA01', t: 'B737', lat: 40.7, lon: -74.0, alt_baro: 35000, gs: 450, track: 60 },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Unexpected', { status: 500 });
      })
    );

    const globalRes = await fetchGlobalSpecialFlights(DCA_OBSERVER);
    expect(globalRes.status).toBe('live');
    expect(globalRes.sourceCounts).toEqual({ mil: 2, ladd: 2, pia: 1 });
    expect(globalRes.uasEntities).toHaveLength(1);
    expect(globalRes.entities).toHaveLength(3); // ae1001 deduped + a90001 + ~2b1122
    const dedupedMilLadd = globalRes.entities.find((e) => e.icaoHex === 'ae1001');
    expect(dedupedMilLadd?.isMilitary).toBe(true);
    expect(dedupedMilLadd?.isLadd).toBe(true);
    expect(globalRes.entities.find((e) => e.icaoHex === 'a90001')?.category).toBe('military');
    expect(globalRes.entities.find((e) => e.icaoHex === '~2b1122')?.isPia).toBe(true);
    expect(globalRes.entities.find((e) => e.icaoHex === '~2b1122')?.category).toBe('military');
    expect(proxyUrls.some((u) => u.includes('adsb-fi') && (u.includes('ladd') || u.includes('pia')))).toBe(
      false
    );

    // Rate-limit isolation: global 15s cooldown does NOT block local 10s fetchFlightsCascade, and trips global breakers without affecting flightsCircuitBreaker
    clearFlightsServiceCache();
    vi.stubGlobal('window', { location: { hostname: 'krunked.github.io' } });
    const relayHeaders: Array<HeadersInit | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/')) {
          relayHeaders.push(init?.headers);
        }
        if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/api/v3/')) {
          return new Response(
            JSON.stringify({
              aircraft: [{ hex: 'a12345', flight: 'LOCAL1', lat: 38.86, lon: -77.05, alt_baro: 9000, gs: 250, track: 90 }],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    for (let i = 0; i < 3; i++) {
      const failGlobal = await fetchGlobalSpecialFlights(DCA_OBSERVER, undefined, { force: true });
      expect(failGlobal.status).toBe('error');
    }
    expect(globalFlightsCircuitBreaker.getState('global-mil-relay-adsb-lol')).toBe('open');
    expect(flightsCircuitBreaker.getState('cors-relay-adsb-fi')).toBe('closed');
    for (const h of relayHeaders) {
      expect(h).toBeUndefined();
    }

    const localStillWorks = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(localStillWorks.status).toBe('live');
    expect(localStillWorks.entities.map((e) => e.callsign)).toEqual(['LOCAL1']);
    expect(globalAdsbRateLimiter.canConsume('global-special')).toBe(false);
    expect(adsbRateLimiter.canConsume('other-key')).toBe(true);
  });

  it('openDroneIdService tags odid-sim and odid-live subSource & hasOperatorLocation=true', () => {
    const sim = stepSimulatedDrones(DCA_OBSERVER, 120, 5, SAMPLE_AIRSPACE);
    expect(sim).toHaveLength(4);
    for (const d of sim) {
      expect(d.subSource).toBe('odid-sim');
      expect(d.hasOperatorLocation).toBe(true);
    }

    const live = normalizeOdidPayload(
      [{ uasId: 'LIVE-ODID-1', lat: 38.86, lon: -77.05, altAglM: 70 }],
      DCA_OBSERVER,
      SAMPLE_AIRSPACE
    );
    expect(live).toHaveLength(1);
    expect(live[0].subSource).toBe('odid-live');
    expect(live[0].hasOperatorLocation).toBe(true);
  });
});
