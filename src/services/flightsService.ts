import type {
  FeedHealthStatus,
  FlightEntity,
  ObserverLocation,
  TrailPoint,
} from '../types/sky-contracts';
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
  httpStatus?: number;
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
  {
    entities: FlightEntity[];
    status: 'live' | 'delayed' | 'rate-limited' | 'offline' | 'error';
    provider: string;
    timestampMs: number;
    errorMsg?: string;
    httpStatus?: number;
  }
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
  const normLon = normalizeLonDeg(lon);
  const newPoint: TrailPoint = { lon: normLon, lat, altM, ts };
  const base = prev?.trail ? [...prev.trail] : [];
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
  altGeomM: number | undefined
): number | null {
  if (
    (altBaroM !== undefined && (altBaroM < -500 || altBaroM > 60_000)) ||
    (altGeomM !== undefined && (altGeomM < -500 || altGeomM > 60_000))
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
  return altM < -500 || altM > 60_000 ? null : altM;
}

function resolveHeading(
  rawTrack: number | undefined,
  prev: FlightEntity | undefined,
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
  const altM = resolveValidatedAltitudeM(onGround, altBaroM, altGeomM);
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
  const { headingDeg, headingValid } = resolveHeading(rawTrack, prev, safeLat, normLon);

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

  const topocentric = computeTopocentricLookAngles(observer, { lat: safeLat, lon: normLon, altM });
  const trail = appendTrailPoint(prev, normLon, safeLat, altM, timestampMs);
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
    lat: safeLat,
    lon: normLon,
    altM,
    altBaroM,
    speedMs,
    headingDeg,
    headingValid,
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
  const altM = resolveValidatedAltitudeM(onGround, baroAltM, geoAltM);
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
  const trail = appendTrailPoint(prev, normLon, safeLat, altM, timestampMs);
  const emergencyFlag = extractEmergencyFlag(squawk);

  return {
    id: `flight:${rawHex}`,
    category: isMilitary ? 'military' : 'flight',
    callsign,
    subtitle: [country, squawk ? `SQK ${squawk}` : undefined].filter(Boolean).join(' · ') || 'OpenSky Target',
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

function isVerifiedFreshLiveFlight(
  entity: FlightEntity,
  observer: ObserverLocation,
  radiusKm: number,
  nowMs: number
): boolean {
  if (entity.isSimulated || entity.onGround) return false;
  if (!Number.isFinite(entity.timestampMs) || entity.timestampMs > nowMs + 60_000) return false;
  if (nowMs - entity.timestampMs > 45_000) return false;
  if (entity.topocentric.groundDistKm > radiusKm) return false;
  return haversineDistanceKm(observer.lat, observer.lon, entity.lat, entity.lon) <= radiusKm;
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

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const rawItem = item as RawAdsbxAircraft;
    const seenPos = asFiniteNumber(rawItem.seen_pos);
    if (seenPos !== undefined && seenPos > 60) {
      continue;
    }

    const hexKey = typeof rawItem.hex === 'string' ? rawItem.hex.trim().toLowerCase() : '';
    const normalized = normalizeAdsbxAircraft(
      rawItem,
      observer,
      prevMap.get(`flight:${hexKey}`),
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
  return entities;
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

/**
 * Multi-tier zero-key live ADS-B cascade (zero phantom/synthetic aircraft):
 * 1) Local Vite proxies (localhost/127.0.0.1 only: adsb.fi -> adsb.lol -> airplanes.live)
 * 2) Direct browser cascade (adsb.lol -> airplanes.live -> opensky-network.org)
 * 3) Schema-validated CORS relay (api.codetabs.com -> adsb.lol)
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
  const radiusNm = Math.max(1, Math.min(250, Math.ceil(radiusKm / 1.852)));
  const rateKey =
    options.rateLimitKey ??
    `adsb:${observer.lat.toFixed(2)},${observer.lon.toFixed(2)}:r${Math.round(radiusKm)}`;

  const rateAllowed = adsbRateLimiter.tryConsume(rateKey);
  if (!options.force && !rateAllowed) {
    const cached = lastCachedFlightsByKey.get(rateKey);
    if (cached) {
      return {
        entities: cached.entities,
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
        status: 'cached',
        provider: 'rate-limit-cache',
        timestampMs: maxTs,
      };
    }
    return {
      entities: [],
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

  const tryAdsbxEndpoint = async (
    breakerKey: string,
    providerLabel: string,
    url: string,
    strictAcOnly = false
  ): Promise<FlightsFetchResult | null> => {
    if (!flightsCircuitBreaker.canExecute(breakerKey)) {
      errors.push(`${providerLabel}: circuit open`);
      return null;
    }
    try {
      const rawList = await flightsCircuitBreaker.execute(async () => {
        const data = await fetchJsonWithTimeout<Record<string, unknown>>(url, {
          timeoutMs,
          signal: options.signal,
        });
        if (!data || typeof data !== 'object') {
          throw new Error(`Invalid payload from ${providerLabel}`);
        }
        const hasErrorField =
          (typeof data.Error === 'string' && data.Error.trim().length > 0) ||
          (data.Error !== undefined &&
            data.Error !== null &&
            typeof data.Error !== 'string' &&
            Boolean(data.Error));
        if (hasErrorField) {
          throw new Error(
            typeof data.Error === 'string'
              ? data.Error.trim()
              : `Upstream error from ${providerLabel}`
          );
        }
        const candidate = Array.isArray(data.ac)
          ? data.ac
          : !strictAcOnly && Array.isArray(data.aircraft)
            ? data.aircraft
            : null;
        if (!candidate) {
          throw new Error(`Missing ac[] schema from ${providerLabel}`);
        }
        return candidate;
      }, breakerKey);

      const nowMs = Date.now();
      const entities = normalizeAdsbxPayloadList(rawList, observer, prevMap, radiusKm, nowMs);
      lastCachedFlightsByKey.set(rateKey, {
        entities,
        status: 'live',
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
      recordFailure(providerLabel, err);
      return null;
    }
  };

  // Stage 1: Local Vite proxies when running on localhost / 127.0.0.1
  if (isLocalhostRuntime()) {
    const proxyFi = await tryAdsbxEndpoint(
      'proxy-adsb-fi',
      'vite-proxy:adsb.fi',
      `/api-proxy/adsb-fi/api/v2/lat/${latStr}/lon/${lonStr}/dist/${radiusNm}`
    );
    if (proxyFi) return proxyFi;

    const proxyLol = await tryAdsbxEndpoint(
      'proxy-adsb-lol',
      'vite-proxy:adsb.lol',
      `/api-proxy/adsb-lol/v2/point/${latStr}/${lonStr}/${radiusNm}`
    );
    if (proxyLol) return proxyLol;

    const proxyAirplanesLive = await tryAdsbxEndpoint(
      'proxy-airplanes-live',
      'vite-proxy:airplanes.live',
      `/api-proxy/airplanes-live/v2/point/${latStr}/${lonStr}/${radiusNm}`
    );
    if (proxyAirplanesLive) return proxyAirplanesLive;
  }

  // Stage 2: Direct browser cascade (adsb.lol -> airplanes.live -> opensky-network)
  const directAdsbLol = await tryAdsbxEndpoint(
    'adsb.lol',
    'adsb.lol',
    `https://api.adsb.lol/v2/point/${latStr}/${lonStr}/${radiusNm}`
  );
  if (directAdsbLol) return directAdsbLol;

  const directAirplanesLive = await tryAdsbxEndpoint(
    'airplanes.live',
    'airplanes.live',
    `https://api.airplanes.live/v2/point/${latStr}/${lonStr}/${radiusNm}`
  );
  if (directAirplanesLive) return directAirplanesLive;

  // Stage 2c: OpenSky bounding box(es) with antimeridian splitting & polar guard
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
        status: 'live',
        provider: 'opensky-network',
        timestampMs: nowMs,
      });
      return {
        entities,
        status: 'live',
        provider: 'opensky-network',
        timestampMs: nowMs,
      };
    } catch (err) {
      recordFailure('opensky-network', err);
    }
  } else if (openSkyPlan) {
    errors.push('opensky-network: circuit open');
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

  // All live providers failed — return strictly verified recent entities or honest empty status (ZERO synthetic aircraft)
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
      status,
      provider,
      timestampMs: maxEntityTs,
      httpStatus,
      errorMsg,
    });
    return {
      entities: freshVerified,
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
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    httpStatus,
    errorMsg,
  });
  return {
    entities: [],
    status: failureStatus,
    provider,
    timestampMs: preservedTimestampMs,
    httpStatus,
    errorMsg,
  };
}
