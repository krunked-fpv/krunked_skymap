import type {
  AirspaceData,
  DroneEntity,
  ObserverLocation,
  TrailPoint,
} from '../types/sky-contracts';
import { evaluateDroneAirspaceCompliance } from './airspaceService';
import {
  computeTopocentricLookAngles,
  greatCircleDestination,
  haversineDistanceKm,
  normalizeAzimuthDeg,
  normalizeLonDeg,
  pointInGeoJsonFeature,
} from './geoHelpers';
import { fetchJsonWithTimeout } from './httpClient';

const FT_TO_M = 0.3048;
const MAX_TRAIL_POINTS = 24;

interface SimDroneSpec {
  uasId: string;
  callsign: string;
  uaType: DroneEntity['uaType'];
  missionDesc: string;
  centerBearingDeg: number;
  centerDistKm: number;
  orbitRadiusKm: number;
  angularSpeedRadPerSec: number;
  phaseOffsetRad: number;
  baseAltAglM: number;
  vertOscM: number;
  operatorOffsetBearingDeg: number;
  operatorOffsetDistKm: number;
  preferUasfmCell?: boolean;
}

const SIM_DRONE_SPECS: readonly SimDroneSpec[] = [
  {
    uasId: 'SIM-ODID-X10-01',
    callsign: 'SKYDIO-X10-01',
    uaType: 'multirotor',
    missionDesc: 'Bridge & Infrastructure Inspection',
    centerBearingDeg: 42,
    centerDistKm: 1.8,
    orbitRadiusKm: 0.35,
    angularSpeedRadPerSec: 0.045,
    phaseOffsetRad: 0.2,
    baseAltAglM: 215 * FT_TO_M,
    vertOscM: 2.5,
    operatorOffsetBearingDeg: 210,
    operatorOffsetDistKm: 0.32,
  },
  {
    uasId: 'SIM-ODID-M350-02',
    callsign: 'MATRICE-350-SAR',
    uaType: 'multirotor',
    missionDesc: 'Corridor Thermal Photogrammetry',
    centerBearingDeg: 308,
    centerDistKm: 2.5,
    orbitRadiusKm: 0.5,
    angularSpeedRadPerSec: -0.036,
    phaseOffsetRad: 1.7,
    baseAltAglM: 295 * FT_TO_M,
    vertOscM: 3.0,
    operatorOffsetBearingDeg: 135,
    operatorOffsetDistKm: 0.55,
  },
  {
    uasId: 'SIM-ODID-VTOL-03',
    callsign: 'WINGTRA-VTOL-03',
    uaType: 'vtol',
    missionDesc: 'BVLOS Corridor LiDAR Mapping',
    centerBearingDeg: 225,
    centerDistKm: 3.4,
    orbitRadiusKm: 0.85,
    angularSpeedRadPerSec: 0.032,
    phaseOffsetRad: 3.1,
    baseAltAglM: 360 * FT_TO_M,
    vertOscM: 4.0,
    operatorOffsetBearingDeg: 45,
    operatorOffsetDistKm: 0.85,
  },
  {
    uasId: 'SIM-ODID-BRCH-04',
    callsign: 'UAS-BREACH-480',
    uaType: 'fixed-wing',
    missionDesc: 'High-AGL Controlled Airspace Excursion',
    centerBearingDeg: 138,
    centerDistKm: 1.4,
    orbitRadiusKm: 0.14,
    angularSpeedRadPerSec: 0.06,
    phaseOffsetRad: 4.4,
    baseAltAglM: 480 * FT_TO_M, // 480 ft AGL -> triggers live UASFM BREACH in <=400ft cells
    vertOscM: 0,
    operatorOffsetBearingDeg: 320,
    operatorOffsetDistKm: 0.42,
    preferUasfmCell: true,
  },
];

function extractPolygonCentroid(feature: GeoJSON.Feature): { lat: number; lon: number } | null {
  const geom = feature.geometry;
  if (!geom) return null;
  let ring: number[][] | undefined;
  if (geom.type === 'Polygon') {
    ring = geom.coordinates[0];
  } else if (geom.type === 'MultiPolygon') {
    ring = geom.coordinates[0]?.[0];
  }
  if (!ring || ring.length < 3) return null;

  let sumLon = 0;
  let sumLat = 0;
  let count = 0;
  // Exclude duplicate closing vertex if present
  const limit =
    ring.length > 3 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;

  for (let i = 0; i < limit; i += 1) {
    const pt = ring[i];
    if (pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
      sumLon += pt[0];
      sumLat += pt[1];
      count += 1;
    }
  }
  if (count === 0) return null;
  const lat = sumLat / count;
  const lon = sumLon / count;
  if (!pointInGeoJsonFeature(lon, lat, feature)) return null;
  return { lat, lon };
}

function findControlledUasfmCellCenter(
  observer: ObserverLocation,
  radiusKm: number,
  airspace: AirspaceData
): { lat: number; lon: number } | null {
  const features = airspace.uasfm?.features ?? [];
  if (features.length === 0) return null;

  let bestControlled: { lat: number; lon: number; distKm: number } | null = null;
  let bestAny: { lat: number; lon: number; distKm: number } | null = null;

  for (const feat of features) {
    const center = extractPolygonCentroid(feat);
    if (!center) continue;
    const distKm = haversineDistanceKm(observer.lat, observer.lon, center.lat, center.lon);
    if (distKm > Math.max(15, radiusKm)) continue;

    const rawCeiling = (feat.properties as Record<string, unknown> | null)?.CEILING;
    const ceiling =
      typeof rawCeiling === 'number'
        ? rawCeiling
        : typeof rawCeiling === 'string'
          ? Number.parseFloat(rawCeiling)
          : Number.NaN;

    if (!bestAny || distKm < bestAny.distKm) {
      bestAny = { ...center, distKm };
    }
    if (Number.isFinite(ceiling) && ceiling < 480) {
      if (!bestControlled || distKm < bestControlled.distKm) {
        bestControlled = { ...center, distKm };
      }
    }
  }

  return bestControlled ?? bestAny;
}

function toPrevDroneMap(
  prevDrones?: Map<string, DroneEntity> | DroneEntity[]
): Map<string, DroneEntity> {
  if (!prevDrones) return new Map();
  if (prevDrones instanceof Map) return prevDrones;
  const map = new Map<string, DroneEntity>();
  for (const item of prevDrones) {
    map.set(item.id, item);
  }
  return map;
}

function appendDroneTrail(
  prev: DroneEntity | undefined,
  lon: number,
  lat: number,
  altM: number,
  ts: number
): TrailPoint[] {
  const base = prev?.trail ? [...prev.trail] : [];
  const last = base[base.length - 1];
  if (
    !last ||
    Math.abs(last.lat - lat) > 5e-6 ||
    Math.abs(last.lon - lon) > 5e-6 ||
    Math.abs(ts - last.ts) > 900
  ) {
    base.push({ lon, lat, altM, ts });
  }
  return base.length > MAX_TRAIL_POINTS ? base.slice(base.length - MAX_TRAIL_POINTS) : base;
}

/**
 * Advance 4 simulated ASTM F3411 Remote ID drones around observer,
 * including 1 drone at 480 ft AGL positioned to trigger live UASFM BREACH near controlled airspace.
 */
export function stepSimulatedDrones(
  observer: ObserverLocation,
  radiusKm: number,
  elapsedSec: number,
  airspace: AirspaceData,
  prevDrones?: Map<string, DroneEntity> | DroneEntity[]
): DroneEntity[] {
  const prevMap = toPrevDroneMap(prevDrones);
  const nowMs = Date.now();
  const scaleFactor = radiusKm < 12 ? Math.max(0.25, radiusKm / 12) : 1;
  const uasfmAnchor = findControlledUasfmCellCenter(observer, radiusKm, airspace);

  return SIM_DRONE_SPECS.map((spec) => {
    const id = `drone:${spec.uasId}`;
    const prev = prevMap.get(id);

    const orbitCenter =
      spec.preferUasfmCell && uasfmAnchor
        ? uasfmAnchor
        : greatCircleDestination(
            observer.lat,
            observer.lon,
            spec.centerBearingDeg,
            spec.centerDistKm * scaleFactor
          );

    const angleRad = spec.phaseOffsetRad + elapsedSec * spec.angularSpeedRadPerSec;
    const radialBearingDeg = normalizeAzimuthDeg((angleRad * 180) / Math.PI);
    const orbitR = spec.orbitRadiusKm * (spec.preferUasfmCell && uasfmAnchor ? 1 : scaleFactor);
    const pos = greatCircleDestination(orbitCenter.lat, orbitCenter.lon, radialBearingDeg, orbitR);

    // Tangent velocity and heading along circular track
    const dirSign = spec.angularSpeedRadPerSec >= 0 ? 1 : -1;
    const headingDeg = normalizeAzimuthDeg(radialBearingDeg + dirSign * 90);
    const speedMs = Math.abs(spec.angularSpeedRadPerSec) * orbitR * 1000;

    const vertPhase = angleRad * 2;
    const altAglM = Math.max(
      10,
      spec.baseAltAglM + spec.vertOscM * Math.sin(vertPhase)
    );
    const vertRateMs = spec.vertOscM * spec.angularSpeedRadPerSec * 2 * Math.cos(vertPhase);
    const altM = (observer.altM ?? 0) + altAglM;

    const operatorPos = greatCircleDestination(
      orbitCenter.lat,
      orbitCenter.lon,
      spec.operatorOffsetBearingDeg,
      spec.operatorOffsetDistKm * scaleFactor
    );
    const operatorDistM =
      haversineDistanceKm(pos.lat, pos.lon, operatorPos.lat, operatorPos.lon) * 1000;

    const compliance = evaluateDroneAirspaceCompliance(pos.lat, pos.lon, altAglM, airspace);
    const topocentric = computeTopocentricLookAngles(observer, {
      lat: pos.lat,
      lon: pos.lon,
      altM,
    });

    const emergencyFlag = compliance.tfrBreach
      ? 'TFR / SUA BREACH'
      : compliance.ceilingBreach
        ? 'UASFM BREACH'
        : undefined;

    const altFt = Math.round(altAglM / FT_TO_M);
    return {
      id,
      category: 'drone',
      callsign: spec.callsign,
      subtitle: `${spec.uaType.toUpperCase()} · ${altFt}ft AGL · ${spec.missionDesc}`,
      country: 'SIM-ODID · ASTM F3411',
      lat: pos.lat,
      lon: normalizeLonDeg(pos.lon),
      altM,
      speedMs,
      headingDeg,
      vertRateMs,
      timestampMs: nowMs,
      topocentric,
      trail: appendDroneTrail(prev, pos.lon, pos.lat, altM, nowMs),
      isSimulated: true,
      emergencyFlag,
      uasId: spec.uasId,
      uaType: spec.uaType,
      altAglM,
      operatorLat: operatorPos.lat,
      operatorLon: normalizeLonDeg(operatorPos.lon),
      operatorDistM,
      missionDesc: spec.missionDesc,
      faaCeilingFt: compliance.faaCeilingFt,
      ceilingBreach: compliance.ceilingBreach,
      tfrBreach: compliance.tfrBreach,
    };
  });
}

function asFinite(val: unknown): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function asStr(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const s = val.trim();
  return s.length > 0 ? s : undefined;
}

function normalizeUaType(val: unknown): DroneEntity['uaType'] {
  const s = String(val ?? '').toLowerCase();
  if (s.includes('fixed') || s.includes('wing') || s === '1') return 'fixed-wing';
  if (s.includes('vtol') || s.includes('hybrid') || s === '3') return 'vtol';
  return 'multirotor';
}

function normalizeSingleOdidObject(
  rawObj: Record<string, unknown>,
  observer: ObserverLocation,
  airspace: AirspaceData,
  prevMap: Map<string, DroneEntity>,
  index: number
): DroneEntity | null {
  const basic = (rawObj.BasicID ?? rawObj.basicId ?? {}) as Record<string, unknown>;
  const loc = (rawObj.Location ?? rawObj.location ?? {}) as Record<string, unknown>;
  const sys = (rawObj.System ?? rawObj.system ?? {}) as Record<string, unknown>;

  const uasId =
    asStr(rawObj.uasId) ??
    asStr(rawObj.uas_id) ??
    asStr(rawObj.id) ??
    asStr(basic.UASID) ??
    asStr(basic.uasId) ??
    asStr(rawObj.mac) ??
    `ODID-${index + 1}`;

  const lat =
    asFinite(rawObj.lat) ??
    asFinite(rawObj.latitude) ??
    asFinite(loc.Latitude) ??
    asFinite(loc.lat);
  const lon =
    asFinite(rawObj.lon) ??
    asFinite(rawObj.lng) ??
    asFinite(rawObj.longitude) ??
    asFinite(loc.Longitude) ??
    asFinite(loc.lon);

  if (
    lat === undefined ||
    lon === undefined ||
    (lat === 0 && lon === 0) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }

  const altAglM = Math.max(
    0,
    asFinite(rawObj.altAglM) ??
      asFinite(rawObj.alt_agl) ??
      asFinite(rawObj.height) ??
      asFinite(loc.Height) ??
      asFinite(rawObj.alt) ??
      45
  );
  const altGeoM =
    asFinite(rawObj.altM) ??
    asFinite(rawObj.alt_geo) ??
    asFinite(loc.AltitudeGeo) ??
    asFinite(rawObj.alt);
  const altM = altGeoM !== undefined ? altGeoM : (observer.altM ?? 0) + altAglM;

  const speedMs = Math.max(
    0,
    asFinite(rawObj.speedMs) ??
      asFinite(rawObj.speed_h) ??
      asFinite(rawObj.speed) ??
      asFinite(loc.SpeedHorizontal) ??
      0
  );
  const headingDeg = normalizeAzimuthDeg(
    asFinite(rawObj.headingDeg) ??
      asFinite(rawObj.heading) ??
      asFinite(rawObj.direction) ??
      asFinite(rawObj.track) ??
      asFinite(loc.Direction) ??
      0
  );
  const vertRateMs =
    asFinite(rawObj.vertRateMs) ??
    asFinite(rawObj.speed_v) ??
    asFinite(rawObj.vert_speed) ??
    asFinite(loc.SpeedVertical) ??
    0;

  let operatorLat =
    asFinite(rawObj.operatorLat) ??
    asFinite(rawObj.operator_lat) ??
    asFinite(sys.OperatorLatitude) ??
    lat;
  let operatorLon =
    asFinite(rawObj.operatorLon) ??
    asFinite(rawObj.operator_lon) ??
    asFinite(sys.OperatorLongitude) ??
    lon;

  if (
    (operatorLat === 0 && operatorLon === 0) ||
    operatorLat < -90 ||
    operatorLat > 90 ||
    operatorLon < -180 ||
    operatorLon > 180
  ) {
    operatorLat = lat;
    operatorLon = lon;
  }

  const operatorDistM = haversineDistanceKm(lat, lon, operatorLat, operatorLon) * 1000;
  const uaType = normalizeUaType(rawObj.uaType ?? rawObj.ua_type ?? basic.UAType);
  const callsign = asStr(rawObj.callsign) ?? uasId;
  const missionDesc = asStr(rawObj.missionDesc) ?? asStr(rawObj.description) ?? 'Live Remote ID Broadcast';

  const id = `drone:${uasId}`;
  const prev = prevMap.get(id);
  const nowMs = Date.now();
  const compliance = evaluateDroneAirspaceCompliance(lat, lon, altAglM, airspace);
  const topocentric = computeTopocentricLookAngles(observer, { lat, lon, altM });

  const emergencyFlag = compliance.tfrBreach
    ? 'TFR / SUA BREACH'
    : compliance.ceilingBreach
      ? 'UASFM BREACH'
      : undefined;

  return {
    id,
    category: 'drone',
    callsign,
    subtitle: `${uaType.toUpperCase()} · ${Math.round(altAglM / FT_TO_M)}ft AGL · LIVE ODID`,
    country: 'OpenDroneID',
    lat,
    lon: normalizeLonDeg(lon),
    altM,
    speedMs,
    headingDeg,
    vertRateMs,
    timestampMs: nowMs,
    topocentric,
    trail: appendDroneTrail(prev, lon, lat, altM, nowMs),
    isSimulated: false,
    emergencyFlag,
    uasId,
    uaType,
    altAglM,
    operatorLat,
    operatorLon: normalizeLonDeg(operatorLon),
    operatorDistM,
    missionDesc,
    faaCeilingFt: compliance.faaCeilingFt,
    ceilingBreach: compliance.ceilingBreach,
    tfrBreach: compliance.tfrBreach,
  };
}

/**
 * Normalize live ASTM F3411 / OpenDroneID JSON payloads (single object, array, or wrapped list).
 */
export function normalizeOdidPayload(
  payload: unknown,
  observer: ObserverLocation,
  airspace: AirspaceData,
  prevDrones?: Map<string, DroneEntity> | DroneEntity[]
): DroneEntity[] {
  if (!payload || typeof payload !== 'object') return [];
  const prevMap = toPrevDroneMap(prevDrones);

  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else {
    const obj = payload as Record<string, unknown>;
    const candidate =
      obj.drones ?? obj.targets ?? obj.aircraft ?? obj.messages ?? obj.data;
    if (Array.isArray(candidate)) {
      items = candidate;
    } else {
      items = [obj];
    }
  }

  const out: DroneEntity[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i += 1) {
    const raw = items[i];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entity = normalizeSingleOdidObject(
      raw as Record<string, unknown>,
      observer,
      airspace,
      prevMap,
      i
    );
    if (entity && !seen.has(entity.id)) {
      seen.add(entity.id);
      out.push(entity);
    }
  }
  return out;
}

export interface OpenDroneIdClientCallbacks {
  onDrones: (drones: DroneEntity[]) => void;
  onStatus?: (status: { transport: 'off' | 'ws' | 'http'; connected: boolean; lastError?: string }) => void;
}

/**
 * Live OpenDroneID stream client supporting ws:// / wss:// WebSockets and http(s):// JSON polling.
 */
export class OpenDroneIdClient {
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private abortCtrl: AbortController | null = null;
  private observer: ObserverLocation;
  private airspace: AirspaceData;
  private latestDrones = new Map<string, DroneEntity>();
  private callbacks: OpenDroneIdClientCallbacks;

  constructor(
    observer: ObserverLocation,
    airspace: AirspaceData,
    callbacks: OpenDroneIdClientCallbacks
  ) {
    this.observer = observer;
    this.airspace = airspace;
    this.callbacks = callbacks;
  }

  updateContext(observer: ObserverLocation, airspace: AirspaceData): void {
    this.observer = observer;
    this.airspace = airspace;
  }

  connect(endpointUrl: string, pollIntervalMs = 2000): void {
    this.disconnect();
    const trimmed = endpointUrl.trim();
    if (!trimmed) {
      this.callbacks.onStatus?.({ transport: 'off', connected: false });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      this.callbacks.onStatus?.({
        transport: 'off',
        connected: false,
        lastError: 'Invalid OpenDroneID URL',
      });
      return;
    }

    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      this.connectWebSocket(parsed.toString());
    } else if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      this.connectHttpPolling(parsed.toString(), Math.max(500, pollIntervalMs));
    } else {
      this.callbacks.onStatus?.({
        transport: 'off',
        connected: false,
        lastError: `Unsupported protocol "${parsed.protocol}" (use ws://, wss://, http://, or https://)`,
      });
    }
  }

  private connectWebSocket(url: string): void {
    if (typeof WebSocket === 'undefined') {
      this.callbacks.onStatus?.({
        transport: 'ws',
        connected: false,
        lastError: 'WebSocket unavailable in current runtime',
      });
      return;
    }

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.callbacks.onStatus?.({ transport: 'ws', connected: true, lastError: undefined });
      };

      ws.onmessage = (evt: MessageEvent) => {
        if (this.ws !== ws) return;
        try {
          const parsed = typeof evt.data === 'string' ? JSON.parse(evt.data) : evt.data;
          const drones = normalizeOdidPayload(
            parsed,
            this.observer,
            this.airspace,
            this.latestDrones
          );
          const nowMs = Date.now();
          for (const d of drones) {
            this.latestDrones.set(d.id, d);
          }
          for (const [id, existing] of this.latestDrones.entries()) {
            if (nowMs - existing.timestampMs > 120_000) {
              this.latestDrones.delete(id);
            }
          }
          this.callbacks.onDrones(drones);
        } catch {
          // Ignore malformed frame safely
        }
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
        this.callbacks.onStatus?.({
          transport: 'ws',
          connected: false,
          lastError: 'WebSocket connection error',
        });
      };

      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.callbacks.onStatus?.({
          transport: 'ws',
          connected: false,
        });
      };
    } catch (err) {
      this.callbacks.onStatus?.({
        transport: 'ws',
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private connectHttpPolling(url: string, intervalMs: number): void {
    const abortCtrl = new AbortController();
    this.abortCtrl = abortCtrl;
    let inFlight = false;

    const pollOnce = async (): Promise<void> => {
      if (inFlight || abortCtrl.signal.aborted) return;
      inFlight = true;
      try {
        const data = await fetchJsonWithTimeout<unknown>(url, {
          timeoutMs: Math.min(3500, intervalMs),
          signal: abortCtrl.signal,
        });
        if (abortCtrl.signal.aborted) return;
        const drones = normalizeOdidPayload(
          data,
          this.observer,
          this.airspace,
          this.latestDrones
        );
        const nowMs = Date.now();
        for (const d of drones) {
          this.latestDrones.set(d.id, d);
        }
        for (const [id, existing] of this.latestDrones.entries()) {
          if (nowMs - existing.timestampMs > 120_000) {
            this.latestDrones.delete(id);
          }
        }
        this.callbacks.onStatus?.({ transport: 'http', connected: true, lastError: undefined });
        this.callbacks.onDrones(drones);
      } catch (err) {
        if (abortCtrl.signal.aborted) return;
        this.callbacks.onStatus?.({
          transport: 'http',
          connected: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inFlight = false;
      }
    };

    void pollOnce();
    this.pollTimer = setInterval(() => {
      void pollOnce();
    }, intervalMs);
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }

    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.abortCtrl) {
      this.abortCtrl.abort();
      this.abortCtrl = null;
    }

    this.latestDrones.clear();
  }
}
