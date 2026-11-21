import { create } from 'zustand';
import {
  AEROSPACE_PRESETS,
  type AirspaceData,
  type BalloonEntity,
  type DroneEntity,
  type FeedKey,
  type FeedTelemetryState,
  type FlightEntity,
  type LayoutMode,
  type ObserverLocation,
  type OpenDroneIdConfig,
  type OrbitalScope,
  type SatelliteEntity,
  type SatelliteGroup,
  type SatelliteOrbitOverlay,
  type SkyCategory,
  type SkyEntity,
  type UnitSystem,
} from '../types/sky-contracts';

export interface SkyCounts extends Record<SkyCategory, number> {
  overhead: number;
  total: number;
}

export interface LiveKinematicsRegistry {
  entities: Map<string, SkyEntity>;
  rawFlights: Map<string, FlightEntity>;
  rawBalloons: Map<string, BalloonEntity>;
  rawDrones: Map<string, DroneEntity>;
  satellites: Map<string, SatelliteEntity>;
  orbitOverlay: SatelliteOrbitOverlay | null;
  version: number;
}

export const liveKinematicsRegistry: LiveKinematicsRegistry = {
  entities: new Map(),
  rawFlights: new Map(),
  rawBalloons: new Map(),
  rawDrones: new Map(),
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
  selectedId?: string | null;
}

export interface SkyStoreState {
  observer: ObserverLocation;
  radiusKm: number;
  layers: Record<SkyCategory, boolean>;
  satGroups: Record<SatelliteGroup, boolean>;
  fullConstellation: boolean;
  orbitalScope: OrbitalScope;
  units: UnitSystem;
  layout: LayoutMode;
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
  setRadiusKm: (radiusKm: number) => void;
  toggleLayer: (category: SkyCategory) => void;
  setLayer: (category: SkyCategory, enabled: boolean) => void;
  toggleSatGroup: (group: SatelliteGroup) => void;
  setFullConstellation: (enabled: boolean) => void;
  setOrbitalScope: (scope: OrbitalScope) => void;
  setUnits: (units: UnitSystem) => void;
  setLayout: (layout: LayoutMode) => void;
  setAudioEnabled: (enabled: boolean) => void;
  setAudioVolume: (volume: number) => void;
  setSweepEnabled: (enabled: boolean) => void;
  setDomeLabelsEnabled: (enabled: boolean) => void;
  setMapLabelsEnabled: (enabled: boolean) => void;
  bumpRecenterNonce: () => void;
  setPwaInstallState: (patch: { available?: boolean; dismissed?: boolean; standalone?: boolean }) => void;
  selectEntity: (id: string | null, openInspector?: boolean) => void;
  setHoveredId: (id: string | null) => void;
  setFollowSelected: (follow: boolean) => void;
  setInspectorOpen: (open: boolean) => void;
  setOdidModalOpen: (open: boolean) => void;
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

const defaultPreset = AEROSPACE_PRESETS[0];

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

const createInitialFeeds = (): Record<FeedKey, FeedTelemetryState> => ({
  flights: {
    status: 'idle',
    lastUpdatedMs: null,
    nextRefreshSec: 10,
    intervalSec: 10,
    provider: 'adsb-cascade',
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
  observer: {
    lat: defaultPreset.lat,
    lon: defaultPreset.lon,
    altM: defaultPreset.altM,
    label: defaultPreset.name,
    source: 'default',
  },
  radiusKm: defaultPreset.defaultRadiusKm,
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
  fullConstellation: false,
  orbitalScope: 'hemisphere',
  units: 'aviation',
  layout: 'split',
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
    set((state) => ({ observer, recenterNonce: state.recenterNonce + 1 })),
  setRadiusKm: (radiusKm) =>
    set({ radiusKm: Math.max(10, Math.min(250, Math.round(radiusKm))) }),
  toggleLayer: (category) =>
    set((state) => ({
      layers: { ...state.layers, [category]: !state.layers[category] },
    })),
  setLayer: (category, enabled) =>
    set((state) => ({
      layers: { ...state.layers, [category]: enabled },
    })),
  toggleSatGroup: (group) =>
    set((state) => ({
      satGroups: { ...state.satGroups, [group]: !state.satGroups[group] },
    })),
  setFullConstellation: (fullConstellation) => set({ fullConstellation }),
  setOrbitalScope: (orbitalScope) => set({ orbitalScope }),
  setUnits: (units) => set({ units }),
  setLayout: (layout) => set({ layout }),
  setAudioEnabled: (audioEnabled) => set({ audioEnabled }),
  setAudioVolume: (audioVolume) =>
    set({ audioVolume: Math.max(0, Math.min(1, audioVolume)) }),
  setSweepEnabled: (sweepEnabled) => set({ sweepEnabled }),
  setDomeLabelsEnabled: (domeLabelsEnabled) => set({ domeLabelsEnabled }),
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
  updateOdidConfig: (patch) =>
    set((state) => ({
      odidConfig: { ...state.odidConfig, ...patch },
    })),
  setFeedState: (feed, patch) =>
    set((state) => ({
      feeds: {
        ...state.feeds,
        [feed]: { ...state.feeds[feed], ...patch },
      },
    })),
  tickCountdowns: () =>
    set((state) => {
      const nextFeeds = { ...state.feeds };
      (Object.keys(nextFeeds) as FeedKey[]).forEach((key) => {
        const curr = nextFeeds[key];
        if (curr.nextRefreshSec > 0) {
          nextFeeds[key] = { ...curr, nextRefreshSec: curr.nextRefreshSec - 1 };
        }
      });
      return { feeds: nextFeeds };
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
    set((state) => ({
      observer: patch.observer ?? state.observer,
      recenterNonce: patch.observer ? state.recenterNonce + 1 : state.recenterNonce,
      radiusKm:
        patch.radiusKm !== undefined
          ? Math.max(10, Math.min(250, Math.round(patch.radiusKm)))
          : state.radiusKm,
      layers: patch.layers ? { ...state.layers, ...patch.layers } : state.layers,
      units: patch.units ?? state.units,
      layout: patch.layout ?? state.layout,
      orbitalScope: patch.orbitalScope ?? state.orbitalScope,
      selectedId: patch.selectedId !== undefined ? patch.selectedId : state.selectedId,
      inspectorOpen:
        patch.selectedId !== undefined && patch.selectedId !== null
          ? true
          : state.inspectorOpen,
    })),
}));
