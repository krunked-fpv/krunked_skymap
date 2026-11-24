import type {
  AtmosphericScope,
  BalloonEntity,
  FeedHealthStatus,
  ObserverLocation,
  TrailPoint,
} from '../types/sky-contracts';
import {
  bearingToCardinal,
  computeBearingDeg,
  computeTopocentricLookAngles,
  haversineDistanceKm,
  normalizeAzimuthDeg,
  normalizeLonDeg,
} from './geoHelpers';
import {
  CircuitBreaker,
  HttpError,
  extractRelayedJsonValue,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  isHtmlPayload,
  isLocalDevOrLanRuntime,
} from './httpClient';

const MAX_TRAIL_POINTS = 24;
const SONDE_TIMEOUT_MS = 5000;
const WINDBORNE_TIMEOUT_MS = 5000;
const WINDBORNE_RELAY_TIMEOUT_MS = 6500;
const WIDENED_SEARCH_METERS = 1_000_000;
const MAX_WINDBORNE_STEP_KM = 450;

export const WINDBORNE_TTL_MS = 5 * 60 * 1000;
export const WINDBORNE_DB_NAME = 'krunked_windborne_v1';
const WINDBORNE_STORE_NAME = 'windborne_cache';
const WINDBORNE_CACHE_KEY = 'windborne_constellation_bundle';

export interface RawSondeRecord {
  serial?: unknown;
  payload_callsign?: unknown;
  callsign?: unknown;
  type?: unknown;
  subtype?: unknown;
  manufacturer?: unknown;
  datetime?: unknown;
  time_received?: unknown;
  lat?: unknown;
  lon?: unknown;
  alt?: unknown;
  vel_v?: unknown;
  vspeed?: unknown;
  vel_h?: unknown;
  hspeed?: unknown;
  speed?: unknown;
  heading?: unknown;
  course?: unknown;
  temp?: unknown;
  humidity?: unknown;
  pressure?: unknown;
  frequency?: unknown;
  freq?: unknown;
  tx_frequency?: unknown;
  uploader_callsign?: unknown;
  uploader?: unknown;
  burst_timer?: unknown;
}

export interface BalloonsFetchResult {
  entities: BalloonEntity[];
  status: FeedHealthStatus;
  provider: string;
  timestampMs: number;
  nearestSondeHint: string | null;
  sourceCounts?: { windborne: number; sondehub: number };
  windborneStatus?: FeedHealthStatus;
  errorMsg?: string;
}

export interface BalloonsFetchOptions {
  force?: boolean;
  resetBreakers?: boolean;
  scope?: AtmosphericScope;
  includeWindBorne?: boolean;
  includeSondeHub?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  nowMs?: number;
}

export const balloonsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
});

export const windborneCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 60_000,
});

interface WindborneCacheBundle {
  key: string;
  fetchedAtMs: number;
  dataTimestampMs: number;
  provider: string;
  t0: unknown[];
  t1: unknown[] | null;
  t2: unknown[] | null;
}

class WindBorneProxyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindBorneProxyUnavailableError';
  }
}

let memoryWindborneCache: WindborneCacheBundle | null = null;
let windborneProxyUnavailable = false;

/**
 * Reset in-memory WindBorne cache, circuit breakers, and static-proxy fast-bypass latch.
 */
export function clearBalloonsCache(): void {
  memoryWindborneCache = null;
  balloonsCircuitBreaker.reset();
  windborneCircuitBreaker.reset();
  windborneProxyUnavailable = false;
}

function asFinite(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function asStr(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const s = val.trim();
  return s.length > 0 ? s : undefined;
}

function classifyBurstState(
  vertRateMs: number,
  burstTimer?: number
): BalloonEntity['burstState'] {
  if (vertRateMs > 1.2) return 'ascending';
  if (vertRateMs < -1.2) return 'descending';
  if (typeof burstTimer === 'number' && burstTimer > 0 && vertRateMs <= 0) {
    return 'descending';
  }
  return 'float';
}

function extractRecordsFromPayload(
  payload: unknown
): Array<{ keyHint?: string; raw: RawSondeRecord }> {
  if (!payload) return [];
  if (Array.isArray(payload)) {
    return payload
      .filter((item): item is RawSondeRecord => Boolean(item && typeof item === 'object'))
      .map((raw) => ({ raw }));
  }
  if (typeof payload === 'object') {
    const out: Array<{ keyHint?: string; raw: RawSondeRecord }> = [];
    for (const [key, val] of Object.entries(payload as Record<string, unknown>)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        out.push({ keyHint: key, raw: val as RawSondeRecord });
      }
    }
    return out;
  }
  return [];
}

function appendBalloonTrail(
  prev: BalloonEntity | undefined,
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
    ts - last.ts > 300_000 ||
    haversineDistanceKm(last.lat, last.lon, lat, normLon) > 30
  ) {
    return [newPoint];
  }
  if (
    Math.abs(last.lat - lat) > 1e-5 ||
    Math.abs(last.lon - normLon) > 1e-5 ||
    Math.abs(ts - last.ts) > 2000
  ) {
    base.push(newPoint);
  }
  return base.length > MAX_TRAIL_POINTS ? base.slice(base.length - MAX_TRAIL_POINTS) : base;
}

/**
 * Normalize a SondeHub v2 /sondes or /amateur record into a BalloonEntity.
 */
export function normalizeSondeRecord(
  raw: RawSondeRecord,
  observer: ObserverLocation,
  options: { isAmateur?: boolean; keyHint?: string; prev?: BalloonEntity } = {}
): BalloonEntity | null {
  if (!raw || typeof raw !== 'object') return null;

  const lat = asFinite(raw.lat);
  const lon = asFinite(raw.lon);
  if (
    lat === undefined ||
    lon === undefined ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180 ||
    (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4)
  ) {
    return null;
  }

  const serial =
    asStr(raw.serial) ??
    asStr(raw.payload_callsign) ??
    asStr(raw.callsign) ??
    options.keyHint;
  if (!serial) return null;

  const altM = Math.max(0, asFinite(raw.alt) ?? 0);
  const vertRateMs = asFinite(raw.vel_v) ?? asFinite(raw.vspeed) ?? 0;
  const speedMs = Math.max(
    0,
    asFinite(raw.vel_h) ?? asFinite(raw.hspeed) ?? asFinite(raw.speed) ?? 0
  );

  let headingDeg = asFinite(raw.heading) ?? asFinite(raw.course);
  if (headingDeg === undefined && options.prev) {
    const movedKm = haversineDistanceKm(options.prev.lat, options.prev.lon, lat, lon);
    headingDeg =
      movedKm > 0.02
        ? computeBearingDeg(options.prev.lat, options.prev.lon, lat, lon)
        : options.prev.headingDeg;
  }
  headingDeg = normalizeAzimuthDeg(headingDeg ?? 0);

  const sondeType =
    asStr(raw.subtype) ??
    asStr(raw.type) ??
    asStr(raw.manufacturer) ??
    (options.isAmateur ? 'HAB Amateur' : 'Radiosonde');

  const freqMHz =
    asFinite(raw.frequency) ?? asFinite(raw.freq) ?? asFinite(raw.tx_frequency);
  const tempC = asFinite(raw.temp);
  const pressureHPa = asFinite(raw.pressure);
  const humidityPct = asFinite(raw.humidity);
  const uploaderCallsign = asStr(raw.uploader_callsign) ?? asStr(raw.uploader);
  const burstTimer = asFinite(raw.burst_timer);
  const burstState = classifyBurstState(vertRateMs, burstTimer);

  const parsedTime = asStr(raw.datetime) ?? asStr(raw.time_received);
  const tsParsed = parsedTime ? Date.parse(parsedTime) : Number.NaN;
  const timestampMs = Number.isFinite(tsParsed) ? tsParsed : Date.now();

  const topocentric = computeTopocentricLookAngles(observer, { lat, lon, altM });
  const trail = appendBalloonTrail(options.prev, lon, lat, altM, timestampMs);

  const subtitleParts = [
    sondeType,
    freqMHz !== undefined ? `${freqMHz.toFixed(3)} MHz` : undefined,
    burstState.toUpperCase(),
  ].filter(Boolean);

  return {
    id: `balloon:${serial}`,
    category: 'balloon',
    callsign: serial,
    subtitle: subtitleParts.join(' · '),
    country: options.isAmateur ? 'Amateur HAB' : 'WMO / Radiosonde',
    lat,
    lon: normalizeLonDeg(lon),
    altM,
    speedMs,
    headingDeg,
    vertRateMs,
    timestampMs,
    topocentric,
    trail,
    serial,
    sondeType,
    subSource: options.isAmateur ? 'sondehub-amateur' : 'sondehub',
    freqMHz,
    tempC,
    pressureHPa,
    humidityPct,
    burstState,
    uploaderCallsign,
  };
}

interface ParsedWindBorneTuple {
  lat: number;
  lon: number;
  altKm: number;
}

function parseWindBorneTuple(tuple: unknown): ParsedWindBorneTuple | null {
  if (!Array.isArray(tuple) || tuple.length < 3) return null;
  const lat = tuple[0];
  const lon = tuple[1];
  const altKm = tuple[2];
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    typeof altKm !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(altKm)
  ) {
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180 || altKm < -0.5 || altKm > 60) {
    return null;
  }
  if (Math.abs(lat) < 1e-4 && Math.abs(lon) < 1e-4) {
    return null;
  }
  return {
    lat,
    lon: normalizeLonDeg(lon),
    altKm,
  };
}

function buildWindBorneTrail(
  prev: BalloonEntity | undefined,
  p0: ParsedWindBorneTuple,
  p1: ParsedWindBorneTuple | null,
  p2: ParsedWindBorneTuple | null,
  t1ValidForT0: boolean,
  timestampMs: number
): TrailPoint[] {
  const pt0: TrailPoint = {
    lon: p0.lon,
    lat: p0.lat,
    altM: Math.max(0, p0.altKm * 1000),
    ts: timestampMs,
  };

  const historical: TrailPoint[] = [];
  if (t1ValidForT0 && p1) {
    const pt1: TrailPoint = {
      lon: p1.lon,
      lat: p1.lat,
      altM: Math.max(0, p1.altKm * 1000),
      ts: timestampMs - 3_600_000,
    };
    if (p2 && haversineDistanceKm(p2.lat, p2.lon, p1.lat, p1.lon) <= MAX_WINDBORNE_STEP_KM) {
      historical.push({
        lon: p2.lon,
        lat: p2.lat,
        altM: Math.max(0, p2.altKm * 1000),
        ts: timestampMs - 7_200_000,
      });
    }
    historical.push(pt1);
  }
  historical.push(pt0);

  const prevValid = (prev?.trail ?? []).filter(
    (pt) =>
      pt &&
      Number.isFinite(pt.lat) &&
      Number.isFinite(pt.lon) &&
      Number.isFinite(pt.altM) &&
      Number.isFinite(pt.ts)
  );

  const lastPrev = prevValid[prevValid.length - 1];
  if (
    !lastPrev ||
    timestampMs < lastPrev.ts ||
    timestampMs - lastPrev.ts > 6 * 3_600_000 ||
    haversineDistanceKm(lastPrev.lat, lastPrev.lon, pt0.lat, pt0.lon) > MAX_WINDBORNE_STEP_KM
  ) {
    return historical.length > MAX_TRAIL_POINTS
      ? historical.slice(historical.length - MAX_TRAIL_POINTS)
      : historical;
  }

  const merged: TrailPoint[] = [...prevValid];
  const earlierHist = historical.filter((pt) => pt.ts < merged[0].ts - 60_000);
  if (earlierHist.length > 0) {
    const anchor = merged[0];
    const lastEarlier = earlierHist[earlierHist.length - 1];
    if (
      haversineDistanceKm(lastEarlier.lat, lastEarlier.lon, anchor.lat, anchor.lon) <=
      MAX_WINDBORNE_STEP_KM
    ) {
      merged.unshift(...earlierHist);
    }
  }

  for (const pt of historical) {
    const tail = merged[merged.length - 1];
    if (pt.ts > tail.ts) {
      if (
        haversineDistanceKm(tail.lat, tail.lon, pt.lat, pt.lon) <= MAX_WINDBORNE_STEP_KM &&
        (Math.abs(tail.lat - pt.lat) > 1e-5 ||
          Math.abs(tail.lon - pt.lon) > 1e-5 ||
          pt.ts - tail.ts > 2000)
      ) {
        merged.push(pt);
      }
    } else if (
      pt.ts === tail.ts &&
      (Math.abs(tail.lat - pt.lat) > 1e-5 || Math.abs(tail.lon - pt.lon) > 1e-5) &&
      haversineDistanceKm(tail.lat, tail.lon, pt.lat, pt.lon) <= MAX_WINDBORNE_STEP_KM
    ) {
      merged[merged.length - 1] = pt;
    }
  }

  return merged.length > MAX_TRAIL_POINTS
    ? merged.slice(merged.length - MAX_TRAIL_POINTS)
    : merged;
}

/**
 * Parse and correlate WindBorne Systems [lat, lon, altKm] constellation snapshots across
 * T-0h (00.json), T-1h (01.json), and T-2h (02.json), deriving 3D kinematics and trails.
 */
export function parseWindBorneConstellation(
  t0Raw: unknown,
  t1Raw: unknown,
  t2Raw: unknown,
  observer: ObserverLocation,
  options?: {
    timestampMs?: number;
    prevMap?: Map<string, BalloonEntity>;
    isCachedSeed?: boolean;
  }
): BalloonEntity[] {
  if (!Array.isArray(t0Raw)) return [];

  const t1Arr = Array.isArray(t1Raw) ? t1Raw : [];
  const t2Arr = Array.isArray(t2Raw) ? t2Raw : [];
  const timestampMs = options?.timestampMs ?? Date.now();
  const prevMap = options?.prevMap;
  const isCachedSeed = Boolean(options?.isCachedSeed);

  const entities: BalloonEntity[] = [];

  for (let i = 0; i < t0Raw.length; i += 1) {
    const p0 = parseWindBorneTuple(t0Raw[i]);
    if (!p0) continue;

    const p1 = i < t1Arr.length ? parseWindBorneTuple(t1Arr[i]) : null;
    const p2 = i < t2Arr.length ? parseWindBorneTuple(t2Arr[i]) : null;

    let speedMs = 0;
    let headingDeg = 0;
    let headingValid = false;
    let vertRateMs = 0;
    let t1ValidForT0 = false;

    if (p1) {
      const distKm = haversineDistanceKm(p1.lat, p1.lon, p0.lat, p0.lon);
      if (distKm <= MAX_WINDBORNE_STEP_KM) {
        t1ValidForT0 = true;
        speedMs = (distKm * 1000) / 3600;
        headingValid = distKm > 0.05;
        headingDeg = headingValid
          ? normalizeAzimuthDeg(
              computeBearingDeg(p1.lat, normalizeLonDeg(p1.lon), p0.lat, normalizeLonDeg(p0.lon))
            )
          : 0;
        vertRateMs = Math.max(-50, Math.min(50, ((p0.altKm - p1.altKm) * 1000) / 3600));
      }
    }

    const burstState = classifyBurstState(vertRateMs);
    const constellationId = `WB-GSB-${String(i + 1).padStart(3, '0')}`;
    const id = `balloon:${constellationId}`;
    const altM = Math.max(0, p0.altKm * 1000);
    const prev = prevMap?.get(id);

    const trail = buildWindBorneTrail(prev, p0, p1, p2, t1ValidForT0, timestampMs);
    const topocentric = computeTopocentricLookAngles(observer, {
      lat: p0.lat,
      lon: p0.lon,
      altM,
    });

    entities.push({
      id,
      category: 'balloon',
      callsign: constellationId,
      subtitle: `WindBorne Systems · Global Sounding Balloon · ${burstState.toUpperCase()}`,
      country: 'WindBorne Systems',
      lat: p0.lat,
      lon: p0.lon,
      altM,
      speedMs,
      headingDeg,
      headingValid,
      vertRateMs,
      timestampMs,
      topocentric,
      trail,
      serial: constellationId,
      sondeType: 'WindBorne Global Sounding Balloon',
      subSource: 'windborne',
      constellationId,
      isCachedSeed,
      burstState,
    });
  }

  return entities;
}

async function openWindborneDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;

  return new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(WINDBORNE_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(WINDBORNE_STORE_NAME)) {
          db.createObjectStore(WINDBORNE_STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readWindborneCacheFromIdb(): Promise<WindborneCacheBundle | null> {
  if (memoryWindborneCache) {
    return memoryWindborneCache;
  }
  if (typeof indexedDB === 'undefined') {
    return null;
  }

  const db = await openWindborneDb();
  if (!db) return null;

  return new Promise<WindborneCacheBundle | null>((resolve) => {
    try {
      const tx = db.transaction(WINDBORNE_STORE_NAME, 'readonly');
      const store = tx.objectStore(WINDBORNE_STORE_NAME);
      const req = store.get(WINDBORNE_CACHE_KEY);
      req.onsuccess = () => {
        const val = req.result as WindborneCacheBundle | undefined;
        db.close();
        if (val && typeof val.fetchedAtMs === 'number' && Array.isArray(val.t0)) {
          memoryWindborneCache = val;
          resolve(val);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

async function writeWindborneCacheToIdb(bundle: WindborneCacheBundle): Promise<void> {
  memoryWindborneCache = bundle;
  if (typeof indexedDB === 'undefined') return;

  const db = await openWindborneDb();
  if (!db) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(WINDBORNE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(WINDBORNE_STORE_NAME);
      store.put(bundle);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

interface WindBorneFetchResult {
  entities: BalloonEntity[];
  status: FeedHealthStatus;
  provider: string;
  timestampMs: number;
  errorMsg?: string;
}

async function fetchWindBorneConstellation(
  observer: ObserverLocation,
  prevMap: Map<string, BalloonEntity>,
  options: BalloonsFetchOptions
): Promise<WindBorneFetchResult> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? WINDBORNE_TIMEOUT_MS;
  const relayTimeoutMs = options.timeoutMs ?? WINDBORNE_RELAY_TIMEOUT_MS;

  const cached = await readWindborneCacheFromIdb();
  const hasFreshCache =
    Boolean(cached) &&
    Array.isArray(cached!.t0) &&
    cached!.t0.length > 0 &&
    nowMs - cached!.fetchedAtMs < WINDBORNE_TTL_MS;

  if (!options.force && hasFreshCache && cached) {
    return {
      entities: parseWindBorneConstellation(cached.t0, cached.t1, cached.t2, observer, {
        timestampMs: cached.dataTimestampMs,
        prevMap,
        isCachedSeed: false,
      }),
      status: 'cached',
      provider: cached.provider,
      timestampMs: cached.dataTimestampMs,
    };
  }

  const errors: string[] = [];

  // Tier 1: Local Vite / LAN proxy with fast-bypass on 404/405/HTML
  if (
    isLocalDevOrLanRuntime() &&
    !windborneProxyUnavailable &&
    windborneCircuitBreaker.canExecute('windborne-proxy')
  ) {
    const fetchProxySnapshot = async (fileName: string): Promise<unknown[]> => {
      const url = `/api-proxy/windborne/treasure/${fileName}`;
      const rawText = await fetchTextWithTimeout(url, {
        timeoutMs,
        signal: options.signal,
      });
      const trimmed = rawText.trim();
      if (!trimmed || isHtmlPayload(trimmed)) {
        throw new WindBorneProxyUnavailableError(
          `Static HTML response from windborne-proxy (${fileName})`
        );
      }
      const parsed = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error(`Invalid WindBorne array from proxy (${fileName})`);
      }
      return parsed;
    };

    const [r0, r1, r2] = await Promise.allSettled([
      fetchProxySnapshot('00.json'),
      fetchProxySnapshot('01.json'),
      fetchProxySnapshot('02.json'),
    ]);

    if (r0.status === 'fulfilled') {
      windborneCircuitBreaker.recordSuccess('windborne-proxy');
      const t0 = r0.value;
      const t1 = r1.status === 'fulfilled' ? r1.value : null;
      const t2 = r2.status === 'fulfilled' ? r2.value : null;
      if (t0.length > 0) {
        await writeWindborneCacheToIdb({
          key: WINDBORNE_CACHE_KEY,
          fetchedAtMs: nowMs,
          dataTimestampMs: nowMs,
          provider: 'vite-proxy:windborne',
          t0,
          t1,
          t2,
        });
      }
      return {
        entities: parseWindBorneConstellation(t0, t1, t2, observer, {
          timestampMs: nowMs,
          prevMap,
          isCachedSeed: false,
        }),
        status: 'live',
        provider: 'vite-proxy:windborne',
        timestampMs: nowMs,
      };
    }

    const proxyErr = r0.reason;
    if (
      proxyErr instanceof WindBorneProxyUnavailableError ||
      (proxyErr instanceof HttpError && (proxyErr.status === 404 || proxyErr.status === 405))
    ) {
      windborneProxyUnavailable = true;
      windborneCircuitBreaker.reset('windborne-proxy');
    } else {
      windborneCircuitBreaker.recordFailure('windborne-proxy', proxyErr);
      errors.push(
        `windborne-proxy: ${proxyErr instanceof Error ? proxyErr.message : String(proxyErr)}`
      );
    }
  } else if (isLocalDevOrLanRuntime() && !windborneProxyUnavailable) {
    errors.push('windborne-proxy: circuit open');
  }

  // Tier 2a: Zero-preflight CORS simple-GET relay via r.jina.ai (no custom headers!)
  if (windborneCircuitBreaker.canExecute('windborne-relay')) {
    const bucket5m = Math.floor(nowMs / WINDBORNE_TTL_MS);
    const fetchRelayedSnapshot = async (
      fileName: string
    ): Promise<{ arr: unknown[]; publishedTimeMs?: number }> => {
      const url = `https://r.jina.ai/https://a.windbornesystems.com/treasure/${fileName}?_=${bucket5m}`;
      const rawText = await fetchTextWithTimeout(url, {
        timeoutMs: relayTimeoutMs,
        signal: options.signal,
      });
      const relayed = extractRelayedJsonValue(rawText, 'cors-relay:windborne');
      if (!Array.isArray(relayed.value)) {
        throw new Error(`Invalid WindBorne array from cors-relay (${fileName})`);
      }
      return { arr: relayed.value, publishedTimeMs: relayed.publishedTimeMs };
    };

    const [r0, r1, r2] = await Promise.allSettled([
      fetchRelayedSnapshot('00.json'),
      fetchRelayedSnapshot('01.json'),
      fetchRelayedSnapshot('02.json'),
    ]);

    if (r0.status === 'fulfilled') {
      windborneCircuitBreaker.recordSuccess('windborne-relay');
      const t0 = r0.value.arr;
      const t1 = r1.status === 'fulfilled' ? r1.value.arr : null;
      const t2 = r2.status === 'fulfilled' ? r2.value.arr : null;
      const dataTimestampMs = r0.value.publishedTimeMs ?? nowMs;
      if (t0.length > 0) {
        await writeWindborneCacheToIdb({
          key: WINDBORNE_CACHE_KEY,
          fetchedAtMs: nowMs,
          dataTimestampMs,
          provider: 'cors-relay:windborne',
          t0,
          t1,
          t2,
        });
      }
      return {
        entities: parseWindBorneConstellation(t0, t1, t2, observer, {
          timestampMs: dataTimestampMs,
          prevMap,
          isCachedSeed: false,
        }),
        status: 'live',
        provider: 'cors-relay:windborne',
        timestampMs: dataTimestampMs,
      };
    }

    windborneCircuitBreaker.recordFailure('windborne-relay', r0.reason);
    errors.push(
      `windborne-relay: ${r0.reason instanceof Error ? r0.reason.message : String(r0.reason)}`
    );
  } else {
    errors.push('windborne-relay: circuit open');
  }

  // Tier 2b: Direct WindBorne Systems fetch (zero custom headers)
  if (windborneCircuitBreaker.canExecute('windborne-direct')) {
    const fetchDirectSnapshot = async (fileName: string): Promise<unknown[]> => {
      const url = `https://a.windbornesystems.com/treasure/${fileName}`;
      const rawText = await fetchTextWithTimeout(url, {
        timeoutMs,
        signal: options.signal,
      });
      const parsed = extractRelayedJsonValue(rawText, 'windborne-direct');
      if (!Array.isArray(parsed.value)) {
        throw new Error(`Invalid WindBorne array from direct (${fileName})`);
      }
      return parsed.value;
    };

    const [r0, r1, r2] = await Promise.allSettled([
      fetchDirectSnapshot('00.json'),
      fetchDirectSnapshot('01.json'),
      fetchDirectSnapshot('02.json'),
    ]);

    if (r0.status === 'fulfilled') {
      windborneCircuitBreaker.recordSuccess('windborne-direct');
      const t0 = r0.value;
      const t1 = r1.status === 'fulfilled' ? r1.value : null;
      const t2 = r2.status === 'fulfilled' ? r2.value : null;
      if (t0.length > 0) {
        await writeWindborneCacheToIdb({
          key: WINDBORNE_CACHE_KEY,
          fetchedAtMs: nowMs,
          dataTimestampMs: nowMs,
          provider: 'windborne-direct',
          t0,
          t1,
          t2,
        });
      }
      return {
        entities: parseWindBorneConstellation(t0, t1, t2, observer, {
          timestampMs: nowMs,
          prevMap,
          isCachedSeed: false,
        }),
        status: 'live',
        provider: 'windborne-direct',
        timestampMs: nowMs,
      };
    }

    windborneCircuitBreaker.recordFailure('windborne-direct', r0.reason);
    errors.push(
      `windborne-direct: ${r0.reason instanceof Error ? r0.reason.message : String(r0.reason)}`
    );
  } else {
    errors.push('windborne-direct: circuit open');
  }

  // If live+relay failed on a forced refresh while IDB/memory cache is still fresh (<5 min), preserve it
  if (hasFreshCache && cached) {
    return {
      entities: parseWindBorneConstellation(cached.t0, cached.t1, cached.t2, observer, {
        timestampMs: cached.dataTimestampMs,
        prevMap,
        isCachedSeed: false,
      }),
      status: 'cached',
      provider: cached.provider,
      timestampMs: cached.dataTimestampMs,
      errorMsg: errors.length > 0 ? errors.join(' | ') : undefined,
    };
  }

  // Tier 3: Fallback build-time seed ONLY when live + relay fail and IDB/memory cache is empty or expired
  try {
    const seedRaw = await fetchJsonWithTimeout<unknown>('./data/windborne-balloons.json', {
      timeoutMs: 4000,
      signal: options.signal,
    });
    if (seedRaw && typeof seedRaw === 'object' && !Array.isArray(seedRaw)) {
      const seedObj = seedRaw as {
        capturedAtMs?: unknown;
        t0?: unknown;
        t1?: unknown;
        t2?: unknown;
      };
      if (
        typeof seedObj.capturedAtMs === 'number' &&
        Number.isFinite(seedObj.capturedAtMs) &&
        Array.isArray(seedObj.t0) &&
        seedObj.t0.length > 0
      ) {
        const t1 = Array.isArray(seedObj.t1) ? seedObj.t1 : null;
        const t2 = Array.isArray(seedObj.t2) ? seedObj.t2 : null;
        return {
          entities: parseWindBorneConstellation(seedObj.t0, t1, t2, observer, {
            timestampMs: seedObj.capturedAtMs,
            prevMap,
            isCachedSeed: true,
          }),
          status: 'cached',
          provider: 'seeded-windborne',
          timestampMs: seedObj.capturedAtMs,
          errorMsg: errors.length > 0 ? errors.join(' | ') : undefined,
        };
      }
    }
    errors.push('windborne-seed: invalid or empty seed bundle');
  } catch (seedErr) {
    errors.push(
      `windborne-seed: ${seedErr instanceof Error ? seedErr.message : String(seedErr)}`
    );
  }

  return {
    entities: [],
    status: 'error',
    provider: 'windborne',
    timestampMs: 0,
    errorMsg: errors.join(' | '),
  };
}

function toPrevBalloonMap(
  prevEntities?: Map<string, BalloonEntity> | BalloonEntity[]
): Map<string, BalloonEntity> {
  if (!prevEntities) return new Map();
  if (prevEntities instanceof Map) return prevEntities;
  const map = new Map<string, BalloonEntity>();
  for (const item of prevEntities) {
    map.set(item.id, item);
  }
  return map;
}

/**
 * Fetch active weather radiosondes and amateur high-altitude balloons via SondeHub v2 CORS API
 * and optionally the global WindBorne Systems sounding constellation.
 * Computes nearestSondeHint if 0 local balloons fall inside radiusKm.
 */
export async function fetchBalloons(
  observer: ObserverLocation,
  radiusKm: number,
  prevEntities?: Map<string, BalloonEntity> | BalloonEntity[],
  options: BalloonsFetchOptions = {}
): Promise<BalloonsFetchResult> {
  if (options.force === true || options.resetBreakers === true) {
    balloonsCircuitBreaker.reset();
    windborneCircuitBreaker.reset();
  }
  if (options.resetBreakers === true) {
    windborneProxyUnavailable = false;
  }

  const scope: AtmosphericScope = options.scope ?? 'local';
  const includeWindBorne = options.includeWindBorne ?? scope === 'global';
  const includeSondeHub = options.includeSondeHub ?? true;

  const prevMap = toPrevBalloonMap(prevEntities);
  const timeoutMs = options.timeoutMs ?? SONDE_TIMEOUT_MS;
  const radiusM = Math.max(10_000, Math.round(radiusKm * 1000));
  const sondeDistanceM =
    scope === 'global' ? Math.max(radiusKm, 600) * 1000 : radiusM;
  const latStr = observer.lat.toFixed(4);
  const lonStr = observer.lon.toFixed(4);

  const sondesUrl = `https://api.v2.sondehub.org/sondes?lat=${latStr}&lon=${lonStr}&distance=${Math.round(sondeDistanceM)}&last=10800`;
  const amateurUrl = `https://api.v2.sondehub.org/amateur?last=21600`;

  const sondePromise: Promise<
    [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]
  > = includeSondeHub
    ? Promise.allSettled([
        balloonsCircuitBreaker.execute(
          () => fetchJsonWithTimeout<unknown>(sondesUrl, { timeoutMs, signal: options.signal }),
          'sondehub-sondes'
        ),
        balloonsCircuitBreaker.execute(
          () => fetchJsonWithTimeout<unknown>(amateurUrl, { timeoutMs, signal: options.signal }),
          'sondehub-amateur'
        ),
      ])
    : Promise.resolve([
        { status: 'rejected', reason: new Error('SondeHub disabled') },
        { status: 'rejected', reason: new Error('SondeHub disabled') },
      ]);

  const windbornePromise: Promise<WindBorneFetchResult | null> = includeWindBorne
    ? fetchWindBorneConstellation(observer, prevMap, options)
    : Promise.resolve(null);

  const [[sondesRes, amateurRes], windborneRes] = await Promise.all([
    sondePromise,
    windbornePromise,
  ]);

  const sondeErrors = includeSondeHub
    ? [sondesRes, amateurRes]
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
    : [];

  const sondeAllRejected =
    !includeSondeHub ||
    (sondesRes.status === 'rejected' && amateurRes.status === 'rejected');

  if (!includeWindBorne && sondeAllRejected) {
    const msg = sondeErrors.join(' | ');
    return {
      entities: [],
      status: 'error',
      provider: 'sondehub-v2',
      timestampMs: Date.now(),
      nearestSondeHint: null,
      sourceCounts: { windborne: 0, sondehub: 0 },
      errorMsg: msg,
    };
  }

  const byId = new Map<string, BalloonEntity>();
  let windborneCount = 0;
  let sondehubCount = 0;
  let nearestOutside: { entity: BalloonEntity; distKm: number; bearingDeg: number } | null = null;

  const considerOutside = (entity: BalloonEntity) => {
    const distKm = entity.topocentric.groundDistKm;
    if (!nearestOutside || distKm < nearestOutside.distKm) {
      nearestOutside = {
        entity,
        distKm,
        bearingDeg: computeBearingDeg(observer.lat, observer.lon, entity.lat, entity.lon),
      };
    }
  };

  if (windborneRes) {
    for (const entity of windborneRes.entities) {
      if (scope === 'global' || entity.topocentric.groundDistKm <= radiusKm * 1.05) {
        byId.set(entity.id, entity);
        windborneCount += 1;
      }
    }
  }

  if (includeSondeHub && sondesRes.status === 'fulfilled') {
    for (const item of extractRecordsFromPayload(sondesRes.value)) {
      const entity = normalizeSondeRecord(item.raw, observer, {
        isAmateur: false,
        keyHint: item.keyHint,
        prev: prevMap.get(`balloon:${asStr(item.raw.serial) ?? item.keyHint ?? ''}`),
      });
      if (!entity) continue;
      if (scope === 'global' || entity.topocentric.groundDistKm <= radiusKm * 1.05) {
        if (!byId.has(entity.id)) {
          byId.set(entity.id, entity);
          sondehubCount += 1;
        }
      } else {
        considerOutside(entity);
      }
    }
  }

  if (includeSondeHub && amateurRes.status === 'fulfilled') {
    for (const item of extractRecordsFromPayload(amateurRes.value)) {
      const entity = normalizeSondeRecord(item.raw, observer, {
        isAmateur: true,
        keyHint: item.keyHint,
        prev: prevMap.get(
          `balloon:${
            asStr(item.raw.serial) ?? asStr(item.raw.payload_callsign) ?? item.keyHint ?? ''
          }`
        ),
      });
      if (!entity) continue;
      if (scope === 'global' || entity.topocentric.groundDistKm <= radiusKm * 1.05) {
        if (!byId.has(entity.id)) {
          byId.set(entity.id, entity);
          sondehubCount += 1;
        }
      } else {
        considerOutside(entity);
      }
    }
  }

  const entities = Array.from(byId.values());
  let nearestSondeHint: string | null = null;

  if (entities.length === 0 && includeSondeHub && scope === 'local') {
    // Perform widened regional query if no sonde was within radiusKm to compute nearestSondeHint
    if (sondesRes.status === 'fulfilled') {
      try {
        const widenedUrl = `https://api.v2.sondehub.org/sondes?lat=${latStr}&lon=${lonStr}&distance=${WIDENED_SEARCH_METERS}&last=10800`;
        const widenedPayload = await balloonsCircuitBreaker.execute(
          () =>
            fetchJsonWithTimeout<unknown>(widenedUrl, {
              timeoutMs: 3500,
              signal: options.signal,
            }),
          'sondehub-widened'
        );
        for (const item of extractRecordsFromPayload(widenedPayload)) {
          const entity = normalizeSondeRecord(item.raw, observer, {
            isAmateur: false,
            keyHint: item.keyHint,
          });
          if (entity) considerOutside(entity);
        }
      } catch {
        // Non-fatal: amateur nearest or null hint remains intact
      }
    }

    if (nearestOutside !== null) {
      const { entity, distKm, bearingDeg } = nearestOutside as {
        entity: BalloonEntity;
        distKm: number;
        bearingDeg: number;
      };
      const altKmStr = (entity.altM / 1000).toFixed(1);
      nearestSondeHint = `Nearest sonde ${entity.serial} · ${Math.round(distKm)} km ${bearingToCardinal(
        bearingDeg
      )} (${altKmStr} km alt)`;
    }
  }

  const combinedErrors = [
    ...sondeErrors,
    ...(windborneRes?.errorMsg ? [windborneRes.errorMsg] : []),
  ];

  const sondeOk = includeSondeHub && !sondeAllRejected;
  const wbStatus = windborneRes?.status;
  const wbOk = wbStatus === 'live' || wbStatus === 'cached';

  let overallStatus: FeedHealthStatus;
  if (includeWindBorne && includeSondeHub) {
    if (sondeOk && (sondesRes.status === 'fulfilled' || amateurRes.status === 'fulfilled')) {
      overallStatus =
        sondesRes.status === 'rejected' && sondehubCount === 0 && !wbOk
          ? 'error'
          : wbStatus === 'live' || sondeOk
            ? 'live'
            : 'cached';
    } else if (wbOk) {
      overallStatus = wbStatus!;
    } else {
      overallStatus = 'error';
    }
  } else if (includeWindBorne) {
    overallStatus = wbStatus ?? 'error';
  } else {
    overallStatus =
      sondesRes.status === 'rejected' && sondehubCount === 0 ? 'error' : 'live';
  }

  const providerParts: string[] = [];
  if (windborneRes && wbOk) providerParts.push(windborneRes.provider);
  if (sondeOk) providerParts.push('sondehub-v2');
  const provider =
    providerParts.length > 0
      ? providerParts.join('+')
      : windborneRes
        ? `${windborneRes.provider}+sondehub-v2`
        : 'sondehub-v2';

  const timestampMs =
    wbStatus === 'cached' && !sondeOk && windborneRes && windborneRes.timestampMs > 0
      ? windborneRes.timestampMs
      : windborneRes?.timestampMs && !sondeOk
        ? windborneRes.timestampMs
        : Date.now();

  return {
    entities,
    status: overallStatus,
    provider,
    timestampMs,
    nearestSondeHint,
    sourceCounts: {
      windborne: windborneCount,
      sondehub: sondehubCount,
    },
    windborneStatus: windborneRes?.status,
    errorMsg: combinedErrors.length > 0 ? combinedErrors.join(' | ') : undefined,
  };
}
