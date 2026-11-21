import type {
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
import { CircuitBreaker, fetchJsonWithTimeout } from './httpClient';

const MAX_TRAIL_POINTS = 24;
const SONDE_TIMEOUT_MS = 5000;
const WIDENED_SEARCH_METERS = 1_000_000;

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
  errorMsg?: string;
}

export interface BalloonsFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const balloonsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
});

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
    freqMHz,
    tempC,
    pressureHPa,
    humidityPct,
    burstState,
    uploaderCallsign,
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
 * Fetch active weather radiosondes and amateur high-altitude balloons via SondeHub v2 CORS API.
 * Computes nearestSondeHint if 0 balloons fall inside radiusKm.
 */
export async function fetchBalloons(
  observer: ObserverLocation,
  radiusKm: number,
  prevEntities?: Map<string, BalloonEntity> | BalloonEntity[],
  options: BalloonsFetchOptions = {}
): Promise<BalloonsFetchResult> {
  const prevMap = toPrevBalloonMap(prevEntities);
  const timeoutMs = options.timeoutMs ?? SONDE_TIMEOUT_MS;
  const radiusM = Math.max(10_000, Math.round(radiusKm * 1000));
  const latStr = observer.lat.toFixed(4);
  const lonStr = observer.lon.toFixed(4);

  const sondesUrl = `https://api.v2.sondehub.org/sondes?lat=${latStr}&lon=${lonStr}&distance=${radiusM}&last=10800`;
  const amateurUrl = `https://api.v2.sondehub.org/amateur?last=21600`;

  const [sondesRes, amateurRes] = await Promise.allSettled([
    balloonsCircuitBreaker.execute(
      () => fetchJsonWithTimeout<unknown>(sondesUrl, { timeoutMs, signal: options.signal }),
      'sondehub-sondes'
    ),
    balloonsCircuitBreaker.execute(
      () => fetchJsonWithTimeout<unknown>(amateurUrl, { timeoutMs, signal: options.signal }),
      'sondehub-amateur'
    ),
  ]);

  const partialErrors = [sondesRes, amateurRes]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));

  if (sondesRes.status === 'rejected' && amateurRes.status === 'rejected') {
    const msg = partialErrors.join(' | ');
    return {
      entities: [],
      status: 'error',
      provider: 'sondehub-v2',
      timestampMs: Date.now(),
      nearestSondeHint: null,
      errorMsg: msg,
    };
  }

  const byId = new Map<string, BalloonEntity>();
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

  if (sondesRes.status === 'fulfilled') {
    for (const item of extractRecordsFromPayload(sondesRes.value)) {
      const entity = normalizeSondeRecord(item.raw, observer, {
        isAmateur: false,
        keyHint: item.keyHint,
        prev: prevMap.get(`balloon:${asStr(item.raw.serial) ?? item.keyHint ?? ''}`),
      });
      if (!entity) continue;
      if (entity.topocentric.groundDistKm <= radiusKm * 1.05) {
        byId.set(entity.id, entity);
      } else {
        considerOutside(entity);
      }
    }
  }

  if (amateurRes.status === 'fulfilled') {
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
      if (entity.topocentric.groundDistKm <= radiusKm * 1.05) {
        if (!byId.has(entity.id)) {
          byId.set(entity.id, entity);
        }
      } else {
        considerOutside(entity);
      }
    }
  }

  const entities = Array.from(byId.values());
  let nearestSondeHint: string | null = null;

  if (entities.length === 0) {
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

  return {
    entities,
    status: sondesRes.status === 'rejected' && entities.length === 0 ? 'error' : 'live',
    provider: 'sondehub-v2',
    timestampMs: Date.now(),
    nearestSondeHint,
    errorMsg: partialErrors.length > 0 ? partialErrors.join(' | ') : undefined,
  };
}
