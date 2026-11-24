import { create } from 'zustand';
import {
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
import { haversineDistanceKm } from '../math/geodesy';

export interface SkyCounts extends Record<SkyCategory, number> {
  overhead: number;
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

export const useSkyStore = create<SkyStoreState>((set) => ({
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
    set({ radiusKm: Math.max(10, Math.min(250, Math.round(radiusKm))) }),
  toggleLayer: (category) =>
    set((state) => {
      const nextLayers = { ...state.layers, [category]: !state.layers[category] };
      pruneLiveKinematicsRegistry({ ...state, layers: nextLayers });
      return {
        layers: nextLayers,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  setLayer: (category, enabled) =>
    set((state) => {
      const nextLayers = { ...state.layers, [category]: enabled };
      pruneLiveKinematicsRegistry({ ...state, layers: nextLayers });
      return {
        layers: nextLayers,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleSatGroup: (group) =>
    set((state) => {
      const nextSatGroups = { ...state.satGroups, [group]: !state.satGroups[group] };
      pruneLiveKinematicsRegistry({ ...state, satGroups: nextSatGroups });
      return {
        satGroups: nextSatGroups,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleBalloonSublayer: (key) =>
    set((state) => {
      const nextBalloonSublayers = {
        ...state.balloonSublayers,
        [key]: !state.balloonSublayers[key],
      };
      pruneLiveKinematicsRegistry({ ...state, balloonSublayers: nextBalloonSublayers });
      return {
        balloonSublayers: nextBalloonSublayers,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  setBalloonSublayer: (key, enabled) =>
    set((state) => {
      const nextBalloonSublayers = { ...state.balloonSublayers, [key]: enabled };
      pruneLiveKinematicsRegistry({ ...state, balloonSublayers: nextBalloonSublayers });
      return {
        balloonSublayers: nextBalloonSublayers,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleDroneSublayer: (key) =>
    set((state) => {
      const nextVal = !state.droneSublayers[key];
      const nextDroneSublayers = { ...state.droneSublayers, [key]: nextVal };
      pruneLiveKinematicsRegistry({ ...state, droneSublayers: nextDroneSublayers });
      const nextHoveredId =
        state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
          ? null
          : state.hoveredId;
      if (key === 'simOdid') {
        return {
          droneSublayers: nextDroneSublayers,
          odidConfig: { ...state.odidConfig, simulatorEnabled: nextVal },
          hoveredId: nextHoveredId,
        };
      }
      return { droneSublayers: nextDroneSublayers, hoveredId: nextHoveredId };
    }),
  setDroneSublayer: (key, enabled) =>
    set((state) => {
      const nextDroneSublayers = { ...state.droneSublayers, [key]: enabled };
      pruneLiveKinematicsRegistry({ ...state, droneSublayers: nextDroneSublayers });
      const nextHoveredId =
        state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
          ? null
          : state.hoveredId;
      if (key === 'simOdid') {
        return {
          droneSublayers: nextDroneSublayers,
          odidConfig: { ...state.odidConfig, simulatorEnabled: enabled },
          hoveredId: nextHoveredId,
        };
      }
      return { droneSublayers: nextDroneSublayers, hoveredId: nextHoveredId };
    }),
  setFullConstellation: (fullConstellation) => set({ fullConstellation }),
  setOrbitalScope: (orbitalScope) => set({ orbitalScope }),
  setAtmosphericScope: (atmosphericScope) =>
    set((state) => {
      pruneLiveKinematicsRegistry({ ...state, atmosphericScope });
      return {
        atmosphericScope,
        hoveredId:
          state.hoveredId && !liveKinematicsRegistry.entities.has(state.hoveredId)
            ? null
            : state.hoveredId,
      };
    }),
  toggleAtmosphericScope: () =>
    set((state) => {
      const nextScope = state.atmosphericScope === 'global' ? 'local' : 'global';
      pruneLiveKinematicsRegistry({ ...state, atmosphericScope: nextScope });
      return {
        atmosphericScope: nextScope,
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
      const nextLayers = patch.layers ? { ...state.layers, ...patch.layers } : state.layers;
      const nextScope = patch.atmosphericScope ?? state.atmosphericScope;
      if (patch.layers || patch.atmosphericScope !== undefined || patch.observer || patch.radiusKm !== undefined) {
        pruneLiveKinematicsRegistry({
          ...state,
          observer: nextObserver,
          radiusKm: nextRadiusKm,
          layers: nextLayers,
          atmosphericScope: nextScope,
        });
      }
      return {
        observer: nextObserver,
        locationStatus: patch.observer ? 'ready' : state.locationStatus,
        locationError: patch.observer ? null : state.locationError,
        recenterNonce: patch.observer ? state.recenterNonce + 1 : state.recenterNonce,
        radiusKm: nextRadiusKm,
        layers: nextLayers,
        units: patch.units ?? state.units,
        layout: patch.layout ?? state.layout,
        orbitalScope: patch.orbitalScope ?? state.orbitalScope,
        atmosphericScope: nextScope,
        skyDomePip: patch.skyDomePip ?? state.skyDomePip,
        skyDomeZoom: patch.skyDomeZoom ?? state.skyDomeZoom,
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
