import { create } from 'zustand';
import {
  OVERHEAD_FALLBACK_MIN_EL_DEG,
  OVERHEAD_PRIMARY_MIN_EL_DEG,
  type AirspaceData,
  type AtmosphericScope,
  type BalloonEntity,
  type BalloonSublayerState,
  type DroneEntity,
  type DroneSublayerState,
  type FeedKey,
  type FeedTelemetryState,
  type FlightEntity,
  type LayoutMode,
  type ObserverLocation,
  type ObserverLocationStatus,
  type OpenDroneIdConfig,
  type OrbitalScope,
  type SatelliteEntity,
  type SatelliteGroup,
  type SatelliteOrbitOverlay,
  type SkyCategory,
  type SkyDomeZoomMode,
  type SkyEntity,
  type UnitSystem,
} from '../types/sky-contracts';
import { haversineDistanceKm, normalizeAzimuthDeg } from '../math/geodesy';

export interface SkyCounts extends Record<SkyCategory, number> {
  overhead: number;
  overheadConeDeg?: 45 | 20;
  total: number;
}

export interface LiveKinematicsRegistry {
  entities: Map<string, SkyEntity>;
  rawFlights: Map<string, FlightEntity>;
  rawGlobalFlights: Map<string, FlightEntity>;
  rawBalloons: Map<string, BalloonEntity>;
  rawAdsbBalloons: Map<string, BalloonEntity>;
  rawDrones: Map<string, DroneEntity>;
  rawAdsbDrones: Map<string, DroneEntity>;
  satellites: Map<string, SatelliteEntity>;
  orbitOverlay: SatelliteOrbitOverlay | null;
  version: number;
}

export const liveKinematicsRegistry: LiveKinematicsRegistry = {
  entities: new Map(),
  rawFlights: new Map(),
  rawGlobalFlights: new Map(),
  rawBalloons: new Map(),
  rawAdsbBalloons: new Map(),
  rawDrones: new Map(),
  rawAdsbDrones: new Map(),
  satellites: new Map(),
  orbitOverlay: null,
  version: 0,
};

export interface UrlHydrationPatch {
  observer?: ObserverLocation;
  radiusKm?: number;
  layers?: Partial<Record<SkyCategory, boolean>>;
  units?: UnitSystem;
  layout?: LayoutMode;
  orbitalScope?: OrbitalScope;
  atmosphericScope?: AtmosphericScope;
  skyDomePip?: boolean;
  skyDomeZoom?: SkyDomeZoomMode;
  domeRotationDeg?: number;
  selectedId?: string | null;
}

export interface SkyStoreState {
  observer: ObserverLocation;
  locationStatus: ObserverLocationStatus;
  locationError: string | null;
  radiusKm: number;
  layers: Record<SkyCategory, boolean>;
  satGroups: Record<SatelliteGroup, boolean>;
  balloonSublayers: BalloonSublayerState;
  droneSublayers: DroneSublayerState;
  fullConstellation: boolean;
  orbitalScope: OrbitalScope;
  atmosphericScope: AtmosphericScope;
  units: UnitSystem;
  layout: LayoutMode;
  skyDomePip: boolean;
  skyDomeZoom: SkyDomeZoomMode;
  domeRotationDeg: number;
  domeRotationLocked: boolean;
  domeCompassActive: boolean;
  domeCompassSupported: boolean | null;
  audioEnabled: boolean;
  audioVolume: number;
  sweepEnabled: boolean;
  domeLabelsEnabled: boolean;
  mapLabelsEnabled: boolean;
  recenterNonce: number;
  pwaInstallAvailable: boolean;
  pwaInstallDismissed: boolean;
  isStandalonePwa: boolean;
  selectedId: string | null;
  hoveredId: string | null;
  followSelected: boolean;
  inspectorOpen: boolean;
  odidModalOpen: boolean;
  commandPaletteOpen: boolean;
  diagnosticsOpen: boolean;
  settingsOpen: boolean;
  activeDockTray: 'satellite' | 'balloon' | 'drone' | null;
  odidConfig: OpenDroneIdConfig;
  feeds: Record<FeedKey, FeedTelemetryState>;
  airspace: AirspaceData;
  nearestSondeHint: string | null;
  counts: SkyCounts;
  fps: number;
  workerReady: boolean;
  sweepPulseCounter: number;
  selectedEntitySnapshot: SkyEntity | null;

  setObserver: (observer: ObserverLocation) => void;
  updateObserverLabel: (
    expectedLat: number,
    expectedLon: number,
    expectedSource: ObserverLocation['source'],
    label: string
  ) => void;
  setLocationStatus: (status: ObserverLocationStatus, error?: string | null) => void;
  setRadiusKm: (radiusKm: number) => void;
  toggleLayer: (category: SkyCategory) => void;
  setLayer: (category: SkyCategory, enabled: boolean) => void;
  toggleSatGroup: (group: SatelliteGroup) => void;
  toggleBalloonSublayer: (key: keyof BalloonSublayerState) => void;
  setBalloonSublayer: (key: keyof BalloonSublayerState, enabled: boolean) => void;
  toggleDroneSublayer: (key: keyof DroneSublayerState) => void;
  setDroneSublayer: (key: keyof DroneSublayerState, enabled: boolean) => void;
  setFullConstellation: (enabled: boolean) => void;
  setOrbitalScope: (scope: OrbitalScope) => void;
  setAtmosphericScope: (scope: AtmosphericScope) => void;
  toggleAtmosphericScope: () => void;
  setUnits: (units: UnitSystem) => void;
  setLayout: (layout: LayoutMode) => void;
  setSkyDomePip: (enabled: boolean) => void;
  toggleSkyDomePip: () => void;
  setSkyDomeZoom: (zoom: SkyDomeZoomMode) => void;
  toggleSkyDomeZoom: () => void;
  setDomeRotationDeg: (deg: number, options?: { force?: boolean }) => void;
  setDomeRotationLocked: (locked: boolean) => void;
  toggleDomeRotationLock: () => void;
  setDomeCompassActive: (active: boolean) => void;
  setDomeCompassSupported: (supported: boolean | null) => void;
  resetDomeNorth: () => void;
  lockHighestOverheadTarget: () => string | null;
  setAudioEnabled: (enabled: boolean) => void;
  setAudioVolume: (volume: number) => void;
  setSweepEnabled: (enabled: boolean) => void;
  setDomeLabelsEnabled: (enabled: boolean) => void;
  toggleDomeLabels: () => void;
  setMapLabelsEnabled: (enabled: boolean) => void;
  bumpRecenterNonce: () => void;
  setPwaInstallState: (patch: { available?: boolean; dismissed?: boolean; standalone?: boolean }) => void;
  selectEntity: (id: string | null, openInspector?: boolean) => void;
  setHoveredId: (id: string | null) => void;
  setFollowSelected: (follow: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setOdidModalOpen: (open: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setDiagnosticsOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveDockTray: (tray: 'satellite' | 'balloon' | 'drone' | null) => void;
  closeAllPopovers: () => void;
  updateOdidConfig: (patch: Partial<OpenDroneIdConfig>) => void;
  setFeedState: (feed: FeedKey, patch: Partial<FeedTelemetryState>) => void;
  tickCountdowns: () => void;
  setAirspace: (airspace: AirspaceData) => void;
  setNearestSondeHint: (hint: string | null) => void;
  setCounts: (counts: SkyCounts) => void;
  setFps: (fps: number) => void;
  setWorkerReady: (ready: boolean) => void;
  triggerManualSweep: () => void;
  setSelectedEntitySnapshot: (entity: SkyEntity | null) => void;
  hydrateFromUrlState: (patch: UrlHydrationPatch) => void;
}

export const PENDING_OBSERVER: ObserverLocation = {
  lat: 0,
  lon: 0,
  altM: 0,
  label: 'Locating…',
  source: 'pending',
};

export const DEFAULT_SCAN_RADIUS_KM = 120;

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export type RegistryPruneContext = Pick<
  SkyStoreState,
  'layers' | 'satGroups' | 'balloonSublayers' | 'droneSublayers' | 'atmosphericScope' | 'observer' | 'radiusKm'
>;

function isBalloonSublayerEnabled(entity: BalloonEntity, sublayers: BalloonSublayerState): boolean {
  if (entity.subSource === 'windborne') return sublayers.windborne;
  if (entity.subSource === 'adsb-lta') return sublayers.adsbLta;
  return sublayers.sondehub;
}

function isDroneSublayerEnabled(entity: DroneEntity, sublayers: DroneSublayerState): boolean {
  if (entity.subSource === 'odid-sim' || entity.isSimulated) {
    return sublayers.simOdid;
  }
  return sublayers.liveUas;
}

/**
 * Synchronously evict disabled layers, sublayers, and out-of-range entities from
 * liveKinematicsRegistry whenever visibility toggles or LOCAL/GLOBAL scope changes.
 */
export function pruneLiveKinematicsRegistry(ctx: RegistryPruneContext): number {
  let pruned = 0;
  const maxLocalRangeKm = ctx.radiusKm * 1.02;

  for (const [id, entity] of liveKinematicsRegistry.entities.entries()) {
    let keep = ctx.layers[entity.category];

    if (keep && entity.category === 'satellite') {
      keep = ctx.satGroups[entity.group];
    } else if (keep && entity.category === 'balloon') {
      keep = isBalloonSublayerEnabled(entity, ctx.balloonSublayers);
      if (keep && ctx.atmosphericScope === 'local') {
        if (
          entity.subSource === 'windborne' ||
          haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, entity.lat, entity.lon) >
            maxLocalRangeKm
        ) {
          keep = false;
        }
      }
    } else if (keep && entity.category === 'drone') {
      keep = isDroneSublayerEnabled(entity, ctx.droneSublayers);
      if (keep && ctx.atmosphericScope === 'local' && entity.subSource === 'adsb-uas') {
        if (
          haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, entity.lat, entity.lon) >
          maxLocalRangeKm
        ) {
          keep = false;
        }
      }
    } else if (keep && (entity.category === 'flight' || entity.category === 'military')) {
      if (ctx.atmosphericScope === 'local') {
        if (
          haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, entity.lat, entity.lon) >
          maxLocalRangeKm
        ) {
          keep = false;
        }
      }
    }

    if (!keep) {
      liveKinematicsRegistry.entities.delete(id);
      pruned += 1;
    }
  }

  if (!ctx.layers.satellite) {
    if (liveKinematicsRegistry.satellites.size > 0) {
      pruned += liveKinematicsRegistry.satellites.size;
      liveKinematicsRegistry.satellites.clear();
    }
    if (liveKinematicsRegistry.orbitOverlay !== null) {
      liveKinematicsRegistry.orbitOverlay = null;
      pruned += 1;
    }
  }

  if (ctx.atmosphericScope === 'local') {
    if (liveKinematicsRegistry.rawGlobalFlights.size > 0) {
      pruned += liveKinematicsRegistry.rawGlobalFlights.size;
      liveKinematicsRegistry.rawGlobalFlights.clear();
    }
    for (const [bId, bEntity] of liveKinematicsRegistry.rawBalloons.entries()) {
      if (
        bEntity.subSource === 'windborne' ||
        haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, bEntity.lat, bEntity.lon) >
          maxLocalRangeKm
      ) {
        liveKinematicsRegistry.rawBalloons.delete(bId);
        pruned += 1;
      }
    }
    for (const [bId, bEntity] of liveKinematicsRegistry.rawAdsbBalloons.entries()) {
      if (
        haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, bEntity.lat, bEntity.lon) >
        maxLocalRangeKm
      ) {
        liveKinematicsRegistry.rawAdsbBalloons.delete(bId);
        pruned += 1;
      }
    }
    for (const [dId, dEntity] of liveKinematicsRegistry.rawAdsbDrones.entries()) {
      if (
        haversineDistanceKm(ctx.observer.lat, ctx.observer.lon, dEntity.lat, dEntity.lon) >
        maxLocalRangeKm
      ) {
        liveKinematicsRegistry.rawAdsbDrones.delete(dId);
        pruned += 1;
      }
    }
  }

  if (pruned > 0) {
    liveKinematicsRegistry.version += 1;
  }
  return pruned;
}

const createInitialFeeds = (): Record<FeedKey, FeedTelemetryState> => ({
  flights: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 10,
    intervalSec: 10,
    provider: 'adsb-cascade',
    count: 0,
  },
  military: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 18,
    intervalSec: 18,
    provider: 'adsb-mil-ladd-pia',
    count: 0,
  },
  satellites: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 7200,
    intervalSec: 7200,
    provider: 'celestrak-sgp4',
    count: 0,
  },
  balloons: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 30,
    intervalSec: 30,
    provider: 'sondehub-v2',
    count: 0,
  },
  airspace: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 300,
    intervalSec: 300,
    provider: 'faa-arcgis',
    count: 0,
  },
  drones: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 1,
    intervalSec: 1,
    provider: 'off',
    count: 0,
  },
});

export type OverheadSelectionContext = Pick<
  SkyStoreState,
  'layers' | 'satGroups' | 'balloonSublayers' | 'droneSublayers'
>;

export type DisplayCountContext = Pick<
  SkyStoreState,
  'observer' | 'radiusKm' | 'layers' | 'satGroups' | 'balloonSublayers' | 'droneSublayers'
>;

function isEntityVisibleForCounts(entity: SkyEntity, ctx: OverheadSelectionContext): boolean {
  if (!ctx.layers[entity.category]) return false;
  if (entity.category === 'satellite' && !ctx.satGroups[entity.group]) return false;
  if (entity.category === 'balloon' && !isBalloonSublayerEnabled(entity, ctx.balloonSublayers)) {
    return false;
  }
  if (entity.category === 'drone' && !isDroneSublayerEnabled(entity, ctx.droneSublayers)) {
    return false;
  }
  return true;
}

/**
 * Determine whether an active entity falls within the HUD displayed count scope.
 * Flights, Military, Orbital satellites, and Balloons are strictly scoped to the selected
 * ground radius (`groundDistKm <= radiusKm`), while UAS / Drones remain global.
 */
export function isEntityWithinDisplayCountScope(
  entity: SkyEntity,
  observer: Pick<ObserverLocation, 'lat' | 'lon'>,
  radiusKm: number
): boolean {
  if (entity.category === 'drone') {
    return true;
  }
  if (!Number.isFinite(radiusKm) || radiusKm < 0) {
    return false;
  }
  const topoDist = entity.topocentric?.groundDistKm;
  const groundDistKm =
    typeof topoDist === 'number' && Number.isFinite(topoDist) && topoDist >= 0
      ? topoDist
      : haversineDistanceKm(observer.lat, observer.lon, entity.lat, entity.lon);
  return Number.isFinite(groundDistKm) && groundDistKm <= radiusKm;
}

/**
 * Compute displayed HUD counts from the live rendered entity collection.
 * Global entities remain rendered in `liveKinematicsRegistry.entities`, while displayed counts
 * for Flights, Military, Orbital satellites, and Balloons only count entities within `radiusKm`
 * and UAS (`drone`) counts stay global.
 */
export function computeDisplayedSkyCounts(
  entities: Iterable<SkyEntity>,
  ctx: DisplayCountContext
): SkyCounts {
  let flight = 0;
  let military = 0;
  let satellite = 0;
  let balloon = 0;
  let drone = 0;
  let overheadPrimary = 0;
  let overheadFallback = 0;

  for (const entity of entities) {
    if (!isEntityVisibleForCounts(entity, ctx)) continue;

    const el = entity.topocentric?.elevationDeg;
    if (Number.isFinite(el)) {
      if (el >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
        overheadPrimary += 1;
      } else if (el >= OVERHEAD_FALLBACK_MIN_EL_DEG) {
        overheadFallback += 1;
      }
    }

    if (!isEntityWithinDisplayCountScope(entity, ctx.observer, ctx.radiusKm)) {
      continue;
    }

    switch (entity.category) {
      case 'flight':
        flight += 1;
        break;
      case 'military':
        military += 1;
        break;
      case 'satellite':
        satellite += 1;
        break;
      case 'balloon':
        balloon += 1;
        break;
      case 'drone':
        drone += 1;
        break;
    }
  }

  const total = flight + military + satellite + balloon + drone;
  return {
    flight,
    military,
    satellite,
    balloon,
    drone,
    overhead: overheadPrimary > 0 ? overheadPrimary : overheadFallback,
    overheadConeDeg: overheadPrimary > 0 ? 45 : 20,
    total,
  };
}

/**
 * Collect visible overhead targets sorted deterministically by descending elevation,
 * ascending slant range, and ID. Prefers targets in the high overhead cone (EL >= 45 deg),
 * falling back to EL >= 20 deg when the primary cone is empty.
 */
export function getOverheadCandidates(ctx: OverheadSelectionContext): {
  candidates: SkyEntity[];
  coneMinElDeg: 45 | 20;
} {
  const primary: SkyEntity[] = [];
  const fallback: SkyEntity[] = [];

  for (const entity of liveKinematicsRegistry.entities.values()) {
    if (!isEntityVisibleForCounts(entity, ctx)) continue;
    const el = entity.topocentric?.elevationDeg;
    if (!Number.isFinite(el) || el < OVERHEAD_FALLBACK_MIN_EL_DEG) continue;
    if (el >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
      primary.push(entity);
    } else {
      fallback.push(entity);
    }
  }

  const coneMinElDeg: 45 | 20 = primary.length > 0 ? 45 : 20;
  const candidates = primary.length > 0 ? primary : fallback;
  candidates.sort((a, b) => {
    if (b.topocentric.elevationDeg !== a.topocentric.elevationDeg) {
      return b.topocentric.elevationDeg - a.topocentric.elevationDeg;
    }
    const aRng = Number.isFinite(a.topocentric.slantRangeKm)
      ? a.topocentric.slantRangeKm
      : Number.POSITIVE_INFINITY;
    const bRng = Number.isFinite(b.topocentric.slantRangeKm)
      ? b.topocentric.slantRangeKm
      : Number.POSITIVE_INFINITY;
    if (aRng !== bRng) return aRng - bRng;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return { candidates, coneMinElDeg };
}

export const useSkyStore = create<SkyStoreState>((set, get) => ({
  observer: { ...PENDING_OBSERVER },
  locationStatus: 'locating',
  locationError: null,
  radiusKm: DEFAULT_SCAN_RADIUS_KM,
  layers: {
    flight: true,
    military: true,
    satellite: true,
    balloon: true,
    drone: true,
  },
  satGroups: {
    stations: true,
    visual: true,
    starlink: true,
  },
  balloonSublayers: {
    windborne: true,
    sondehub: true,
    adsbLta: true,
  },
  droneSublayers: {
    liveUas: true,
    airspace: true,
    simOdid: false,
  },
  fullConstellation: false,
  orbitalScope: 'hemisphere',
  atmosphericScope: 'global',
  units: 'aviation',
  layout: 'split',
  skyDomePip: true,
  skyDomeZoom: 'hemisphere',
  domeRotationDeg: 0,
  domeRotationLocked: false,
  domeCompassActive: false,
  domeCompassSupported: null,
  audioEnabled: false,
  audioVolume: 0.35,
  sweepEnabled: true,
  domeLabelsEnabled: true,
  mapLabelsEnabled: true,
  recenterNonce: 0,
  pwaInstallAvailable: false,
  pwaInstallDismissed: false,
  isStandalonePwa: false,
  selectedId: null,
  hoveredId: null,
  followSelected: false,
  inspectorOpen: false,
  odidModalOpen: false,
  commandPaletteOpen: false,
  diagnosticsOpen: false,
  settingsOpen: false,
  activeDockTray: null,
  odidConfig: {
    simulatorEnabled: false,
    endpointUrl: '',
    transport: 'off',
    connected: false,
  },
  feeds: createInitialFeeds(),
  airspace: {
    uasfm: EMPTY_FC,
    sua: EMPTY_FC,
    usCoverage: true,
  },
  nearestSondeHint: null,
  counts: {
    flight: 0,
    military: 0,
    satellite: 0,
    balloon: 0,
    drone: 0,
    overhead: 0,
    total: 0,
  },
  fps: 60,
  workerReady: false,
  sweepPulseCounter: 0,
  selectedEntitySnapshot: null,

  setObserver: (observer) =>
    set((state) => ({
      observer,
      locationStatus: observer.source === 'pending' ? 'locating' : 'ready',
      locationError: null,
      recenterNonce: state.recenterNonce + 1,
    })),
  updateObserverLabel: (expectedLat, expectedLon, expectedSource, label) =>
    set((state) => {
      if (
        state.observer.source !== expectedSource ||
        Math.abs(state.observer.lat - expectedLat) > 1e-5 ||
        Math.abs(state.observer.lon - expectedLon) > 1e-5 ||
        state.observer.label === label
      ) {
        return {};
      }
      return {
        observer: {
          ...state.observer,
          label,
        },
      };
    }),
  setLocationStatus: (locationStatus, locationError = null) =>
    set({ locationStatus, locationError }),
  setRadiusKm: (radiusKm) =>
    set((state) => {
      const nextRadiusKm = Math.max(10, Math.min(250, Math.round(radiusKm)));
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      return {
        radiusKm: nextRadiusKm,
        ...(hadEntities
          ? {
              counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), {
                ...state,
                radiusKm: nextRadiusKm,
              }),
            }
          : {}),
      };
    }),
  toggleLayer: (category) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextLayers = { ...state.layers, [category]: !state.layers[category] };
      const nextCtx = { ...state, layers: nextLayers };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        layers: nextLayers,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  setLayer: (category, enabled) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextLayers = { ...state.layers, [category]: enabled };
      const nextCtx = { ...state, layers: nextLayers };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        layers: nextLayers,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleSatGroup: (group) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextSatGroups = { ...state.satGroups, [group]: !state.satGroups[group] };
      const nextCtx = { ...state, satGroups: nextSatGroups };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        satGroups: nextSatGroups,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleBalloonSublayer: (key) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextBalloonSublayers = {
        ...state.balloonSublayers,
        [key]: !state.balloonSublayers[key],
      };
      const nextCtx = { ...state, balloonSublayers: nextBalloonSublayers };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        balloonSublayers: nextBalloonSublayers,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  setBalloonSublayer: (key, enabled) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextBalloonSublayers = { ...state.balloonSublayers, [key]: enabled };
      const nextCtx = { ...state, balloonSublayers: nextBalloonSublayers };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        balloonSublayers: nextBalloonSublayers,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleDroneSublayer: (key) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextVal = !state.droneSublayers[key];
      const nextDroneSublayers = { ...state.droneSublayers, [key]: nextVal };
      const nextCtx = { ...state, droneSublayers: nextDroneSublayers };
      pruneLiveKinematicsRegistry(nextCtx);
      const nextHoveredId =
        state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
          ? null
          : state.hoveredId;
      const countPatch = hadEntities
        ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
        : {};
      if (key === 'simOdid') {
        return {
          droneSublayers: nextDroneSublayers,
          odidConfig: { ...state.odidConfig, simulatorEnabled: nextVal },
          hoveredId: nextHoveredId,
          ...countPatch,
        };
      }
      return { droneSublayers: nextDroneSublayers, hoveredId: nextHoveredId, ...countPatch };
    }),
  setDroneSublayer: (key, enabled) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextDroneSublayers = { ...state.droneSublayers, [key]: enabled };
      const nextCtx = { ...state, droneSublayers: nextDroneSublayers };
      pruneLiveKinematicsRegistry(nextCtx);
      const nextHoveredId =
        state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
          ? null
          : state.hoveredId;
      const countPatch = hadEntities
        ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
        : {};
      if (key === 'simOdid') {
        return {
          droneSublayers: nextDroneSublayers,
          odidConfig: { ...state.odidConfig, simulatorEnabled: enabled },
          hoveredId: nextHoveredId,
          ...countPatch,
        };
      }
      return { droneSublayers: nextDroneSublayers, hoveredId: nextHoveredId, ...countPatch };
    }),
  setFullConstellation: (fullConstellation) => set({ fullConstellation }),
  setOrbitalScope: (orbitalScope) => set({ orbitalScope }),
  setAtmosphericScope: (atmosphericScope) =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextCtx = { ...state, atmosphericScope };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        atmosphericScope,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleAtmosphericScope: () =>
    set((state) => {
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextScope: AtmosphericScope = state.atmosphericScope === 'global' ? 'local' : 'global';
      const nextCtx = { ...state, atmosphericScope: nextScope };
      pruneLiveKinematicsRegistry(nextCtx);
      return {
        atmosphericScope: nextScope,
        ...(hadEntities
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  setUnits: (units) => set({ units }),
  setLayout: (layout) => set({ layout }),
  setSkyDomePip: (skyDomePip) => set({ skyDomePip }),
  toggleSkyDomePip: () => set((state) => ({ skyDomePip: !state.skyDomePip })),
  setSkyDomeZoom: (skyDomeZoom) => set({ skyDomeZoom }),
  toggleSkyDomeZoom: () =>
    set((state) => ({
      skyDomeZoom: state.skyDomeZoom === 'hemisphere' ? 'zenith' : 'hemisphere',
    })),
  setDomeRotationDeg: (deg, options) =>
    set((state) => {
      if (!Number.isFinite(deg)) return {};
      if (state.domeRotationLocked && !options?.force) return {};
      return { domeRotationDeg: normalizeAzimuthDeg(deg) };
    }),
  setDomeRotationLocked: (domeRotationLocked) => set({ domeRotationLocked }),
  toggleDomeRotationLock: () =>
    set((state) => ({ domeRotationLocked: !state.domeRotationLocked })),
  setDomeCompassActive: (domeCompassActive) => set({ domeCompassActive }),
  setDomeCompassSupported: (domeCompassSupported) => set({ domeCompassSupported }),
  resetDomeNorth: () => set({ domeRotationDeg: 0, domeCompassActive: false }),
  lockHighestOverheadTarget: () => {
    const state = get();
    const { candidates } = getOverheadCandidates(state);
    if (candidates.length === 0) return null;
    const currIdx =
      state.inspectorOpen && state.selectedId
        ? candidates.findIndex((entity) => entity.id === state.selectedId)
        : -1;
    const nextTarget =
      currIdx >= 0 ? candidates[(currIdx + 1) % candidates.length] : candidates[0];
    set({
      selectedId: nextTarget.id,
      inspectorOpen: true,
      selectedEntitySnapshot: { ...nextTarget },
    });
    return nextTarget.id;
  },
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
  setAudioVolume: (audioVolume) =>
    set({ audioVolume: Math.max(0, Math.min(1, audioVolume)) }),
  setSweepEnabled: (sweepEnabled) => set({ sweepEnabled }),
  setDomeLabelsEnabled: (domeLabelsEnabled) => set({ domeLabelsEnabled }),
  toggleDomeLabels: () => set((state) => ({ domeLabelsEnabled: !state.domeLabelsEnabled })),
  setMapLabelsEnabled: (mapLabelsEnabled) => set({ mapLabelsEnabled }),
  bumpRecenterNonce: () =>
    set((state) => ({ recenterNonce: state.recenterNonce + 1 })),
  setPwaInstallState: (patch) =>
    set((state) => ({
      pwaInstallAvailable:
        patch.available !== undefined ? patch.available : state.pwaInstallAvailable,
      pwaInstallDismissed:
        patch.dismissed !== undefined ? patch.dismissed : state.pwaInstallDismissed,
      isStandalonePwa:
        patch.standalone !== undefined ? patch.standalone : state.isStandalonePwa,
    })),
  selectEntity: (id, openInspector = true) =>
    set((state) => ({
      selectedId: id,
      inspectorOpen: id !== null ? openInspector : false,
      followSelected: id === null ? false : state.followSelected,
      selectedEntitySnapshot:
        id !== null ? liveKinematicsRegistry.entities.get(id) ?? null : null,
    })),
  setHoveredId: (hoveredId) => set({ hoveredId }),
  setFollowSelected: (followSelected) => set({ followSelected }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setOdidModalOpen: (odidModalOpen) => set({ odidModalOpen }),
  setCommandPaletteOpen: (commandPaletteOpen) =>
    set((state) => ({
      commandPaletteOpen,
      diagnosticsOpen: commandPaletteOpen ? false : state.diagnosticsOpen,
      settingsOpen: commandPaletteOpen ? false : state.settingsOpen,
    })),
  setDiagnosticsOpen: (diagnosticsOpen) =>
    set((state) => ({
      diagnosticsOpen,
      commandPaletteOpen: diagnosticsOpen ? false : state.commandPaletteOpen,
      settingsOpen: diagnosticsOpen ? false : state.settingsOpen,
    })),
  setSettingsOpen: (settingsOpen) =>
    set((state) => ({
      settingsOpen,
      commandPaletteOpen: settingsOpen ? false : state.commandPaletteOpen,
      diagnosticsOpen: settingsOpen ? false : state.diagnosticsOpen,
    })),
  setActiveDockTray: (activeDockTray) => set({ activeDockTray }),
  closeAllPopovers: () =>
    set({
      commandPaletteOpen: false,
      diagnosticsOpen: false,
      settingsOpen: false,
    }),
  updateOdidConfig: (patch) =>
    set((state) => {
      const nextOdidConfig = { ...state.odidConfig, ...patch };
      if (patch.simulatorEnabled !== undefined) {
        return {
          odidConfig: nextOdidConfig,
          droneSublayers: { ...state.droneSublayers, simOdid: patch.simulatorEnabled },
        };
      }
      return { odidConfig: nextOdidConfig };
    }),
  setFeedState: (feed, patch) =>
    set((state) => ({
      feeds: {
        ...state.feeds,
        [feed]: { ...state.feeds[feed], ...patch },
      },
    })),
  tickCountdowns: () =>
    set((state) => {
      let changed = false;
      const nextFeeds = { ...state.feeds };
      (Object.keys(nextFeeds) as FeedKey[]).forEach((key) => {
        const curr = nextFeeds[key];
        if (curr.nextRefreshSec > 0) {
          nextFeeds[key] = { ...curr, nextRefreshSec: curr.nextRefreshSec - 1 };
          changed = true;
        }
      });
      return changed ? { feeds: nextFeeds } : {};
    }),
  setAirspace: (airspace) => set({ airspace }),
  setNearestSondeHint: (nearestSondeHint) => set({ nearestSondeHint }),
  setCounts: (counts) => set({ counts }),
  setFps: (fps) => set({ fps }),
  setWorkerReady: (workerReady) => set({ workerReady }),
  triggerManualSweep: () =>
    set((state) => ({ sweepPulseCounter: state.sweepPulseCounter + 1 })),
  setSelectedEntitySnapshot: (selectedEntitySnapshot) => set({ selectedEntitySnapshot }),
  hydrateFromUrlState: (patch) =>
    set((state) => {
      const nextObserver = patch.observer ?? state.observer;
      const nextRadiusKm =
        patch.radiusKm !== undefined
          ? Math.max(10, Math.min(250, Math.round(patch.radiusKm)))
          : state.radiusKm;
      const hadEntities = liveKinematicsRegistry.entities.size > 0;
      const nextLayers = patch.layers ? { ...state.layers, ...patch.layers } : state.layers;
      const nextScope = patch.atmosphericScope ?? state.atmosphericScope;
      const nextCtx = {
        ...state,
        observer: nextObserver,
        radiusKm: nextRadiusKm,
        layers: nextLayers,
        atmosphericScope: nextScope,
      };
      if (patch.layers || patch.atmosphericScope !== undefined || patch.observer || patch.radiusKm !== undefined) {
        pruneLiveKinematicsRegistry(nextCtx);
      }
      return {
        observer: nextObserver,
        locationStatus: patch.observer ? 'ready' : state.locationStatus,
        locationError: patch.observer ? null : state.locationError,
        recenterNonce: patch.observer ? state.recenterNonce + 1 : state.recenterNonce,
        radiusKm: nextRadiusKm,
        layers: nextLayers,
        ...(hadEntities && !patch.observer
          ? { counts: computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), nextCtx) }
          : {}),
        units: patch.units ?? state.units,
        layout: patch.layout ?? state.layout,
        orbitalScope: patch.orbitalScope ?? state.orbitalScope,
        atmosphericScope: nextScope,
        skyDomePip: patch.skyDomePip ?? state.skyDomePip,
        skyDomeZoom: patch.skyDomeZoom ?? state.skyDomeZoom,
        domeRotationDeg:
          patch.domeRotationDeg !== undefined && Number.isFinite(patch.domeRotationDeg)
            ? normalizeAzimuthDeg(patch.domeRotationDeg)
            : state.domeRotationDeg,
        selectedId: patch.selectedId !== undefined ? patch.selectedId : state.selectedId,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
        inspectorOpen:
          patch.selectedId !== undefined && patch.selectedId !== null
            ? true
            : state.inspectorOpen,
      };
    }),
}));
