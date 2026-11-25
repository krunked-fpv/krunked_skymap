import type {
  AdsbSourceFeed,
  AirspaceData,
  BalloonEntity,
  DroneEntity,
  FeedHealthStatus,
  FlightEntity,
  ObserverLocation,
  TrailPoint,
} from '../types/sky-contracts';
import { evaluateDroneAirspaceCompliance } from './airspaceService';
import {
  computeBearingDeg,
  computeTopocentricLookAngles,
  haversineDistanceKm,
  normalizeAzimuthDeg,
  normalizeLonDeg,
} from './geoHelpers';
import {
  CircuitBreaker,
  HttpError,
  TokenBucketRateLimiter,
  extractRelayedJsonValue,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  isHtmlPayload,
  isLocalDevOrLanRuntime,
  throwIfUpstreamErrorField,
} from './httpClient';
import { isTeslaBrowser, resolveAdaptiveTimeoutMs } from './teslaCompat';

export { isLocalDevOrLanRuntime } from './httpClient';

const FT_TO_M = 0.3048;
const KNOTS_TO_MS = 0.514444;
const FPM_TO_MS = 0.00508;
const MAX_TRAIL_POINTS = 24;
const DEFAULT_ADSB_TIMEOUT_MS = 3500;
const RELAY_ADSB_TIMEOUT_MS = 6500;
const ADSBX_MAX_ALT_M = 70_000;
const OPENSKY_MAX_ALT_M = 60_000;

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
}

export interface FlightsFetchOptions {
  force?: boolean;
  resetBreakers?: boolean;
  rateLimitKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  airspace?: AirspaceData;
  prevDrones?: Map<string, DroneEntity> | DroneEntity[];
  prevBalloons?: Map<string, BalloonEntity> | BalloonEntity[];
}

export interface FlightsFetchResult {
  entities: FlightEntity[];
  uasEntities?: DroneEntity[];
  balloonEntities?: BalloonEntity[];
  status: FeedHealthStatus;
  provider: string;
  timestampMs: number;
  errorMsg?: string;
  httpStatus?: number;
}

export interface GlobalFlightsFetchResult extends FlightsFetchResult {
  sourceCounts: {
    mil: number;
    ladd: number;
    pia: number;
  };
}

export const adsbRateLimiter = new TokenBucketRateLimiter({
  minIntervalMs: 10_000,
  capacity: 1,
});

export const flightsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
});

export const globalAdsbRateLimiter = new TokenBucketRateLimiter({
  minIntervalMs: 15_000,
  capacity: 1,
});

export const globalFlightsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 45_000,
});

interface CachedFlightsEntry {
  entities: FlightEntity[];
  uasEntities: DroneEntity[];
  balloonEntities: BalloonEntity[];
  status: 'live' | 'delayed' | 'rate-limited' | 'offline' | 'error';
  provider: string;
  timestampMs: number;
  errorMsg?: string;
  httpStatus?: number;
}

interface CachedGlobalFlightsEntry extends CachedFlightsEntry {
  sourceCounts: {
    mil: number;
    ladd: number;
    pia: number;
  };
}

const lastCachedFlightsByKey = new Map<string, CachedFlightsEntry>();
const lastCachedGlobalFlightsByKey = new Map<string, CachedGlobalFlightsEntry>();

let viteProxyUnavailable = false;
let globalViteProxyUnavailable = false;

export function clearFlightsServiceCache(): void {
  lastCachedFlightsByKey.clear();
  adsbRateLimiter.reset();
  flightsCircuitBreaker.reset();
  viteProxyUnavailable = false;

  lastCachedGlobalFlightsByKey.clear();
  globalAdsbRateLimiter.reset();
  globalFlightsCircuitBreaker.reset();
  globalViteProxyUnavailable = false;
}

const MILITARY_HEX_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xadf7c8, 0xafffff], // US DoD / Military (above civil N1..N99999 block)
  [0x43c000, 0x43cfff], // UK Military (RAF / RN / AAC)
  [0x3f4000, 0x3fbfff], // Germany Military (Luftwaffe)
  [0x3ea000, 0x3ebfff], // Germany Military secondary allocation
  [0x7cf800, 0x7cffff], // Australia Military (RAAF)
  [0x4d0000, 0x4d03ff], // NATO E-3A / Luxembourg NATO
  [0xc0cdf9, 0xc0ffff], // Canada Military (RCAF)
  [0x3b0000, 0x3bffff], // France Military
];

const MILITARY_TYPE_CODES = new Set([
  'C17',
  'C130',
  'C30J',
  'KC35',
  'K35R',
  'KC46',
  'F15',
  'F16',
  'F18',
  'F22',
  'F35',
  'T38',
  'T6',
  'B52',
  'B1',
  'B2',
  'E3CF',
  'E6',
  'E2',
  'P8',
  'V22',
  'H60',
  'UH60',
  'MH60',
  'CH47',
  'AH64',
  'C5M',
  'A10',
  'U2',
  'EUFI',
  'RFAL',
  'A400',
  'P3',
  'MQ9',
  'RQ4',
  'MQ4C',
  'MQ1',
  'RQ7',
  'K35E',
  'RC35',
  'E3TF',
  'E8',
  'C40',
  'C32',
  'C37',
  'VC25',
]);

const MILITARY_CALLSIGN_REGEX =
  /^(?:RCH\d|REACH\d?|SAM\d+|AF[12]$|SPAR\d+|PAT\d+|CNV\d+|CONVOY|NAVY\d*|USAF\d*|USCG\d*|ARMY\d*|ASCOT\d*|RRR\d+|BAF\d+|GAF\d+|FAF\d+|IAM\d+|CFC\d+|ASY\d+|RAAF\d*|TOPGUN|TEAL\d+|SENTRY\d*|DOOM\d+|BONE\d+|NOBLE\d+|HAWK\d+|VIPER\d+|WARHAWK|GOLD\d+|LAGR\d+|NCHO\d+|HOBO\d+|DUKE\d+|KING\d+|JOLLY\d+|PEDRO\d+|CHAOS\d+|EVAC\d+|JANET\d+|COAST\d*|ORDER\d*|NATO\d*)/;

const UAS_TYPE_CODES = new Set([
  'MQ9',
  'RQ4',
  'MQ4C',
  'MQ1',
  'RQ7',
  'HERM',
  'HRON',
  'TB2',
  'S100',
  'SCAN',
  'UAV',
  'DRON',
]);

const FIXED_WING_UAS_TYPES = new Set([
  'MQ9',
  'RQ4',
  'MQ4C',
  'MQ1',
  'HERM',
  'HRON',
  'TB2',
  'SCAN',
]);

const UAS_CALLSIGN_REGEX = /^(?:UAV|UAS|RPAS|REAPER|FORTE|GHWK|TRITON)\d*/;
const LTA_CALLSIGN_REGEX = /^(?:HBAL|STRAT)\d*/;

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
  'MH60',
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
  'C130',
  'C30J',
  'KC10',
  'KC35',
  'K35R',
  'K35E',
  'RC35',
  'KC46',
  'KC135',
  'E3',
  'E3CF',
  'E3TF',
  'E4',
  'E6',
  'E8',
  'P8',
  'P3',
  'A400',
  'B52',
  'B1',
  'B2',
  'C40',
  'C32',
  'VC25',
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
 * military ICAO type codes, and military callsign prefixes.
 */
export function classifyMilitary(
  hex: string,
  callsign?: string | null,
  dbFlags?: number | null,
  aircraftType?: string | null
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

  const cleanType = typeof aircraftType === 'string' ? aircraftType.trim().toUpperCase() : '';
  if (cleanType && MILITARY_TYPE_CODES.has(cleanType)) {
    return true;
  }

  const cleanCall = typeof callsign === 'string' ? callsign.trim().toUpperCase() : '';
  if (cleanCall && MILITARY_CALLSIGN_REGEX.test(cleanCall)) {
    return true;
  }

  return false;
}

const AIRFRAME_SPECIFICITY_RANK: Record<FlightEntity['airframeClass'], number> = {
  heli: 5,
  heavy: 4,
  'fast-mil': 3,
  prop: 2,
  jet: 1,
};

export function pickRicherAirframeClass(
  a: FlightEntity['airframeClass'],
  b: FlightEntity['airframeClass']
): FlightEntity['airframeClass'] {
  return (AIRFRAME_SPECIFICITY_RANK[a] ?? 0) >= (AIRFRAME_SPECIFICITY_RANK[b] ?? 0) ? a : b;
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
  if (
    cat === 'A5' ||
    HEAVY_TYPE_PREFIXES.has(t) ||
    HEAVY_TYPE_PREFIXES.has(t.slice(0, 4)) ||
    HEAVY_TYPE_PREFIXES.has(t.slice(0, 3))
  ) {
    return 'heavy';
  }
  if (isMilitary) {
    return 'fast-mil';
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
  prevTrail: TrailPoint[] | undefined,
  lon: number,
  lat: number,
  altM: number,
  ts: number
): TrailPoint[] {
  const normLon = normalizeLonDeg(lon);
  const newPoint: TrailPoint = { lon: normLon, lat, altM, ts };
  const base = prevTrail ? [...prevTrail] : [];
  const last = base[base.length - 1];
  if (!last) {
    return [newPoint];
  }
  if (
    ts - last.ts > 90_000 ||
    haversineDistanceKm(last.lat, last.lon, lat, normLon) > 25
  ) {
    return [newPoint];
  }
  if (
    Math.abs(last.lat - lat) > 1e-5 ||
    Math.abs(last.lon - normLon) > 1e-5 ||
    Math.abs(ts - last.ts) > 1500
  ) {
    base.push(newPoint);
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

function isValidGeoPoint(lat: number | undefined, lon: number | undefined): boolean {
  if (
    lat === undefined ||
    lon === undefined ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return false;
  }
  return !(Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4);
}

function resolveValidatedAltitudeM(
  onGround: boolean,
  altBaroM: number | undefined,
  altGeomM: number | undefined,
  maxAltM = ADSBX_MAX_ALT_M
): number | null {
  if (
    (altBaroM !== undefined && (altBaroM < -500 || altBaroM > maxAltM)) ||
    (altGeomM !== undefined && (altGeomM < -500 || altGeomM > maxAltM))
  ) {
    return null;
  }
  const altM = onGround
    ? altGeomM !== undefined
      ? Math.max(0, altGeomM)
      : 0
    : altGeomM !== undefined
      ? altGeomM
      : altBaroM !== undefined
        ? Math.max(0, altBaroM)
        : 0;
  return altM < -500 || altM > maxAltM ? null : altM;
}

function resolveHeading(
  rawTrack: number | undefined,
  prev: { lat: number; lon: number } | undefined,
  lat: number,
  normLon: number
): { headingDeg: number; headingValid: boolean } {
  if (rawTrack !== undefined) {
    return { headingDeg: normalizeAzimuthDeg(rawTrack), headingValid: true };
  }
  if (prev && haversineDistanceKm(prev.lat, prev.lon, lat, normLon) > 0.05) {
    return {
      headingDeg: normalizeAzimuthDeg(computeBearingDeg(prev.lat, prev.lon, lat, normLon)),
      headingValid: true,
    };
  }
  return { headingDeg: 0, headingValid: false };
}

interface ParsedAdsbxCore {
  rawHex: string;
  safeLat: number;
  normLon: number;
  onGround: boolean;
  altM: number;
  altBaroM?: number;
  speedMs: number;
  headingDeg: number;
  headingValid: boolean;
  vertRateMs: number;
  registration?: string;
  aircraftType?: string;
  callsign: string;
  isMilitary: boolean;
  isPia?: boolean;
  isLadd?: boolean;
  squawkRaw?: string;
  emitterCat?: string;
  timestampMs: number;
  topocentric: ReturnType<typeof computeTopocentricLookAngles>;
  emergencyFlag?: string;
  country: string;
  sourceFeed?: AdsbSourceFeed;
  rawEmergency: unknown;
}

function parseAdsbxCore(
  raw: RawAdsbxAircraft,
  observer: ObserverLocation,
  prevCoord: { lat: number; lon: number } | undefined,
  nowMs: number,
  sourceFeed?: AdsbSourceFeed
): ParsedAdsbxCore | null {
  if (!raw || typeof raw !== 'object') return null;

  const rawHex = asCleanString(raw.hex)?.toLowerCase();
  if (!rawHex || !/^~?[0-9a-f]{4,8}$/.test(rawHex)) {
    return null;
  }

  const lat = asFiniteNumber(raw.lat);
  const lon = asFiniteNumber(raw.lon);
  if (!isValidGeoPoint(lat, lon)) {
    return null;
  }
  const safeLat = lat as number;
  const normLon = normalizeLonDeg(lon as number);

  const onGround = raw.alt_baro === 'ground' || raw.ground === true;
  const baroFt = asFiniteNumber(raw.alt_baro);
  const geomFt = asFiniteNumber(raw.alt_geom);

  const altBaroM = onGround ? 0 : baroFt !== undefined ? baroFt * FT_TO_M : undefined;
  const altGeomM = geomFt !== undefined ? geomFt * FT_TO_M : undefined;
  const altM = resolveValidatedAltitudeM(onGround, altBaroM, altGeomM, ADSBX_MAX_ALT_M);
  if (altM === null) {
    return null;
  }

  const rawSpeedKts =
    asFiniteNumber(raw.gs) ?? asFiniteNumber(raw.tas) ?? asFiniteNumber(raw.ias);
  const speedMs = rawSpeedKts !== undefined ? rawSpeedKts * KNOTS_TO_MS : 0;
  if (speedMs < 0 || speedMs > 1200) {
    return null;
  }

  const rawTrack =
    asFiniteNumber(raw.track) ??
    asFiniteNumber(raw.true_heading) ??
    asFiniteNumber(raw.mag_heading) ??
    asFiniteNumber(raw.calc_track);
  const { headingDeg, headingValid } = resolveHeading(rawTrack, prevCoord, safeLat, normLon);

  const rateFpm = asFiniteNumber(raw.baro_rate) ?? asFiniteNumber(raw.geom_rate) ?? 0;
  const vertRateMs = rateFpm * FPM_TO_MS;

  const registration = asCleanString(raw.r);
  const aircraftType = asCleanString(raw.t);
  const callsign =
    asCleanString(raw.flight) ?? registration ?? rawHex.toUpperCase();

  const dbFlags = asFiniteNumber(raw.dbFlags);
  const isMilitary =
    classifyMilitary(rawHex, callsign, dbFlags, aircraftType) || sourceFeed === 'mil';
  const isPia =
    sourceFeed === 'pia'
      ? true
      : dbFlags !== undefined
        ? (dbFlags & 4) !== 0
        : undefined;
  const isLadd =
    sourceFeed === 'ladd'
      ? true
      : dbFlags !== undefined
        ? (dbFlags & 8) !== 0
        : undefined;

  const squawkRaw =
    typeof raw.squawk === 'number' && Number.isFinite(raw.squawk)
      ? String(raw.squawk).padStart(4, '0')
      : asCleanString(raw.squawk);
  const emitterCat = asCleanString(raw.category);

  const seenSec = Math.max(0, asFiniteNumber(raw.seen_pos) ?? asFiniteNumber(raw.seen) ?? 0);
  const timestampMs = nowMs - seenSec * 1000;

  const topocentric = computeTopocentricLookAngles(observer, {
    lat: safeLat,
    lon: normLon,
    altM,
  });
  const emergencyFlag = extractEmergencyFlag(squawkRaw, raw.emergency);
  const country = asCleanString(raw.ownOp) ?? deriveCountryFromIcaoHex(rawHex);

  return {
    rawHex,
    safeLat,
    normLon,
    onGround,
    altM,
    altBaroM,
    speedMs,
    headingDeg,
    headingValid,
    vertRateMs,
    registration,
    aircraftType,
    callsign,
    isMilitary,
    isPia,
    isLadd,
    squawkRaw,
    emitterCat,
    timestampMs,
    topocentric,
    emergencyFlag,
    country,
    sourceFeed,
    rawEmergency: raw.emergency,
  };
}

function buildFlightFromCore(
  core: ParsedAdsbxCore,
  prev: FlightEntity | undefined
): FlightEntity {
  const airframeClass = classifyAirframeClass(
    core.aircraftType,
    core.emitterCat,
    core.isMilitary,
    core.speedMs
  );
  const trail = appendTrailPoint(
    prev?.trail,
    core.normLon,
    core.safeLat,
    core.altM,
    core.timestampMs
  );
  const category: FlightEntity['category'] =
    core.isMilitary || (!core.onGround && (core.isLadd || core.isPia))
      ? 'military'
      : 'flight';

  const subtitleParts = [
    core.aircraftType,
    core.registration && core.registration !== core.callsign ? core.registration : undefined,
    core.squawkRaw ? `SQK ${core.squawkRaw}` : undefined,
  ].filter(Boolean);

  return {
    id: `flight:${core.rawHex}`,
    category,
    callsign: core.callsign,
    subtitle:
      subtitleParts.join(' · ') ||
      (category === 'military' ? 'Military Aircraft' : 'ADS-B Target'),
    country: core.country,
    lat: core.safeLat,
    lon: core.normLon,
    altM: core.altM,
    altBaroM: core.altBaroM,
    speedMs: core.speedMs,
    headingDeg: core.headingDeg,
    headingValid: core.headingValid,
    vertRateMs: core.vertRateMs,
    timestampMs: core.timestampMs,
    topocentric: core.topocentric,
    trail,
    emergencyFlag: core.emergencyFlag,
    icaoHex: core.rawHex,
    registration: core.registration,
    aircraftType: core.aircraftType,
    squawk: core.squawkRaw,
    onGround: core.onGround,
    isMilitary: core.isMilitary,
    isLadd: core.isLadd,
    isPia: core.isPia,
    adsbCategory: core.emitterCat,
    sourceFeed: core.sourceFeed,
    airframeClass,
  };
}

type ClassifiedAdsbxTarget =
  | { kind: 'flight'; entity: FlightEntity }
  | { kind: 'uas'; entity: DroneEntity }
  | { kind: 'balloon'; entity: BalloonEntity };

function classifyAndNormalizeAdsbxTarget(
  raw: RawAdsbxAircraft,
  observer: ObserverLocation,
  prevFlights: Map<string, FlightEntity>,
  prevDrones: Map<string, DroneEntity>,
  prevBalloons: Map<string, BalloonEntity>,
  nowMs: number,
  sourceFeed: AdsbSourceFeed,
  airspace?: AirspaceData
): ClassifiedAdsbxTarget | null {
  const rawHex = asCleanString(raw?.hex)?.toLowerCase() ?? '';
  const prevFlight = prevFlights.get(`flight:${rawHex}`);
  const prevDrone = prevDrones.get(`drone:adsb-${rawHex}`);
  const prevBalloon = prevBalloons.get(`balloon:adsb-${rawHex}`);
  const prevCoord = prevFlight ?? prevDrone ?? prevBalloon;

  const core = parseAdsbxCore(raw, observer, prevCoord, nowMs, sourceFeed);
  if (!core) return null;

  const t = (core.aircraftType ?? '').toUpperCase().trim();
  const cat = (core.emitterCat ?? '').toUpperCase().trim();
  const cleanCall = core.callsign.toUpperCase().trim();

  const isUas =
    !core.onGround &&
    (cat === 'B6' || UAS_TYPE_CODES.has(t) || UAS_CALLSIGN_REGEX.test(cleanCall));

  if (isUas) {
    const uaType: DroneEntity['uaType'] =
      FIXED_WING_UAS_TYPES.has(t) || cat === 'B6' ? 'fixed-wing' : 'vtol';
    const missionDesc = core.isMilitary ? 'LIVE ATC UAS · MILITARY' : 'LIVE ATC UAS · ADS-B';
    const altAglM = Math.max(0, core.altM - (observer.altM ?? 0));
    const compliance =
      airspace && altAglM <= 500
        ? evaluateDroneAirspaceCompliance(core.safeLat, core.normLon, altAglM, airspace)
        : { faaCeilingFt: null, ceilingBreach: false, tfrBreach: false };

    const emergencyFlag =
      core.emergencyFlag ??
      (compliance.tfrBreach
        ? 'TFR / SUA BREACH'
        : compliance.ceilingBreach
          ? 'UASFM BREACH'
          : undefined);

    const droneEntity: DroneEntity = {
      id: `drone:adsb-${core.rawHex}`,
      category: 'drone',
      callsign: core.callsign,
      subtitle: [
        core.aircraftType ?? 'ATC UAS',
        core.squawkRaw ? `SQK ${core.squawkRaw}` : undefined,
        core.isMilitary ? 'MILITARY' : 'ADS-B',
      ]
        .filter(Boolean)
        .join(' · '),
      country: core.country,
      lat: core.safeLat,
      lon: core.normLon,
      altM: core.altM,
      altBaroM: core.altBaroM,
      speedMs: core.speedMs,
      headingDeg: core.headingDeg,
      headingValid: core.headingValid,
      vertRateMs: core.vertRateMs,
      timestampMs: core.timestampMs,
      topocentric: core.topocentric,
      trail: appendTrailPoint(
        prevDrone?.trail,
        core.normLon,
        core.safeLat,
        core.altM,
        core.timestampMs
      ),
      isSimulated: false,
      emergencyFlag,
      uasId: core.rawHex.toUpperCase(),
      uaType,
      subSource: 'adsb-uas',
      icaoHex: core.rawHex,
      registration: core.registration,
      aircraftType: core.aircraftType,
      adsbCategory: core.emitterCat,
      squawk: core.squawkRaw,
      isMilitary: core.isMilitary,
      isLadd: core.isLadd,
      isPia: core.isPia,
      hasOperatorLocation: false,
      altAglM,
      operatorLat: core.safeLat,
      operatorLon: core.normLon,
      operatorDistM: 0,
      missionDesc,
      faaCeilingFt: compliance.faaCeilingFt,
      ceilingBreach: compliance.ceilingBreach,
      tfrBreach: compliance.tfrBreach,
    };
    return { kind: 'uas', entity: droneEntity };
  }

  const isLta =
    !core.onGround &&
    (cat === 'B2' ||
      t === 'BALL' ||
      LTA_CALLSIGN_REGEX.test(cleanCall) ||
      (!core.isMilitary &&
        t !== 'U2' &&
        t !== 'WB57' &&
        core.altM > 48_000 * FT_TO_M &&
        core.speedMs < 100 * KNOTS_TO_MS));

  if (isLta) {
    const burstState: BalloonEntity['burstState'] =
      core.vertRateMs > 1.2
        ? 'ascending'
        : core.vertRateMs < -1.2
          ? 'descending'
          : 'float';
    const sondeType = core.aircraftType
      ? `ADS-B LTA (${core.aircraftType})`
      : 'ADS-B Stratospheric Balloon';
    const balloonEntity: BalloonEntity = {
      id: `balloon:adsb-${core.rawHex}`,
      category: 'balloon',
      callsign: core.callsign,
      subtitle: [
        sondeType,
        core.squawkRaw ? `SQK ${core.squawkRaw}` : undefined,
        burstState.toUpperCase(),
      ]
        .filter(Boolean)
        .join(' · '),
      country: core.country,
      lat: core.safeLat,
      lon: core.normLon,
      altM: core.altM,
      altBaroM: core.altBaroM,
      speedMs: core.speedMs,
      headingDeg: core.headingDeg,
      headingValid: core.headingValid,
      vertRateMs: core.vertRateMs,
      timestampMs: core.timestampMs,
      topocentric: core.topocentric,
      trail: appendTrailPoint(
        prevBalloon?.trail,
        core.normLon,
        core.safeLat,
        core.altM,
        core.timestampMs
      ),
      emergencyFlag: core.emergencyFlag,
      serial: core.registration ?? core.rawHex.toUpperCase(),
      sondeType,
      subSource: 'adsb-lta',
      icaoHex: core.rawHex,
      registration: core.registration,
      squawk: core.squawkRaw,
      burstState,
    };
    return { kind: 'balloon', entity: balloonEntity };
  }

  return { kind: 'flight', entity: buildFlightFromCore(core, prevFlight) };
}

/**
 * Normalize an ADS-B Exchange v2 aircraft object (airplanes.live / adsb.lol / adsb.fi)
 * into a FlightEntity. Returns null when required hex or coordinates are missing/invalid.
 */
export function normalizeAdsbxAircraft(
  raw: RawAdsbxAircraft,
  observer: ObserverLocation,
  prev?: FlightEntity,
  nowMs = Date.now(),
  sourceFeed?: AdsbSourceFeed
): FlightEntity | null {
  const core = parseAdsbxCore(raw, observer, prev, nowMs, sourceFeed);
  if (!core) return null;
  return buildFlightFromCore(core, prev);
}

/**
 * Normalize an OpenSky Network `/api/states/all` 17-element tuple into a FlightEntity.
 * Returns null when tuple shape, icao24, or coordinates are invalid.
 */
export function normalizeOpenSkyState(
  tuple: unknown[],
  observer: ObserverLocation,
  prev?: FlightEntity,
  nowMs = Date.now()
): FlightEntity | null {
  if (!Array.isArray(tuple) || tuple.length < 11) return null;

  const rawHex = asCleanString(tuple[0])?.toLowerCase();
  if (!rawHex || !/^[0-9a-f]{4,8}$/.test(rawHex)) {
    return null;
  }

  const lon = asFiniteNumber(tuple[5]);
  const lat = asFiniteNumber(tuple[6]);
  if (!isValidGeoPoint(lat, lon)) {
    return null;
  }
  const safeLat = lat as number;
  const normLon = normalizeLonDeg(lon as number);

  const onGround = Boolean(tuple[8]);
  const baroAltM = asFiniteNumber(tuple[7]);
  const geoAltM = tuple.length > 13 ? asFiniteNumber(tuple[13]) : undefined;
  const altM = resolveValidatedAltitudeM(onGround, baroAltM, geoAltM, OPENSKY_MAX_ALT_M);
  if (altM === null) {
    return null;
  }

  const rawSpeed = asFiniteNumber(tuple[9]);
  if (rawSpeed !== undefined && (rawSpeed < 0 || rawSpeed > 1200)) {
    return null;
  }
  const speedMs = rawSpeed ?? 0;

  const rawTrack = asFiniteNumber(tuple[10]);
  const { headingDeg, headingValid } = resolveHeading(rawTrack, prev, safeLat, normLon);

  const vertRateMs = tuple.length > 11 ? (asFiniteNumber(tuple[11]) ?? 0) : 0;
  const callsign = asCleanString(tuple[1]) ?? rawHex.toUpperCase();
  const country = asCleanString(tuple[2]) ?? deriveCountryFromIcaoHex(rawHex);
  const squawk = tuple.length > 14 ? asCleanString(tuple[14]) : undefined;

  const timePosSec = asFiniteNumber(tuple[3]) ?? asFiniteNumber(tuple[4]);
  const timestampMs = timePosSec !== undefined ? timePosSec * 1000 : nowMs;

  const isMilitary = classifyMilitary(rawHex, callsign, 0);
  const airframeClass = classifyAirframeClass(undefined, undefined, isMilitary, speedMs);
  const topocentric = computeTopocentricLookAngles(observer, { lat: safeLat, lon: normLon, altM });
  const trail = appendTrailPoint(prev?.trail, normLon, safeLat, altM, timestampMs);
  const emergencyFlag = extractEmergencyFlag(squawk);

  return {
    id: `flight:${rawHex}`,
    category: isMilitary ? 'military' : 'flight',
    callsign,
    subtitle:
      [country, squawk ? `SQK ${squawk}` : undefined].filter(Boolean).join(' · ') ||
      'OpenSky Target',
    country,
    lat: safeLat,
    lon: normLon,
    altM,
    altBaroM: onGround ? 0 : baroAltM,
    speedMs,
    headingDeg,
    headingValid,
    vertRateMs,
    timestampMs,
    topocentric,
    trail,
    emergencyFlag,
    icaoHex: rawHex,
    squawk,
    onGround,
    isMilitary,
    sourceFeed: 'opensky',
    airframeClass,
  };
}

class StaticProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticProxyUnavailableError';
  }
}

/**
 * Extract a JSON object from direct responses, Jina `{ data: { content } }` JSON envelopes,
 * or Jina `Markdown Content:` text payloads while rejecting HTML, arrays, and upstream `{ Error }` payloads.
 */
export function extractRelayedJsonPayload(
  rawText: string,
  providerLabel: string
): Record<string, unknown> {
  const { value } = extractRelayedJsonValue(rawText, providerLabel);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid payload from ${providerLabel}`);
  }
  return value as Record<string, unknown>;
}

function toPrevMap<T extends { id: string }>(prevEntities?: Map<string, T> | T[]): Map<string, T> {
  if (!prevEntities) return new Map();
  if (prevEntities instanceof Map) return prevEntities;
  const map = new Map<string, T>();
  for (const item of prevEntities) {
    map.set(item.id, item);
  }
  return map;
}

function isVerifiedFreshLiveFlight(
  entity: FlightEntity,
  observer: ObserverLocation,
  radiusKm: number | null,
  nowMs: number
): boolean {
  if (entity.isSimulated || entity.onGround) return false;
  if (!Number.isFinite(entity.timestampMs) || entity.timestampMs > nowMs + 60_000) return false;
  if (nowMs - entity.timestampMs > 45_000) return false;
  if (radiusKm !== null) {
    if (entity.topocentric.groundDistKm > radiusKm) return false;
    return haversineDistanceKm(observer.lat, observer.lon, entity.lat, entity.lon) <= radiusKm;
  }
  return true;
}

interface NormalizedAdsbxLists {
  entities: FlightEntity[];
  uasEntities: DroneEntity[];
  balloonEntities: BalloonEntity[];
}

function normalizeAdsbxPayloadList(
  rawList: unknown[],
  observer: ObserverLocation,
  prevFlights: Map<string, FlightEntity>,
  prevDrones: Map<string, DroneEntity>,
  prevBalloons: Map<string, BalloonEntity>,
  radiusKm: number | null,
  nowMs: number,
  sourceFeed: AdsbSourceFeed,
  airspace?: AirspaceData
): NormalizedAdsbxLists {
  const entities: FlightEntity[] = [];
  const uasEntities: DroneEntity[] = [];
  const balloonEntities: BalloonEntity[] = [];
  const seenHexes = new Set<string>();

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rawItem = item as RawAdsbxAircraft;
    const seenPos = asFiniteNumber(rawItem.seen_pos);
    if (seenPos !== undefined && seenPos > 60) {
      continue;
    }

    const classified = classifyAndNormalizeAdsbxTarget(
      rawItem,
      observer,
      prevFlights,
      prevDrones,
      prevBalloons,
      nowMs,
      sourceFeed,
      airspace
    );
    if (!classified) continue;
    if (classified.kind === 'flight' && classified.entity.onGround) continue;

    const target = classified.entity;
    if (nowMs - target.timestampMs > 60_000 || target.timestampMs > nowMs + 60_000) {
      continue;
    }
    const hexKey = target.icaoHex ?? target.id;
    if (seenHexes.has(hexKey)) continue;
    if (radiusKm !== null && target.topocentric.groundDistKm > radiusKm) {
      continue;
    }

    seenHexes.add(hexKey);
    if (classified.kind === 'flight') {
      entities.push(classified.entity);
    } else if (classified.kind === 'uas') {
      uasEntities.push(classified.entity);
    } else {
      balloonEntities.push(classified.entity);
    }
  }

  return { entities, uasEntities, balloonEntities };
}

function buildOpenSkyBoxes(
  observer: ObserverLocation,
  radiusKm: number
): { lamin: string; lamax: string; boxes: Array<{ lomin: number; lomax: number }> } | null {
  const dLat = radiusKm / 111.32;
  const absLat = Math.abs(observer.lat);
  const cosLat = Math.cos((observer.lat * Math.PI) / 180);
  const dLon = cosLat > 1e-6 ? radiusKm / (111.32 * cosLat) : 180;

  if (absLat + dLat >= 90 || absLat > 88.5 || dLon >= 180) {
    return null;
  }

  const lamin = Math.max(-90, observer.lat - dLat).toFixed(4);
  const lamax = Math.min(90, observer.lat + dLat).toFixed(4);
  const obsLon = normalizeLonDeg(observer.lon);
  const rawMinLon = obsLon - dLon;
  const rawMaxLon = obsLon + dLon;

  const boxes: Array<{ lomin: number; lomax: number }> = [];
  if (rawMinLon < -180) {
    const wrappedMin = normalizeLonDeg(rawMinLon);
    if (wrappedMin < 180) {
      boxes.push({ lomin: wrappedMin, lomax: 180 });
    }
    if (rawMaxLon > -180) {
      boxes.push({ lomin: -180, lomax: rawMaxLon });
    }
  } else if (rawMaxLon > 180) {
    if (rawMinLon < 180) {
      boxes.push({ lomin: rawMinLon, lomax: 180 });
    }
    const wrappedMax = normalizeLonDeg(rawMaxLon);
    if (wrappedMax > -180) {
      boxes.push({ lomin: -180, lomax: wrappedMax });
    }
  } else {
    boxes.push({ lomin: rawMinLon, lomax: rawMaxLon });
  }

  return boxes.length > 0 ? { lamin, lamax, boxes } : null;
}

async function fetchAdsbxRawList(
  breaker: CircuitBreaker,
  breakerKey: string,
  providerLabel: string,
  url: string,
  opts: {
    strictAcOnly?: boolean;
    isRelay?: boolean;
    isViteProxy?: boolean;
    endpointTimeoutMs: number;
    signal?: AbortSignal;
  }
): Promise<unknown[]> {
  return breaker.execute(async () => {
    let data: Record<string, unknown>;

    if (opts.isRelay) {
      const rawText = await fetchTextWithTimeout(url, {
        timeoutMs: opts.endpointTimeoutMs,
        signal: opts.signal,
      });
      data = extractRelayedJsonPayload(rawText, providerLabel);
    } else if (opts.isViteProxy) {
      const rawText = await fetchTextWithTimeout(url, {
        timeoutMs: opts.endpointTimeoutMs,
        signal: opts.signal,
      });
      const trimmed = rawText.trim();
      if (isHtmlPayload(trimmed)) {
        throw new StaticProxyUnavailableError(`Static HTML response from ${providerLabel}`);
      }
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid payload from ${providerLabel}`);
      }
      data = parsed as Record<string, unknown>;
    } else {
      data = await fetchJsonWithTimeout<Record<string, unknown>>(url, {
        timeoutMs: opts.endpointTimeoutMs,
        signal: opts.signal,
      });
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`Invalid payload from ${providerLabel}`);
    }
    throwIfUpstreamErrorField(data, providerLabel);

    const candidate = Array.isArray(data.ac)
      ? data.ac
      : !opts.strictAcOnly && Array.isArray(data.aircraft)
        ? data.aircraft
        : null;
    if (!candidate) {
      throw new Error(`Missing ac[] schema from ${providerLabel}`);
    }
    return candidate;
  }, breakerKey);
}

/**
 * Multi-tier zero-key live ADS-B cascade (zero phantom/synthetic aircraft):
 * 1) Local Vite / LAN proxies (adsb.fi v3 -> adsb.lol -> airplanes.live; fast-bypass on static 404/405/HTML)
 * 2) Zero-preflight CORS simple-GET relays (cors-relay:adsb.fi -> cors-relay:adsb.lol)
 * 3) Direct browser fallback (adsb.lol -> opensky-network)
 */
export async function fetchFlightsCascade(
  observer: ObserverLocation,
  radiusKm: number,
  prevEntities?: Map<string, FlightEntity> | FlightEntity[],
  options: FlightsFetchOptions = {}
): Promise<FlightsFetchResult> {
  const prevMap = toPrevMap(prevEntities);
  const prevDrones = toPrevMap(options.prevDrones);
  const prevBalloons = toPrevMap(options.prevBalloons);
  const timeoutMs = options.timeoutMs ?? resolveAdaptiveTimeoutMs(DEFAULT_ADSB_TIMEOUT_MS);
  const relayTimeoutMs = options.timeoutMs ?? resolveAdaptiveTimeoutMs(RELAY_ADSB_TIMEOUT_MS);
  const latStr = observer.lat.toFixed(4);
  const lonStr = observer.lon.toFixed(4);
  const radiusNm = Math.max(1, Math.min(250, Math.ceil(radiusKm / 1.852)));
  const rateKey =
    options.rateLimitKey ??
    `adsb:${observer.lat.toFixed(2)},${observer.lon.toFixed(2)}:r${Math.round(radiusKm)}`;

  if (options.resetBreakers === true) {
    flightsCircuitBreaker.reset();
    viteProxyUnavailable = false;
    adsbRateLimiter.reset(rateKey);
    const cachedEntry = lastCachedFlightsByKey.get(rateKey);
    if (cachedEntry && cachedEntry.status !== 'live') {
      lastCachedFlightsByKey.delete(rateKey);
    }
  }

  const rateAllowed = adsbRateLimiter.tryConsume(rateKey);
  if (!options.force && !rateAllowed) {
    const cached = lastCachedFlightsByKey.get(rateKey);
    if (cached) {
      return {
        entities: cached.entities,
        uasEntities: cached.uasEntities,
        balloonEntities: cached.balloonEntities,
        status: cached.status === 'live' ? 'cached' : cached.status,
        provider: cached.provider,
        timestampMs: cached.timestampMs,
        errorMsg: cached.errorMsg,
        httpStatus: cached.httpStatus,
      };
    }

    const nowMs = Date.now();
    const freshPrev = Array.from(prevMap.values()).filter((e) =>
      isVerifiedFreshLiveFlight(e, observer, radiusKm, nowMs)
    );
    if (freshPrev.length > 0) {
      const maxTs = freshPrev.reduce((max, e) => Math.max(max, e.timestampMs), 0);
      return {
        entities: freshPrev,
        uasEntities: [],
        balloonEntities: [],
        status: 'cached',
        provider: 'rate-limit-cache',
        timestampMs: maxTs,
      };
    }
    return {
      entities: [],
      uasEntities: [],
      balloonEntities: [],
      status: 'cached',
      provider: 'rate-limit-cooldown',
      timestampMs: 0,
    };
  }

  const errors: string[] = [];
  let saw429 = false;
  let lastHttpStatus: number | undefined;

  const recordFailure = (providerLabel: string, err: unknown): void => {
    if (err instanceof HttpError) {
      lastHttpStatus = err.status;
      if (err.status === 429) {
        saw429 = true;
      }
    }
    errors.push(`${providerLabel}: ${err instanceof Error ? err.message : String(err)}`);
  };

  const recordCircuitOpen = (breakerKey: string, providerLabel: string): void => {
    const lastErr = flightsCircuitBreaker.getLastError(breakerKey);
    if (lastErr instanceof HttpError) {
      lastHttpStatus = lastErr.status;
      if (lastErr.status === 429) {
        saw429 = true;
      }
      errors.push(`${providerLabel}: circuit open (HTTP ${lastErr.status})`);
    } else if (lastErr instanceof Error) {
      errors.push(`${providerLabel}: circuit open (${lastErr.message})`);
    } else {
      errors.push(`${providerLabel}: circuit open`);
    }
  };

  interface AdsbxAttemptResult {
    result: FlightsFetchResult | null;
    proxyUnavailable?: boolean;
    error?: unknown;
  }

  const tryAdsbxEndpoint = async (
    breakerKey: string,
    providerLabel: string,
    url: string,
    opts: {
      strictAcOnly?: boolean;
      isRelay?: boolean;
      isViteProxy?: boolean;
      endpointTimeoutMs?: number;
    } = {}
  ): Promise<AdsbxAttemptResult> => {
    if (!flightsCircuitBreaker.canExecute(breakerKey)) {
      recordCircuitOpen(breakerKey, providerLabel);
      return { result: null };
    }

    const effectiveTimeoutMs = opts.endpointTimeoutMs ?? timeoutMs;

    try {
      const rawList = await fetchAdsbxRawList(
        flightsCircuitBreaker,
        breakerKey,
        providerLabel,
        url,
        {
          strictAcOnly: opts.strictAcOnly,
          isRelay: opts.isRelay,
          isViteProxy: opts.isViteProxy,
          endpointTimeoutMs: effectiveTimeoutMs,
          signal: options.signal,
        }
      );

      const nowMs = Date.now();
      const { entities, uasEntities, balloonEntities } = normalizeAdsbxPayloadList(
        rawList,
        observer,
        prevMap,
        prevDrones,
        prevBalloons,
        radiusKm,
        nowMs,
        'point',
        options.airspace
      );
      lastCachedFlightsByKey.set(rateKey, {
        entities,
        uasEntities,
        balloonEntities,
        status: 'live',
        provider: providerLabel,
        timestampMs: nowMs,
      });
      return {
        result: {
          entities,
          uasEntities,
          balloonEntities,
          status: 'live',
          provider: providerLabel,
          timestampMs: nowMs,
        },
      };
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      if (
        opts.isViteProxy &&
        (err instanceof StaticProxyUnavailableError ||
          (err instanceof HttpError && (err.status === 404 || err.status === 405)))
      ) {
        if (err instanceof StaticProxyUnavailableError || url.startsWith('/api-proxy/adsb-fi/')) {
          viteProxyUnavailable = true;
        }
        flightsCircuitBreaker.reset(breakerKey);
        return { result: null, proxyUnavailable: true, error: err };
      }
      recordFailure(providerLabel, err);
      return { result: null, error: err };
    }
  };

  // Stage 1: Local Vite / LAN proxies (fast-bypass out of Stage 1 on static 404/405/HTML)
  if (!viteProxyUnavailable && isLocalDevOrLanRuntime()) {
    const proxyFi = await tryAdsbxEndpoint(
      'proxy-adsb-fi',
      'vite-proxy:adsb.fi',
      `/api-proxy/adsb-fi/api/v3/lat/${latStr}/lon/${lonStr}/dist/${radiusNm}`,
      { strictAcOnly: false, isViteProxy: true }
    );
    if (proxyFi.result) return proxyFi.result;

    if (!proxyFi.proxyUnavailable && !viteProxyUnavailable) {
      const proxyLol = await tryAdsbxEndpoint(
        'proxy-adsb-lol',
        'vite-proxy:adsb.lol',
        `/api-proxy/adsb-lol/v2/point/${latStr}/${lonStr}/${radiusNm}`,
        { isViteProxy: true }
      );
      if (proxyLol.result) return proxyLol.result;

      if (!proxyLol.proxyUnavailable && !viteProxyUnavailable) {
        const proxyAirplanesLive = await tryAdsbxEndpoint(
          'proxy-airplanes-live',
          'vite-proxy:airplanes.live',
          `/api-proxy/airplanes-live/v2/point/${latStr}/${lonStr}/${radiusNm}`,
          { isViteProxy: true }
        );
        if (proxyAirplanesLive.result) return proxyAirplanesLive.result;
      }
    }
  }

  // Stage 2: Zero-preflight CORS simple-GET relays (works on GitHub Pages & static servers)
  const cacheBucket =
    options.force || options.resetBreakers || isTeslaBrowser()
      ? Date.now()
      : Math.floor(Date.now() / 10_000);
  const relayFi = await tryAdsbxEndpoint(
    'cors-relay-adsb-fi',
    'cors-relay:adsb.fi',
    `https://r.jina.ai/https://opendata.adsb.fi/api/v3/lat/${latStr}/lon/${lonStr}/dist/${radiusNm}?_=${cacheBucket}`,
    { strictAcOnly: false, isRelay: true, endpointTimeoutMs: relayTimeoutMs }
  );
  if (relayFi.result) return relayFi.result;

  const relayFiLastErr =
    relayFi.error ?? flightsCircuitBreaker.getLastError('cors-relay-adsb-fi');
  const relayFiRateLimited =
    relayFiLastErr instanceof HttpError && relayFiLastErr.status === 429;
  if (!relayFiRateLimited) {
    const relayLol = await tryAdsbxEndpoint(
      'cors-relay-adsb-lol',
      'cors-relay:adsb.lol',
      `https://r.jina.ai/https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusNm}?_=${cacheBucket}`,
      { strictAcOnly: true, isRelay: true, endpointTimeoutMs: relayTimeoutMs }
    );
    if (relayLol.result) return relayLol.result;
  }

  // Stage 3: Direct fallback (adsb.lol -> opensky-network)
  const directAdsbLol = await tryAdsbxEndpoint(
    'adsb.lol',
    'adsb.lol',
    `https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusNm}`
  );
  if (directAdsbLol.result) return directAdsbLol.result;

  // Stage 3b: OpenSky bounding box(es) with antimeridian splitting & polar guard
  const openSkyPlan = buildOpenSkyBoxes(observer, radiusKm);
  if (openSkyPlan && flightsCircuitBreaker.canExecute('opensky')) {
    try {
      const payloads = await flightsCircuitBreaker.execute(
        () =>
          Promise.all(
            openSkyPlan.boxes.map(async (box) => {
              const openSkyUrl = `https://opensky-network.org/api/states/all?lamin=${openSkyPlan.lamin}&lomin=${box.lomin.toFixed(4)}&lamax=${openSkyPlan.lamax}&lomax=${box.lomax.toFixed(4)}`;
              const data = await fetchJsonWithTimeout<{ states?: unknown }>(openSkyUrl, {
                timeoutMs,
                signal: options.signal,
              });
              if (!data || typeof data !== 'object' || !Array.isArray(data.states)) {
                throw new Error('Invalid OpenSky states[] payload');
              }
              return data.states;
            })
          ),
        'opensky'
      );

      const nowMs = Date.now();
      const entities: FlightEntity[] = [];
      const seenIds = new Set<string>();
      for (const states of payloads) {
        for (const row of states) {
          if (!Array.isArray(row)) continue;
          const hex = typeof row[0] === 'string' ? row[0].trim().toLowerCase() : '';
          const normalized = normalizeOpenSkyState(
            row,
            observer,
            prevMap.get(`flight:${hex}`),
            nowMs
          );
          if (!normalized) continue;
          if (normalized.onGround) continue;
          if (nowMs - normalized.timestampMs > 60_000 || normalized.timestampMs > nowMs + 60_000) {
            continue;
          }
          if (seenIds.has(normalized.id)) continue;
          if (normalized.topocentric.groundDistKm <= radiusKm) {
            seenIds.add(normalized.id);
            entities.push(normalized);
          }
        }
      }

      lastCachedFlightsByKey.set(rateKey, {
        entities,
        uasEntities: [],
        balloonEntities: [],
        status: 'live',
        provider: 'opensky-network',
        timestampMs: nowMs,
      });
      return {
        entities,
        uasEntities: [],
        balloonEntities: [],
        status: 'live',
        provider: 'opensky-network',
        timestampMs: nowMs,
      };
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      recordFailure('opensky-network', err);
    }
  } else if (openSkyPlan) {
    recordCircuitOpen('opensky', 'opensky-network');
  }

  // All live providers failed — return strictly verified recent entities or honest empty status
  const nowMs = Date.now();
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const errorMsg = errors.length > 0 ? errors.join(' | ') : undefined;
  const httpStatus = saw429 ? 429 : lastHttpStatus;
  const previousCached = lastCachedFlightsByKey.get(rateKey);

  const freshVerified: FlightEntity[] = [];
  for (const entity of prevMap.values()) {
    if (isVerifiedFreshLiveFlight(entity, observer, radiusKm, nowMs)) {
      freshVerified.push(entity);
    }
  }

  if (freshVerified.length > 0) {
    const maxEntityTs = freshVerified.reduce(
      (maxTs, entity) => Math.max(maxTs, entity.timestampMs),
      0
    );
    const status: 'rate-limited' | 'delayed' = saw429 ? 'rate-limited' : 'delayed';
    const provider = previousCached?.provider ?? 'adsb-cascade';
    lastCachedFlightsByKey.set(rateKey, {
      entities: freshVerified,
      uasEntities: [],
      balloonEntities: [],
      status,
      provider,
      timestampMs: maxEntityTs,
      httpStatus,
      errorMsg,
    });
    return {
      entities: freshVerified,
      uasEntities: [],
      balloonEntities: [],
      status,
      provider,
      timestampMs: maxEntityTs,
      httpStatus,
      errorMsg,
    };
  }

  const failureStatus: 'offline' | 'rate-limited' | 'error' = isOffline
    ? 'offline'
    : saw429
      ? 'rate-limited'
      : 'error';
  const preservedTimestampMs = previousCached?.timestampMs ?? 0;
  const provider = previousCached?.provider ?? 'adsb-cascade';

  lastCachedFlightsByKey.set(rateKey, {
    entities: [],
    uasEntities: [],
    balloonEntities: [],
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    httpStatus,
    errorMsg,
  });
  return {
    entities: [],
    uasEntities: [],
    balloonEntities: [],
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    httpStatus,
    errorMsg,
  };
}

type GlobalSpecialFeedType = 'mil' | 'ladd' | 'pia';

interface GlobalEndpointSpec {
  breakerKey: string;
  providerLabel: string;
  url: string;
  isViteProxy?: boolean;
  isRelay?: boolean;
  strictAcOnly?: boolean;
}

/**
 * Poll global `/v2/mil`, `/v2/ladd`, and `/v2/pia` feeds across Vite proxies, zero-preflight CORS relays,
 * and direct `adsb.lol`, deduplicating by normalized ICAO hex and routing B6 UAS / B2 LTA targets.
 * Completely isolated from local `fetchFlightsCascade` rate limiters and circuit breakers.
 */
export async function fetchGlobalSpecialFlights(
  observer: ObserverLocation,
  prevEntities?: Map<string, FlightEntity> | FlightEntity[],
  options: FlightsFetchOptions = {}
): Promise<GlobalFlightsFetchResult> {
  const prevMap = toPrevMap(prevEntities);
  const prevDrones = toPrevMap(options.prevDrones);
  const prevBalloons = toPrevMap(options.prevBalloons);
  const timeoutMs = options.timeoutMs ?? resolveAdaptiveTimeoutMs(DEFAULT_ADSB_TIMEOUT_MS);
  const relayTimeoutMs = options.timeoutMs ?? resolveAdaptiveTimeoutMs(RELAY_ADSB_TIMEOUT_MS);
  const rateKey = options.rateLimitKey ?? 'global-special';

  if (options.resetBreakers === true) {
    globalFlightsCircuitBreaker.reset();
    globalViteProxyUnavailable = false;
    globalAdsbRateLimiter.reset(rateKey);
    const cachedEntry = lastCachedGlobalFlightsByKey.get(rateKey);
    if (cachedEntry && cachedEntry.status !== 'live') {
      lastCachedGlobalFlightsByKey.delete(rateKey);
    }
  }

  const rateAllowed = globalAdsbRateLimiter.tryConsume(rateKey);
  if (!options.force && !rateAllowed) {
    const cached = lastCachedGlobalFlightsByKey.get(rateKey);
    if (cached) {
      return {
        entities: cached.entities,
        uasEntities: cached.uasEntities,
        balloonEntities: cached.balloonEntities,
        status: cached.status === 'live' ? 'cached' : cached.status,
        provider: cached.provider,
        timestampMs: cached.timestampMs,
        sourceCounts: cached.sourceCounts,
        errorMsg: cached.errorMsg,
        httpStatus: cached.httpStatus,
      };
    }

    const nowMs = Date.now();
    const freshPrev = Array.from(prevMap.values()).filter((e) =>
      isVerifiedFreshLiveFlight(e, observer, null, nowMs)
    );
    if (freshPrev.length > 0) {
      const maxTs = freshPrev.reduce((max, e) => Math.max(max, e.timestampMs), 0);
      return {
        entities: freshPrev,
        uasEntities: [],
        balloonEntities: [],
        status: 'cached',
        provider: 'rate-limit-cache',
        timestampMs: maxTs,
        sourceCounts: { mil: 0, ladd: 0, pia: 0 },
      };
    }

    return {
      entities: [],
      uasEntities: [],
      balloonEntities: [],
      status: 'cached',
      provider: 'rate-limit-cooldown',
      timestampMs: 0,
      sourceCounts: { mil: 0, ladd: 0, pia: 0 },
    };
  }

  const cacheBucket =
    options.force || options.resetBreakers || isTeslaBrowser()
      ? Date.now()
      : Math.floor(Date.now() / 15_000);
  const isLocal = isLocalDevOrLanRuntime();

  const buildFeedEndpoints = (feed: GlobalSpecialFeedType): GlobalEndpointSpec[] => {
    const list: GlobalEndpointSpec[] = [];
    if (isLocal && !globalViteProxyUnavailable) {
      list.push({
        breakerKey: `global-${feed}-proxy-adsb-lol`,
        providerLabel: `vite-proxy:adsb.lol/${feed}`,
        url: `/api-proxy/adsb-lol/v2/${feed}`,
        isViteProxy: true,
      });
      if (feed === 'mil') {
        // NOTE: Only hit /api/v2/mil on adsb.fi (adsb.fi /ladd and /pia return HTTP 400)
        list.push({
          breakerKey: `global-mil-proxy-adsb-fi`,
          providerLabel: `vite-proxy:adsb.fi/mil`,
          url: `/api-proxy/adsb-fi/api/v2/mil`,
          isViteProxy: true,
        });
      }
      list.push({
        breakerKey: `global-${feed}-proxy-airplanes-live`,
        providerLabel: `vite-proxy:airplanes.live/${feed}`,
        url: `/api-proxy/airplanes-live/v2/${feed}`,
        isViteProxy: true,
      });
    }

    list.push({
      breakerKey: `global-${feed}-relay-adsb-lol`,
      providerLabel: `cors-relay:adsb.lol/${feed}`,
      url: `https://r.jina.ai/https://api.adsb.lol/v2/${feed}?_=${cacheBucket}`,
      isRelay: true,
      strictAcOnly: true,
    });
    list.push({
      breakerKey: `global-${feed}-direct-adsb-lol`,
      providerLabel: `adsb.lol/${feed}`,
      url: `https://api.adsb.lol/v2/${feed}`,
    });
    return list;
  };

  interface FeedAttemptOutcome {
    feed: GlobalSpecialFeedType;
    ok: boolean;
    provider?: string;
    lists?: NormalizedAdsbxLists;
    count: number;
    errors: string[];
    saw429: boolean;
    lastHttpStatus?: number;
  }

  const runSpecialFeed = async (feed: GlobalSpecialFeedType): Promise<FeedAttemptOutcome> => {
    const endpoints = buildFeedEndpoints(feed);
    const errors: string[] = [];
    let saw429 = false;
    let lastHttpStatus: number | undefined;

    for (const ep of endpoints) {
      if (ep.isViteProxy && globalViteProxyUnavailable) {
        continue;
      }

      if (!globalFlightsCircuitBreaker.canExecute(ep.breakerKey)) {
        const lastErr = globalFlightsCircuitBreaker.getLastError(ep.breakerKey);
        if (lastErr instanceof HttpError) {
          lastHttpStatus = lastErr.status;
          if (lastErr.status === 429) saw429 = true;
          errors.push(`${ep.providerLabel}: circuit open (HTTP ${lastErr.status})`);
        } else if (lastErr instanceof Error) {
          errors.push(`${ep.providerLabel}: circuit open (${lastErr.message})`);
        } else {
          errors.push(`${ep.providerLabel}: circuit open`);
        }
        continue;
      }

      try {
        const rawList = await fetchAdsbxRawList(
          globalFlightsCircuitBreaker,
          ep.breakerKey,
          ep.providerLabel,
          ep.url,
          {
            strictAcOnly: ep.strictAcOnly,
            isRelay: ep.isRelay,
            isViteProxy: ep.isViteProxy,
            endpointTimeoutMs: ep.isRelay ? relayTimeoutMs : timeoutMs,
            signal: options.signal,
          }
        );

        const nowMs = Date.now();
        const lists = normalizeAdsbxPayloadList(
          rawList,
          observer,
          prevMap,
          prevDrones,
          prevBalloons,
          null,
          nowMs,
          feed,
          options.airspace
        );
        const count =
          lists.entities.length + lists.uasEntities.length + lists.balloonEntities.length;
        return {
          feed,
          ok: true,
          provider: ep.providerLabel,
          lists,
          count,
          errors,
          saw429,
          lastHttpStatus,
        };
      } catch (err) {
        if (options.signal?.aborted) {
          throw err;
        }
        if (
          ep.isViteProxy &&
          (err instanceof StaticProxyUnavailableError ||
            (err instanceof HttpError && (err.status === 404 || err.status === 405)))
        ) {
          if (
            err instanceof StaticProxyUnavailableError ||
            ep.url.startsWith('/api-proxy/adsb-lol/')
          ) {
            globalViteProxyUnavailable = true;
          }
          globalFlightsCircuitBreaker.reset(ep.breakerKey);
          continue;
        }
        if (err instanceof HttpError) {
          lastHttpStatus = err.status;
          if (err.status === 429) saw429 = true;
        }
        errors.push(`${ep.providerLabel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return {
      feed,
      ok: false,
      count: 0,
      errors,
      saw429,
      lastHttpStatus,
    };
  };

  const outcomes = await Promise.all([
    runSpecialFeed('mil'),
    runSpecialFeed('ladd'),
    runSpecialFeed('pia'),
  ]);

  const anyOk = outcomes.some((o) => o.ok);
  const allErrors = outcomes.flatMap((o) => o.errors);
  const saw429 = outcomes.some((o) => o.saw429);
  const lastHttpStatus = outcomes.reduce<number | undefined>(
    (acc, o) => o.lastHttpStatus ?? acc,
    undefined
  );

  if (anyOk) {
    const nowMs = Date.now();
    const flightByHex = new Map<string, FlightEntity>();
    const uasByHex = new Map<string, DroneEntity>();
    const balloonByHex = new Map<string, BalloonEntity>();
    const sourceCounts = { mil: 0, ladd: 0, pia: 0 };
    const providers: string[] = [];

    for (const outcome of outcomes) {
      if (!outcome.ok || !outcome.lists) continue;
      sourceCounts[outcome.feed] = outcome.count;
      if (outcome.provider) providers.push(outcome.provider);

      for (const f of outcome.lists.entities) {
        const hex = f.icaoHex;
        const existing = flightByHex.get(hex);
        if (!existing) {
          flightByHex.set(hex, f);
        } else {
          const mergedIsMil = existing.isMilitary || f.isMilitary;
          const mergedIsLadd = Boolean(existing.isLadd || f.isLadd);
          const mergedIsPia = Boolean(existing.isPia || f.isPia);
          flightByHex.set(hex, {
            ...existing,
            isMilitary: mergedIsMil,
            isLadd: mergedIsLadd || undefined,
            isPia: mergedIsPia || undefined,
            aircraftType: existing.aircraftType ?? f.aircraftType,
            registration: existing.registration ?? f.registration,
            squawk: existing.squawk ?? f.squawk,
            emergencyFlag: existing.emergencyFlag ?? f.emergencyFlag,
            category:
              mergedIsMil || (!existing.onGround && (mergedIsLadd || mergedIsPia))
                ? 'military'
                : existing.category,
            airframeClass: pickRicherAirframeClass(existing.airframeClass, f.airframeClass),
          });
        }
      }

      for (const d of outcome.lists.uasEntities) {
        const hex = d.icaoHex ?? d.id;
        const existing = uasByHex.get(hex);
        if (!existing) {
          uasByHex.set(hex, d);
        } else {
          const mergedIsMil = Boolean(existing.isMilitary || d.isMilitary);
          const mergedIsLadd = Boolean(existing.isLadd || d.isLadd);
          const mergedIsPia = Boolean(existing.isPia || d.isPia);
          uasByHex.set(hex, {
            ...existing,
            isMilitary: mergedIsMil,
            isLadd: mergedIsLadd || undefined,
            isPia: mergedIsPia || undefined,
            aircraftType: existing.aircraftType ?? d.aircraftType,
            registration: existing.registration ?? d.registration,
            squawk: existing.squawk ?? d.squawk,
            emergencyFlag: existing.emergencyFlag ?? d.emergencyFlag,
            missionDesc: mergedIsMil ? 'LIVE ATC UAS · MILITARY' : existing.missionDesc,
          });
        }
      }

      for (const b of outcome.lists.balloonEntities) {
        const hex = b.icaoHex ?? b.id;
        if (!balloonByHex.has(hex)) {
          balloonByHex.set(hex, b);
        }
      }
    }

    const entities = Array.from(flightByHex.values());
    const uasEntities = Array.from(uasByHex.values());
    const balloonEntities = Array.from(balloonByHex.values());
    const provider =
      providers.length > 0 ? Array.from(new Set(providers)).join('+') : 'adsb-mil-ladd-pia';
    const errorMsg = allErrors.length > 0 ? allErrors.join(' | ') : undefined;

    lastCachedGlobalFlightsByKey.set(rateKey, {
      entities,
      uasEntities,
      balloonEntities,
      status: 'live',
      provider,
      timestampMs: nowMs,
      sourceCounts,
      errorMsg,
    });

    return {
      entities,
      uasEntities,
      balloonEntities,
      status: 'live',
      provider,
      timestampMs: nowMs,
      sourceCounts,
      errorMsg,
    };
  }

  const nowMs = Date.now();
  const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
  const errorMsg = allErrors.length > 0 ? allErrors.join(' | ') : undefined;
  const httpStatus = saw429 ? 429 : lastHttpStatus;
  const previousCached = lastCachedGlobalFlightsByKey.get(rateKey);

  const freshVerified = Array.from(prevMap.values()).filter((entity) =>
    isVerifiedFreshLiveFlight(entity, observer, null, nowMs)
  );

  if (freshVerified.length > 0) {
    const maxEntityTs = freshVerified.reduce(
      (maxTs, entity) => Math.max(maxTs, entity.timestampMs),
      0
    );
    const status: 'rate-limited' | 'delayed' = saw429 ? 'rate-limited' : 'delayed';
    const provider = previousCached?.provider ?? 'adsb-mil-ladd-pia';
    const sourceCounts = previousCached?.sourceCounts ?? { mil: 0, ladd: 0, pia: 0 };
    lastCachedGlobalFlightsByKey.set(rateKey, {
      entities: freshVerified,
      uasEntities: [],
      balloonEntities: [],
      status,
      provider,
      timestampMs: maxEntityTs,
      sourceCounts,
      httpStatus,
      errorMsg,
    });
    return {
      entities: freshVerified,
      uasEntities: [],
      balloonEntities: [],
      status,
      provider,
      timestampMs: maxEntityTs,
      sourceCounts,
      httpStatus,
      errorMsg,
    };
  }

  const failureStatus: 'offline' | 'rate-limited' | 'error' = isOffline
    ? 'offline'
    : saw429
      ? 'rate-limited'
      : 'error';
  const preservedTimestampMs = previousCached?.timestampMs ?? 0;
  const provider = previousCached?.provider ?? 'adsb-mil-ladd-pia';

  lastCachedGlobalFlightsByKey.set(rateKey, {
    entities: [],
    uasEntities: [],
    balloonEntities: [],
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    sourceCounts: { mil: 0, ladd: 0, pia: 0 },
    httpStatus,
    errorMsg,
  });

  return {
    entities: [],
    uasEntities: [],
    balloonEntities: [],
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    sourceCounts: { mil: 0, ladd: 0, pia: 0 },
    httpStatus,
    errorMsg,
  };
}
