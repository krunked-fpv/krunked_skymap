import type {
  FeedHealthStatus,
  FlightEntity,
  ObserverLocation,
  TrailPoint,
} from '../types/sky-contracts';
import {
  computeTopocentricLookAngles,
  normalizeAzimuthDeg,
  normalizeLonDeg,
} from './geoHelpers';
import {
  CircuitBreaker,
  TokenBucketRateLimiter,
  fetchJsonWithTimeout,
} from './httpClient';

const FT_TO_M = 0.3048;
const KNOTS_TO_MS = 0.514444;
const FPM_TO_MS = 0.00508;
const MAX_TRAIL_POINTS = 24;
const DEFAULT_ADSB_TIMEOUT_MS = 3500;

export interface RawAdsbxAircraft {
  hex?: unknown;
  flight?: unknown;
  r?: unknown;
  t?: unknown;
  desc?: unknown;
  ownOp?: unknown;
  lat?: unknown;
  lon?: unknown;
  alt_baro?: unknown;
  alt_geom?: unknown;
  gs?: unknown;
  tas?: unknown;
  ias?: unknown;
  track?: unknown;
  true_heading?: unknown;
  mag_heading?: unknown;
  calc_track?: unknown;
  baro_rate?: unknown;
  geom_rate?: unknown;
  squawk?: unknown;
  emergency?: unknown;
  category?: unknown;
  dbFlags?: unknown;
  seen_pos?: unknown;
  seen?: unknown;
  ground?: unknown;
  dLat?: unknown;
  dLon?: unknown;
}

export interface FlightsFetchOptions {
  force?: boolean;
  rateLimitKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface FlightsFetchResult {
  entities: FlightEntity[];
  status: FeedHealthStatus;
  provider: string;
  timestampMs: number;
  errorMsg?: string;
}

export const adsbRateLimiter = new TokenBucketRateLimiter({
  minIntervalMs: 10_000,
  capacity: 1,
});

export const flightsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
});

const lastCachedFlightsByKey = new Map<
  string,
  { entities: FlightEntity[]; provider: string; timestampMs: number }
>();

export function clearFlightsServiceCache(): void {
  lastCachedFlightsByKey.clear();
  adsbRateLimiter.reset();
  flightsCircuitBreaker.reset();
}

const MILITARY_HEX_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xadf7c8, 0xafffff], // US DoD / Military (above civil N1..N99999 block)
  [0x43c000, 0x43cfff], // UK Military (RAF / RN / AAC)
  [0x3f4000, 0x3fbfff], // Germany Military (Luftwaffe)
  [0x3ea000, 0x3ebfff], // Germany Military secondary allocation
  [0x7cf800, 0x7cffff], // Australia Military (RAAF)
  [0x4d0000, 0x4d03ff], // NATO E-3A / Luxembourg NATO
];

const MILITARY_CALLSIGN_REGEX =
  /^(?:RCH\d|REACH\d?|SAM\d+|AF[12]$|SPAR\d+|PAT\d+|CNV\d+|CONVOY|NAVY\d*|USAF\d*|USCG\d*|ARMY\d*|ASCOT\d*|RRR\d+|BAF\d+|GAF\d+|FAF\d+|IAM\d+|CFC\d+|ASY\d+|RAAF\d*|TOPGUN|TEAL\d+|SENTRY\d*|DOOM\d+|BONE\d+|NOBLE\d+|HAWK\d+|VIPER\d+|WARHAWK|GOLD\d+|LAGR\d+|NCHO\d+|HOBO\d+|DUKE\d+|KING\d+|JOLLY\d+|PEDRO\d+|CHAOS\d+|EVAC\d+|JANET\d+)/;

const HELI_TYPE_PREFIXES = new Set([
  'R22',
  'R44',
  'R66',
  'B06',
  'B407',
  'B412',
  'B429',
  'EC35',
  'EC45',
  'EC55',
  'H60',
  'S70',
  'S76',
  'S92',
  'UH60',
  'AH64',
  'CH47',
  'MV22',
  'V22',
  'AS50',
  'AW39',
  'A139',
  'MD50',
  'MD60',
  'H125',
  'H135',
  'H145',
  'H160',
  'H175',
  'H225',
  'MI8',
  'MI24',
  'KA52',
  'UH1',
  'B47',
  'S61',
  'S64',
]);

const HEAVY_TYPE_PREFIXES = new Set([
  'B74',
  'B77',
  'B78',
  'A33',
  'A34',
  'A35',
  'A38',
  'MD11',
  'DC10',
  'IL76',
  'AN124',
  'AN225',
  'C17',
  'C5',
  'C5M',
  'KC10',
  'KC46',
  'KC135',
  'E3',
  'E4',
  'E6',
  'E8',
]);

const PROP_TYPE_PREFIXES = new Set([
  'C150',
  'C152',
  'C172',
  'C182',
  'C206',
  'C208',
  'C210',
  'PA28',
  'PA32',
  'PA34',
  'PA44',
  'PA46',
  'P28A',
  'SR20',
  'SR22',
  'BE36',
  'BE58',
  'BE20',
  'BE30',
  'DH8',
  'AT4',
  'AT7',
  'PC12',
  'TBM',
  'DA40',
  'DA42',
  'DA62',
  'M20P',
  'RV7',
  'RV10',
  'E120',
  'SF34',
]);

const FAST_MIL_TYPE_PREFIXES = new Set([
  'F15',
  'F16',
  'F18',
  'FA18',
  'F22',
  'F35',
  'T38',
  'T6',
  'T45',
  'EUFI',
  'RFAL',
  'GRIP',
  'B1',
  'B2',
  'B52',
  'A10',
  'U2',
  'MQ9',
  'RQ4',
]);

function deriveCountryFromIcaoHex(hex: string): string {
  const clean = hex.replace(/^~/, '').toLowerCase();
  const num = Number.parseInt(clean, 16);
  if (!Number.isFinite(num)) return 'Unknown';
  if (num >= 0xa00000 && num <= 0xafffff) return 'United States';
  if (num >= 0x400000 && num <= 0x43ffff) return 'United Kingdom';
  if (num >= 0xc00000 && num <= 0xc3ffff) return 'Canada';
  if (num >= 0x3c0000 && num <= 0x3fffff) return 'Germany';
  if (num >= 0x380000 && num <= 0x3bffff) return 'France';
  if (num >= 0x840000 && num <= 0x87ffff) return 'Japan';
  if (num >= 0x7c0000 && num <= 0x7fffff) return 'Australia';
  if (num >= 0x300000 && num <= 0x33ffff) return 'Italy';
  if (num >= 0x340000 && num <= 0x37ffff) return 'Spain';
  if (num >= 0x480000 && num <= 0x487fff) return 'Netherlands';
  return 'International';
}

/**
 * Classify whether an aircraft is military using ADSBx dbFlags, ICAO 24-bit hex ranges,
 * and military callsign prefixes.
 */
export function classifyMilitary(
  hex: string,
  callsign?: string | null,
  dbFlags?: number | null
): boolean {
  if (typeof dbFlags === 'number' && Number.isFinite(dbFlags) && (dbFlags & 1) !== 0) {
    return true;
  }

  const cleanHex = typeof hex === 'string' ? hex.trim().replace(/^~/, '') : '';
  if (/^[0-9a-fA-F]{6}$/.test(cleanHex)) {
    const val = Number.parseInt(cleanHex, 16);
    for (const [minHex, maxHex] of MILITARY_HEX_RANGES) {
      if (val >= minHex && val <= maxHex) {
        return true;
      }
    }
  }

  const cleanCall = typeof callsign === 'string' ? callsign.trim().toUpperCase() : '';
  if (cleanCall && MILITARY_CALLSIGN_REGEX.test(cleanCall)) {
    return true;
  }

  return false;
}

function classifyAirframeClass(
  aircraftType: string | undefined,
  emitterCategory: string | undefined,
  isMilitary: boolean,
  speedMs: number
): FlightEntity['airframeClass'] {
  const t = (aircraftType ?? '').toUpperCase().trim();
  const cat = (emitterCategory ?? '').toUpperCase().trim();

  if (cat === 'A7' || HELI_TYPE_PREFIXES.has(t) || HELI_TYPE_PREFIXES.has(t.slice(0, 4))) {
    return 'heli';
  }
  if (isMilitary) {
    if (
      FAST_MIL_TYPE_PREFIXES.has(t) ||
      FAST_MIL_TYPE_PREFIXES.has(t.slice(0, 3)) ||
      speedMs > 220
    ) {
      return 'fast-mil';
    }
    return 'fast-mil';
  }
  if (
    cat === 'A5' ||
    HEAVY_TYPE_PREFIXES.has(t) ||
    HEAVY_TYPE_PREFIXES.has(t.slice(0, 3))
  ) {
    return 'heavy';
  }
  if (
    cat === 'A1' ||
    PROP_TYPE_PREFIXES.has(t) ||
    PROP_TYPE_PREFIXES.has(t.slice(0, 4)) ||
    (speedMs > 5 && speedMs < 90 && !t.startsWith('B7') && !t.startsWith('A3'))
  ) {
    return 'prop';
  }
  return 'jet';
}

function appendTrailPoint(
  prev: FlightEntity | undefined,
  lon: number,
  lat: number,
  altM: number,
  ts: number
): TrailPoint[] {
  const base = prev?.trail ? [...prev.trail] : [];
  const last = base[base.length - 1];
  if (
    !last ||
    Math.abs(last.lat - lat) > 1e-5 ||
    Math.abs(last.lon - lon) > 1e-5 ||
    Math.abs(ts - last.ts) > 1500
  ) {
    base.push({ lon, lat, altM, ts });
  }
  if (base.length > MAX_TRAIL_POINTS) {
    return base.slice(base.length - MAX_TRAIL_POINTS);
  }
  return base;
}

function extractEmergencyFlag(squawk?: string, rawEmergency?: unknown): string | undefined {
  if (squawk === '7700') return 'SQUAWK 7700 · EMERGENCY';
  if (squawk === '7600') return 'SQUAWK 7600 · COMMS LOSS';
  if (squawk === '7500') return 'SQUAWK 7500 · HIJACK';
  if (
    typeof rawEmergency === 'string' &&
    rawEmergency.trim() !== '' &&
    rawEmergency.trim().toLowerCase() !== 'none'
  ) {
    return `EMERG · ${rawEmergency.trim().toUpperCase()}`;
  }
  return undefined;
}

function asFiniteNumber(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function asCleanString(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Normalize an ADS-B Exchange v2 aircraft object (airplanes.live / adsb.lol / adsb.fi)
 * into a FlightEntity. Returns null when required hex or coordinates are missing/invalid.
 */
export function normalizeAdsbxAircraft(
  raw: RawAdsbxAircraft,
  observer: ObserverLocation,
  prev?: FlightEntity,
  nowMs = Date.now()
): FlightEntity | null {
  if (!raw || typeof raw !== 'object') return null;

  const rawHex = asCleanString(raw.hex)?.toLowerCase();
  if (!rawHex || !/^~?[0-9a-f]{4,8}$/.test(rawHex)) {
    return null;
  }

  const lat = asFiniteNumber(raw.lat);
  const lon = asFiniteNumber(raw.lon);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  const onGround = raw.alt_baro === 'ground' || raw.ground === true;
  const baroFt = typeof raw.alt_baro === 'number' && Number.isFinite(raw.alt_baro) ? raw.alt_baro : undefined;
  const geomFt = asFiniteNumber(raw.alt_geom);

  const altBaroM = onGround ? 0 : baroFt !== undefined ? baroFt * FT_TO_M : undefined;
  const altGeomM = geomFt !== undefined ? geomFt * FT_TO_M : undefined;
  const altM = onGround
    ? altGeomM !== undefined
      ? Math.max(0, altGeomM)
      : 0
    : altGeomM !== undefined
      ? altGeomM
      : altBaroM !== undefined
        ? Math.max(0, altBaroM)
        : 0;

  const speedKts =
    asFiniteNumber(raw.gs) ?? asFiniteNumber(raw.tas) ?? asFiniteNumber(raw.ias) ?? 0;
  const speedMs = speedKts > 0 ? speedKts * KNOTS_TO_MS : 0;

  const rawHeading =
    asFiniteNumber(raw.track) ??
    asFiniteNumber(raw.true_heading) ??
    asFiniteNumber(raw.mag_heading) ??
    asFiniteNumber(raw.calc_track) ??
    0;
  const headingDeg = normalizeAzimuthDeg(rawHeading);

  const rateFpm = asFiniteNumber(raw.baro_rate) ?? asFiniteNumber(raw.geom_rate) ?? 0;
  const vertRateMs = rateFpm * FPM_TO_MS;

  const registration = asCleanString(raw.r);
  const aircraftType = asCleanString(raw.t);
  const callsign =
    asCleanString(raw.flight) ?? registration ?? rawHex.toUpperCase();

  const dbFlags = asFiniteNumber(raw.dbFlags);
  const isMilitary = classifyMilitary(rawHex, callsign, dbFlags);
  const isPia = dbFlags !== undefined ? (dbFlags & 4) !== 0 : undefined;
  const isLadd = dbFlags !== undefined ? (dbFlags & 8) !== 0 : undefined;

  const squawkRaw =
    typeof raw.squawk === 'number' && Number.isFinite(raw.squawk)
      ? String(raw.squawk).padStart(4, '0')
      : asCleanString(raw.squawk);
  const emitterCat = asCleanString(raw.category);
  const airframeClass = classifyAirframeClass(aircraftType, emitterCat, isMilitary, speedMs);

  const seenSec = Math.max(0, asFiniteNumber(raw.seen_pos) ?? asFiniteNumber(raw.seen) ?? 0);
  const timestampMs = nowMs - seenSec * 1000;

  const topocentric = computeTopocentricLookAngles(observer, { lat, lon, altM });
  const trail = appendTrailPoint(prev, lon, lat, altM, timestampMs);
  const emergencyFlag = extractEmergencyFlag(squawkRaw, raw.emergency);
  const country = asCleanString(raw.ownOp) ?? deriveCountryFromIcaoHex(rawHex);

  const subtitleParts = [
    aircraftType,
    registration && registration !== callsign ? registration : undefined,
    squawkRaw ? `SQK ${squawkRaw}` : undefined,
  ].filter(Boolean);

  return {
    id: `flight:${rawHex}`,
    category: isMilitary ? 'military' : 'flight',
    callsign,
    subtitle: subtitleParts.join(' · ') || (isMilitary ? 'Military Aircraft' : 'ADS-B Target'),
    country,
    lat,
    lon: normalizeLonDeg(lon),
    altM,
    altBaroM,
    speedMs,
    headingDeg,
    vertRateMs,
    timestampMs,
    topocentric,
    trail,
    emergencyFlag,
    icaoHex: rawHex,
    registration,
    aircraftType,
    squawk: squawkRaw,
    onGround,
    isMilitary,
    isLadd,
    isPia,
    airframeClass,
  };
}

/**
 * Normalize an OpenSky Network `/api/states/all` 17-element tuple into a FlightEntity.
 * Returns null when tuple shape, icao24, or coordinates are invalid.
 */
export function normalizeOpenSkyState(
  tuple: unknown[],
  observer: ObserverLocation,
  prev?: FlightEntity
): FlightEntity | null {
  if (!Array.isArray(tuple) || tuple.length < 11) return null;

  const rawHex = asCleanString(tuple[0])?.toLowerCase();
  if (!rawHex || !/^[0-9a-f]{4,8}$/.test(rawHex)) {
    return null;
  }

  const lon = asFiniteNumber(tuple[5]);
  const lat = asFiniteNumber(tuple[6]);
  if (lat === undefined || lon === undefined || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }

  const onGround = Boolean(tuple[8]);
  const baroAltM = asFiniteNumber(tuple[7]);
  const geoAltM = tuple.length > 13 ? asFiniteNumber(tuple[13]) : undefined;
  const altM = onGround
    ? geoAltM !== undefined
      ? Math.max(0, geoAltM)
      : 0
    : geoAltM !== undefined
      ? geoAltM
      : baroAltM !== undefined
        ? Math.max(0, baroAltM)
        : 0;

  const rawSpeed = asFiniteNumber(tuple[9]);
  const speedMs = rawSpeed !== undefined && rawSpeed >= 0 ? rawSpeed : 0;

  const rawTrack = asFiniteNumber(tuple[10]);
  const headingDeg = rawTrack !== undefined ? normalizeAzimuthDeg(rawTrack) : 0;

  const vertRateMs = tuple.length > 11 ? (asFiniteNumber(tuple[11]) ?? 0) : 0;
  const callsign = asCleanString(tuple[1]) ?? rawHex.toUpperCase();
  const country = asCleanString(tuple[2]) ?? deriveCountryFromIcaoHex(rawHex);
  const squawk = tuple.length > 14 ? asCleanString(tuple[14]) : undefined;

  const timePosSec = asFiniteNumber(tuple[3]) ?? asFiniteNumber(tuple[4]);
  const timestampMs = timePosSec !== undefined ? timePosSec * 1000 : Date.now();

  const isMilitary = classifyMilitary(rawHex, callsign, 0);
  const airframeClass = classifyAirframeClass(undefined, undefined, isMilitary, speedMs);
  const topocentric = computeTopocentricLookAngles(observer, { lat, lon, altM });
  const trail = appendTrailPoint(prev, lon, lat, altM, timestampMs);
  const emergencyFlag = extractEmergencyFlag(squawk);

  return {
    id: `flight:${rawHex}`,
    category: isMilitary ? 'military' : 'flight',
    callsign,
    subtitle: [country, squawk ? `SQK ${squawk}` : undefined].filter(Boolean).join(' · ') || 'OpenSky Target',
    country,
    lat,
    lon: normalizeLonDeg(lon),
    altM,
    altBaroM: onGround ? 0 : baroAltM,
    speedMs,
    headingDeg,
    vertRateMs,
    timestampMs,
    topocentric,
    trail,
    emergencyFlag,
    icaoHex: rawHex,
    squawk,
    onGround,
    isMilitary,
    airframeClass,
  };
}

function isLocalhostRuntime(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function toPrevMap(prevEntities?: Map<string, FlightEntity> | FlightEntity[]): Map<string, FlightEntity> {
  if (!prevEntities) return new Map();
  if (prevEntities instanceof Map) return prevEntities;
  const map = new Map<string, FlightEntity>();
  for (const item of prevEntities) {
    map.set(item.id, item);
  }
  return map;
}

function normalizeAdsbxPayloadList(
  rawList: unknown[],
  observer: ObserverLocation,
  prevMap: Map<string, FlightEntity>,
  radiusKm: number,
  nowMs: number
): FlightEntity[] {
  const entities: FlightEntity[] = [];
  const seenIds = new Set<string>();
  const maxDistKm = radiusKm * 1.05;

  for (const item of rawList) {
    const normalized = normalizeAdsbxAircraft(
      item as RawAdsbxAircraft,
      observer,
      prevMap.get(`flight:${String((item as RawAdsbxAircraft)?.hex ?? '').trim().toLowerCase()}`),
      nowMs
    );
    if (!normalized) continue;
    if (seenIds.has(normalized.id)) continue;
    if (normalized.topocentric.groundDistKm <= maxDistKm) {
      seenIds.add(normalized.id);
      entities.push(normalized);
    }
  }
  return entities;
}

interface FallbackSeedEnvelope {
  origin?: { lat?: number; lon?: number };
  anchor?: { lat?: number; lon?: number };
  ac?: RawAdsbxAircraft[];
  aircraft?: RawAdsbxAircraft[];
}

const BUILTIN_FALLBACK_SEED: RawAdsbxAircraft[] = [
  { hex: 'a12f44', flight: 'UAL418', r: 'N37418', t: 'B738', dLat: 0.14, dLon: -0.18, alt_baro: 18500, alt_geom: 18750, gs: 385, track: 68, baro_rate: 1200, squawk: '1241', category: 'A3' },
  { hex: 'ae5120', flight: 'RCH842', r: '08-8194', t: 'C17', dLat: -0.19, dLon: 0.22, alt_baro: 24000, alt_geom: 24200, gs: 440, track: 295, baro_rate: -450, squawk: '4412', dbFlags: 1, category: 'A5' },
  { hex: 'a8b201', flight: 'DAL902', r: 'N821DN', t: 'A359', dLat: 0.31, dLon: 0.28, alt_baro: 36000, alt_geom: 36400, gs: 485, track: 135, baro_rate: 0, squawk: '2104', category: 'A5' },
  { hex: 'a44110', flight: 'N410PD', r: 'N410PD', t: 'EC35', dLat: -0.06, dLon: -0.08, alt_baro: 1450, alt_geom: 1500, gs: 112, track: 190, baro_rate: 0, squawk: '1200', category: 'A7' },
  { hex: 'a0991c', flight: 'N172SP', r: 'N172SP', t: 'C172', dLat: 0.08, dLon: 0.09, alt_baro: 3500, alt_geom: 3600, gs: 108, track: 35, baro_rate: 250, squawk: '1200', category: 'A1' },
];

async function buildStaticFallbackResult(
  observer: ObserverLocation,
  radiusKm: number,
  prevMap: Map<string, FlightEntity>,
  errorMsg?: string,
  signal?: AbortSignal
): Promise<FlightsFetchResult> {
  const nowMs = Date.now();
  let rawItems: RawAdsbxAircraft[] = BUILTIN_FALLBACK_SEED;
  let originLat = 38.8512;
  let originLon = -77.0402;

  try {
    const data = await fetchJsonWithTimeout<FallbackSeedEnvelope>('./data/fallback-flights.json', {
      timeoutMs: 3000,
      signal,
    });
    if (data && typeof data === 'object') {
      if (typeof data.origin?.lat === 'number' && Number.isFinite(data.origin.lat)) {
        originLat = data.origin.lat;
      } else if (typeof data.anchor?.lat === 'number' && Number.isFinite(data.anchor.lat)) {
        originLat = data.anchor.lat;
      }
      if (typeof data.origin?.lon === 'number' && Number.isFinite(data.origin.lon)) {
        originLon = data.origin.lon;
      } else if (typeof data.anchor?.lon === 'number' && Number.isFinite(data.anchor.lon)) {
        originLon = data.anchor.lon;
      }

      const candidate = Array.isArray(data.ac)
        ? data.ac
        : Array.isArray(data.aircraft)
          ? data.aircraft
          : null;
      if (candidate && candidate.length > 0) {
        rawItems = candidate;
      }
    }
  } catch {
    // Keep built-in emergency fallback array when static JSON cannot be loaded.
  }

  const entities: FlightEntity[] = [];
  const maxAllowedRadiusKm = Math.max(8, radiusKm * 0.92);

  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    let dLat = asFiniteNumber(item.dLat);
    let dLon = asFiniteNumber(item.dLon);

    if (dLat === undefined || dLon === undefined) {
      const itemLat = asFiniteNumber(item.lat);
      const itemLon = asFiniteNumber(item.lon);
      if (itemLat !== undefined && itemLon !== undefined) {
        dLat = itemLat - originLat;
        dLon = itemLon - originLon;
      }
    }
    if (dLat === undefined || dLon === undefined) continue;

    // Scale oversized snapshot offsets smoothly if observer scan radius is tight.
    const cosLat = Math.max(0.15, Math.cos((observer.lat * Math.PI) / 180));
    const approxKm = Math.hypot(dLat * 111.32, dLon * 111.32 * cosLat);
    if (approxKm > maxAllowedRadiusKm && approxKm > 0) {
      const scale = maxAllowedRadiusKm / approxKm;
      dLat *= scale;
      dLon *= scale;
    }

    const lat = Math.max(-89.9, Math.min(89.9, observer.lat + dLat));
    const lon = normalizeLonDeg(observer.lon + dLon);

    const normalized = normalizeAdsbxAircraft(
      { ...item, lat, lon, seen_pos: 0, seen: 0 },
      observer,
      prevMap.get(`flight:${String(item.hex ?? '').trim().toLowerCase()}`),
      nowMs
    );
    if (normalized) {
      entities.push(normalized);
    }
  }

  return {
    entities,
    status: 'fallback',
    provider: 'seeded-snapshot',
    timestampMs: nowMs,
    errorMsg,
  };
}

/**
 * Multi-tier zero-key ADS-B cascade:
 * 1) Local Vite proxies (localhost/127.0.0.1 only)
 * 2) Direct browser cascade (airplanes.live -> adsb.lol -> opensky-network.org)
 * 3) Schema-validated CORS relay (api.codetabs.com -> adsb.lol)
 * 4) Relative-translated static snapshot (./data/fallback-flights.json)
 */
export async function fetchFlightsCascade(
  observer: ObserverLocation,
  radiusKm: number,
  prevEntities?: Map<string, FlightEntity> | FlightEntity[],
  options: FlightsFetchOptions = {}
): Promise<FlightsFetchResult> {
  const prevMap = toPrevMap(prevEntities);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ADSB_TIMEOUT_MS;
  const latStr = observer.lat.toFixed(4);
  const lonStr = observer.lon.toFixed(4);
  const radiusNm = Math.max(1, Math.min(250, Math.round(radiusKm / 1.852)));
  const rateKey = options.rateLimitKey ?? `adsb:${observer.lat.toFixed(2)},${observer.lon.toFixed(2)}`;

  if (!options.force && !adsbRateLimiter.tryConsume(rateKey)) {
    const cached = lastCachedFlightsByKey.get(rateKey);
    if (cached) {
      return {
        entities: cached.entities,
        status: 'cached',
        provider: cached.provider,
        timestampMs: cached.timestampMs,
      };
    }
    if (prevMap.size > 0) {
      return {
        entities: Array.from(prevMap.values()),
        status: 'cached',
        provider: 'rate-limit-cache',
        timestampMs: Date.now(),
      };
    }
  }

  const errors: string[] = [];
  let sawEmptyLiveResponse = false;
  let emptyLiveProvider = '';

  const tryAdsbxEndpoint = async (
    breakerKey: string,
    providerLabel: string,
    url: string,
    strictAcOnly = false
  ): Promise<FlightsFetchResult | null> => {
    if (!flightsCircuitBreaker.canExecute(breakerKey)) {
      return null;
    }
    try {
      const data = await flightsCircuitBreaker.execute(
        () =>
          fetchJsonWithTimeout<Record<string, unknown>>(url, {
            timeoutMs,
            signal: options.signal,
          }),
        breakerKey
      );
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid payload from ${providerLabel}`);
      }
      const rawList = Array.isArray(data.ac)
        ? data.ac
        : !strictAcOnly && Array.isArray(data.aircraft)
          ? data.aircraft
          : null;
      if (!rawList) {
        throw new Error(`Missing ac[] schema from ${providerLabel}`);
      }
      const nowMs = Date.now();
      const entities = normalizeAdsbxPayloadList(rawList, observer, prevMap, radiusKm, nowMs);
      if (entities.length === 0) {
        sawEmptyLiveResponse = true;
        emptyLiveProvider = providerLabel;
        return null;
      }
      lastCachedFlightsByKey.set(rateKey, {
        entities,
        provider: providerLabel,
        timestampMs: nowMs,
      });
      return {
        entities,
        status: 'live',
        provider: providerLabel,
        timestampMs: nowMs,
      };
    } catch (err) {
      errors.push(`${providerLabel}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };

  // Stage 1: Local Vite proxies when running on localhost / 127.0.0.1
  if (isLocalhostRuntime()) {
    const proxyLol = await tryAdsbxEndpoint(
      'proxy-adsb-lol',
      'vite-proxy:adsb.lol',
      `/api-proxy/adsb-lol/v2/point/${latStr}/${lonStr}/${radiusNm}`
    );
    if (proxyLol) return proxyLol;

    const proxyFi = await tryAdsbxEndpoint(
      'proxy-adsb-fi',
      'vite-proxy:adsb.fi',
      `/api-proxy/adsb-fi/api/v2/lat/${latStr}/lon/${lonStr}/dist/${radiusNm}`
    );
    if (proxyFi) return proxyFi;
  }

  // Stage 2: Direct browser cascade
  const directAirplanesLive = await tryAdsbxEndpoint(
    'airplanes.live',
    'airplanes.live',
    `https://api.airplanes.live/v2/point/${latStr}/${lonStr}/${radiusNm}`
  );
  if (directAirplanesLive) return directAirplanesLive;

  const directAdsbLol = await tryAdsbxEndpoint(
    'adsb.lol',
    'adsb.lol',
    `https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusNm}`
  );
  if (directAdsbLol) return directAdsbLol;

  // Stage 2c: OpenSky bounding box
  if (flightsCircuitBreaker.canExecute('opensky')) {
    try {
      const dLat = radiusKm / 111.32;
      const cosLat = Math.max(0.1, Math.cos((observer.lat * Math.PI) / 180));
      const dLon = radiusKm / (111.32 * cosLat);
      const lamin = Math.max(-90, observer.lat - dLat).toFixed(4);
      const lamax = Math.min(90, observer.lat + dLat).toFixed(4);
      const lomin = Math.max(-180, observer.lon - dLon).toFixed(4);
      const lomax = Math.min(180, observer.lon + dLon).toFixed(4);

      const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`;
      const data = await flightsCircuitBreaker.execute(
        () =>
          fetchJsonWithTimeout<{ states?: unknown }>(openSkyUrl, {
            timeoutMs,
            signal: options.signal,
          }),
        'opensky'
      );

      if (!data || typeof data !== 'object' || !Array.isArray(data.states)) {
        throw new Error('Invalid OpenSky states[] payload');
      }

      const entities: FlightEntity[] = [];
      const seenIds = new Set<string>();
      for (const row of data.states) {
        if (!Array.isArray(row)) continue;
        const hex = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
        const normalized = normalizeOpenSkyState(row, observer, prevMap.get(`flight:${hex}`));
        if (!normalized || seenIds.has(normalized.id)) continue;
        if (normalized.topocentric.groundDistKm <= radiusKm * 1.05) {
          seenIds.add(normalized.id);
          entities.push(normalized);
        }
      }

      const nowMs = Date.now();
      if (entities.length > 0) {
        lastCachedFlightsByKey.set(rateKey, {
          entities,
          provider: 'opensky-network',
          timestampMs: nowMs,
        });
        return {
          entities,
          status: 'live',
          provider: 'opensky-network',
          timestampMs: nowMs,
        };
      }
      sawEmptyLiveResponse = true;
      emptyLiveProvider = 'opensky-network';
    } catch (err) {
      errors.push(`opensky-network: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Stage 3: Zero-key CORS JSON relay targeting adsb.lol (strictly Array.isArray(data?.ac))
  const targetAdsbLolUrl = `https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusNm}`;
  const codetabsRelayUrl = `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(
    targetAdsbLolUrl
  )}`;
  const relayed = await tryAdsbxEndpoint(
    'codetabs-adsb-lol',
    'codetabs-relay:adsb.lol',
    codetabsRelayUrl,
    true
  );
  if (relayed) return relayed;

  if (sawEmptyLiveResponse) {
    return {
      entities: [],
      status: 'live',
      provider: emptyLiveProvider,
      timestampMs: Date.now(),
    };
  }

  // Stage 4: Relative static fallback snapshot
  return buildStaticFallbackResult(
    observer,
    radiusKm,
    prevMap,
    errors.length > 0 ? errors.join(' | ') : undefined,
    options.signal
  );
}
