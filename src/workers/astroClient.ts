import {
  SAT_KINEMATICS_STRIDE,
  type ObserverLocation,
  type OrbitalScope,
  type SatelliteEntity,
  type SatelliteGroup,
  type SatelliteOrbitOverlay,
  type SatelliteWorkerMeta,
  type TleRecord,
  type TrailPoint,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../types/sky-contracts';

const MAX_TRAIL_POINTS = 40;
const TRAIL_SAMPLE_INTERVAL_MS = 4000;
const TRAIL_RESET_GAP_MS = 120_000;
const TICK_TIMEOUT_MS = 2500;

export interface AstroPropagatedPayload {
  timestampMs: number;
  count: number;
  totalLoaded: number;
  satellites: SatelliteEntity[];
}

export interface AstroClientCallbacks {
  onReady?: (info: { count: number; totalParsed: number }) => void;
  onPropagated?: (payload: AstroPropagatedPayload) => void;
  onOrbitOverlay?: (overlay: SatelliteOrbitOverlay) => void;
  onError?: (message: string) => void;
}

export interface AstroClientOptions {
  workerFactory?: () => Worker;
}

/**
 * Unpack a stride-12 Float32Array and parallel SatelliteWorkerMeta array into typed SatelliteEntity objects,
 * maintaining bounded breadcrumb trails (<= 40 points).
 */
export function unpackSatelliteKinematics(
  kinematics: Float32Array,
  meta: SatelliteWorkerMeta[],
  timestampMs: number,
  prevEntities?: ReadonlyMap<string, SatelliteEntity>
): SatelliteEntity[] {
  const count = Math.min(
    meta.length,
    Math.floor(kinematics.length / SAT_KINEMATICS_STRIDE)
  );
  const entities: SatelliteEntity[] = new Array(count);

  for (let i = 0; i < count; i++) {
    const m = meta[i];
    const base = i * SAT_KINEMATICS_STRIDE;

    const lat = kinematics[base + 0];
    const lon = kinematics[base + 1];
    const altM = kinematics[base + 2];
    const speedMs = kinematics[base + 3];
    const headingDeg = kinematics[base + 4];
    const azimuthDeg = kinematics[base + 5];
    const elevationDeg = kinematics[base + 6];
    const slantRangeKm = kinematics[base + 7];
    const groundDistKm = kinematics[base + 8];
    const sunlit = kinematics[base + 9] >= 0.5;
    const radialVelocityKmS = kinematics[base + 10];
    const dopplerHz437MHz = kinematics[base + 11];

    const prev = prevEntities?.get(m.id);
    let trail: TrailPoint[] = prev ? prev.trail.slice() : [];
    const lastPt = trail[trail.length - 1];

    if (lastPt && Math.abs(timestampMs - lastPt.ts) > TRAIL_RESET_GAP_MS) {
      trail = [{ lon, lat, altM, ts: timestampMs }];
    } else if (
      !lastPt ||
      (timestampMs - lastPt.ts >= TRAIL_SAMPLE_INTERVAL_MS &&
        (Math.abs(lat - lastPt.lat) > 0.001 || Math.abs(lon - lastPt.lon) > 0.001))
    ) {
      trail.push({ lon, lat, altM, ts: timestampMs });
      if (trail.length > MAX_TRAIL_POINTS) {
        trail = trail.slice(trail.length - MAX_TRAIL_POINTS);
      }
    }

    entities[i] = {
      id: m.id,
      category: 'satellite',
      callsign: m.name,
      subtitle: `NORAD ${m.noradId} · ${m.group.toUpperCase()}`,
      country: 'ORBITAL',
      lat,
      lon,
      altM,
      speedMs,
      headingDeg,
      vertRateMs: 0,
      timestampMs,
      topocentric: {
        azimuthDeg,
        elevationDeg,
        slantRangeKm,
        groundDistKm,
        belowHorizon: elevationDeg < 0,
      },
      trail,
      noradId: m.noradId,
      group: m.group,
      inclinationDeg: m.inclinationDeg,
      periodMin: m.periodMin,
      apogeeKm: m.apogeeKm,
      perigeeKm: m.perigeeKm,
      sunlit,
      radialVelocityKmS,
      dopplerHz437MHz,
    };
  }

  return entities;
}

/**
 * Main-thread client managing the SGP4 Web Worker lifecycle, transferable Float32Array unpacking,
 * backpressure-guarded ticks, and asynchronous orbit overlay queries.
 */
export class AstroClient {
  private worker: Worker | null = null;
  private callbacks: AstroClientCallbacks;
  private disposed = false;
  private tickInFlight = false;
  private tickStartedAt = 0;
  private previousSatellites = new Map<string, SatelliteEntity>();

  private readyResolvers: Array<{
    resolve: (info: { count: number; totalParsed: number }) => void;
    reject: (reason: Error) => void;
  }> = [];

  private orbitResolvers = new Map<
    number,
    Array<{
      resolve: (overlay: SatelliteOrbitOverlay) => void;
      reject: (reason: Error) => void;
    }>
  >();

  constructor(callbacks: AstroClientCallbacks = {}, options: AstroClientOptions = {}) {
    this.callbacks = callbacks;

    try {
      if (options.workerFactory) {
        this.worker = options.workerFactory();
      } else if (typeof Worker !== 'undefined') {
        this.worker = new Worker(new URL('./astro.worker.ts', import.meta.url), {
          type: 'module',
        });
      }
    } catch (err) {
      this.worker = null;
      const msg = err instanceof Error ? err.message : 'Failed to initialize astro worker';
      this.callbacks.onError?.(msg);
      return;
    }

    if (!this.worker) {
      this.callbacks.onError?.('Web Worker API is unavailable in this environment');
      return;
    }

    this.worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
      if (this.disposed) return;
      this.handleWorkerMessage(event.data);
    };

    this.worker.onerror = (event: ErrorEvent) => {
      if (this.disposed) return;
      this.tickInFlight = false;
      const msg = event.message || 'Astro worker runtime error';
      this.callbacks.onError?.(msg);
      this.rejectPending(new Error(msg));
    };
  }

  setCallbacks(callbacks: AstroClientCallbacks): void {
    this.callbacks = callbacks;
  }

  private post(msg: WorkerRequestMessage): void {
    if (this.disposed || !this.worker) return;
    this.worker.postMessage(msg);
  }

  private handleWorkerMessage(msg: WorkerResponseMessage): void {
    switch (msg.type) {
      case 'ready': {
        const info = { count: msg.count, totalParsed: msg.totalParsed };
        const resolvers = this.readyResolvers.splice(0, this.readyResolvers.length);
        for (const r of resolvers) {
          r.resolve(info);
        }
        this.callbacks.onReady?.(info);
        break;
      }
      case 'propagated': {
        this.tickInFlight = false;
        const satellites = unpackSatelliteKinematics(
          msg.kinematics,
          msg.meta,
          msg.timestampMs,
          this.previousSatellites
        );
        const nextMap = new Map<string, SatelliteEntity>();
        for (let i = 0; i < satellites.length; i++) {
          nextMap.set(satellites[i].id, satellites[i]);
        }
        this.previousSatellites = nextMap;

        this.callbacks.onPropagated?.({
          timestampMs: msg.timestampMs,
          count: msg.count,
          totalLoaded: msg.totalLoaded,
          satellites,
        });
        break;
      }
      case 'orbit-overlay': {
        const queue = this.orbitResolvers.get(msg.overlay.noradId);
        if (queue && queue.length > 0) {
          this.orbitResolvers.delete(msg.overlay.noradId);
          for (const r of queue) {
            r.resolve(msg.overlay);
          }
        }
        this.callbacks.onOrbitOverlay?.(msg.overlay);
        break;
      }
      case 'error': {
        this.tickInFlight = false;
        this.callbacks.onError?.(msg.message);
        break;
      }
    }
  }

  private resolveEmptyPending(): void {
    const readyList = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const r of readyList) {
      r.resolve({ count: 0, totalParsed: 0 });
    }
    for (const [noradId, queue] of this.orbitResolvers) {
      for (const r of queue) {
        r.resolve({
          noradId,
          groundTrackSegments: [],
          passArcAzEl: [],
          footprintRadiusKm: 0,
        });
      }
    }
    this.orbitResolvers.clear();
  }

  private rejectPending(err: Error): void {
    const readyList = this.readyResolvers.splice(0, this.readyResolvers.length);
    for (const r of readyList) {
      r.reject(err);
    }
    for (const [, queue] of this.orbitResolvers) {
      for (const r of queue) {
        r.reject(err);
      }
    }
    this.orbitResolvers.clear();
  }

  initTles(
    records: TleRecord[],
    fullConstellation = false
  ): Promise<{ count: number; totalParsed: number }> {
    if (this.disposed || !this.worker) {
      return Promise.resolve({ count: 0, totalParsed: 0 });
    }
    return new Promise((resolve, reject) => {
      this.readyResolvers.push({ resolve, reject });
      this.post({ type: 'init-tles', records, fullConstellation });
    });
  }

  updateConfig(config: {
    observer: ObserverLocation;
    radiusKm: number;
    orbitalScope: OrbitalScope;
    activeGroups: Record<SatelliteGroup, boolean>;
    fullConstellation?: boolean;
  }): void {
    this.post({
      type: 'update-config',
      observer: config.observer,
      radiusKm: config.radiusKm,
      orbitalScope: config.orbitalScope,
      activeGroups: config.activeGroups,
      fullConstellation: config.fullConstellation,
    });
  }

  tick(timestampMs = Date.now()): void {
    if (this.disposed || !this.worker) return;
    const now = Date.now();
    if (this.tickInFlight && now - this.tickStartedAt < TICK_TIMEOUT_MS) {
      return;
    }
    this.tickInFlight = true;
    this.tickStartedAt = now;
    this.post({ type: 'tick', timestampMs });
  }

  computeOrbit(
    noradId: number,
    timestampMs: number,
    observer: ObserverLocation
  ): Promise<SatelliteOrbitOverlay> {
    if (this.disposed || !this.worker) {
      return Promise.resolve({
        noradId,
        groundTrackSegments: [],
        passArcAzEl: [],
        footprintRadiusKm: 0,
      });
    }
    return new Promise((resolve, reject) => {
      const existing = this.orbitResolvers.get(noradId) ?? [];
      existing.push({ resolve, reject });
      this.orbitResolvers.set(noradId, existing);
      this.post({ type: 'compute-orbit', noradId, timestampMs, observer });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.tickInFlight = false;
    this.previousSatellites.clear();
    this.resolveEmptyPending();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
  }
}
