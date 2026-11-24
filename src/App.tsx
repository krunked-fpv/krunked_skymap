import { useCallback, useEffect, useRef, useState } from 'react';
import { Crosshair, Search } from 'lucide-react';
import {
  OVERHEAD_FALLBACK_MIN_EL_DEG,
  OVERHEAD_PRIMARY_MIN_EL_DEG,
  type AtmosphericScope,
  type BalloonEntity,
  type DroneEntity,
  type FlightEntity,
  type LayoutMode,
  type OrbitalScope,
  type SatelliteEntity,
  type SkyCategory,
  type SkyEntity,
  type UnitSystem,
} from './types/sky-contracts';
import { liveKinematicsRegistry, useSkyStore, type UrlHydrationPatch } from './store/useSkyStore';
import {
  computeTopocentricLookAngles,
  extrapolateDeadReckoning,
  haversineDistanceKm,
} from './math/geodesy';
import { AstroClient } from './workers/astroClient';
import {
  fetchFlightsCascade,
  fetchGlobalSpecialFlights,
  pickRicherAirframeClass,
} from './services/flightsService';
import { loadInitialTles, refreshTlesIfStale } from './services/satellitesService';
import { fetchBalloons } from './services/balloonsService';
import { evaluateDroneAirspaceCompliance, fetchAirspace } from './services/airspaceService';
import { OpenDroneIdClient, stepSimulatedDrones } from './services/openDroneIdService';
import { searchLocation } from './services/geocodingService';
import {
  fetchIpGeolocation,
  requestBrowserGeolocation,
  resolveCurrentGeographicLocation,
  reverseGeocodeLabel,
} from './services/locationService';
import { tacticalAudio } from './audio/tacticalAudio';
import { TopTelemetryBar } from './components/hud/TopTelemetryBar';
import { ControlDock, type LocationSearchResult } from './components/hud/ControlDock';
import { OpenDroneIdModal } from './components/hud/OpenDroneIdModal';
import { TargetInspector } from './components/inspector/TargetInspector';
import { TacticalMap } from './components/map/TacticalMap';
import { PolarSkyDome } from './components/skydome/PolarSkyDome';

const ALL_CATEGORIES: SkyCategory[] = ['flight', 'military', 'satellite', 'balloon', 'drone'];
const PWA_DISMISS_STORAGE_KEY = 'krunked_pwa_dismissed';

interface BeforeInstallPromptEvent extends Event {
  readonly platforms?: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

/**
 * Detect unpinned legacy default DC hashes auto-written by older builds
 * so reloading a stale tab or bookmark resolves the user's current geographic location instead.
 */
function isLegacyDefaultDcHash(params: URLSearchParams, lat: number, lon: number): boolean {
  if (params.get('pin') === '1' || params.get('selected')) {
    return false;
  }
  const label = (params.get('label') ?? '').trim();
  return (
    Math.abs(lat - 38.8512) < 0.0005 &&
    Math.abs(lon - -77.0402) < 0.0005 &&
    (label === 'DC / Potomac Corridor' || label === '')
  );
}

function parseUrlHashPatch(options: { ignoreLegacyDefaultDc?: boolean } = {}): UrlHydrationPatch | null {
  if (typeof window === 'undefined' || !window.location.hash) return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;

  const params = new URLSearchParams(raw);
  const patch: UrlHydrationPatch = {};

  const latStr = params.get('lat');
  const lonStr = params.get('lon');
  if (latStr !== null && lonStr !== null) {
    const lat = Number.parseFloat(latStr);
    const lon = Number.parseFloat(lonStr);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    ) {
      const skipLegacyDc =
        options.ignoreLegacyDefaultDc !== false && isLegacyDefaultDcHash(params, lat, lon);
      if (!skipLegacyDc) {
        const altParam = Number.parseFloat(params.get('alt') ?? '12');
        patch.observer = {
          lat,
          lon,
          altM: Number.isFinite(altParam) ? altParam : 12,
          label: params.get('label') || `${lat.toFixed(2)}, ${lon.toFixed(2)}`,
          source: 'url',
        };
      }
    }
  }

  const rStr = params.get('r');
  if (rStr !== null) {
    const r = Number.parseFloat(rStr);
    if (Number.isFinite(r)) {
      patch.radiusKm = Math.max(10, Math.min(250, Math.round(r)));
    }
  }

  const layersParam = params.get('layers');
  if (layersParam !== null) {
    const active = new Set(
      layersParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const layerPatch: Partial<Record<SkyCategory, boolean>> = {};
    for (const cat of ALL_CATEGORIES) {
      layerPatch[cat] = active.has(cat);
    }
    patch.layers = layerPatch;
  }

  const unitsParam = params.get('units');
  if (unitsParam === 'aviation' || unitsParam === 'metric') {
    patch.units = unitsParam as UnitSystem;
  }

  const layoutParam = params.get('layout');
  if (layoutParam === 'split' || layoutParam === 'map' || layoutParam === 'dome') {
    patch.layout = layoutParam as LayoutMode;
  }

  const scopeParam = params.get('scope');
  if (scopeParam === 'cylinder' || scopeParam === 'hemisphere') {
    patch.orbitalScope = scopeParam as OrbitalScope;
  }

  const atmParam = params.get('atm');
  if (atmParam === 'local' || atmParam === 'global') {
    patch.atmosphericScope = atmParam as AtmosphericScope;
  }

  const pipParam = params.get('pip');
  if (pipParam === '1' || pipParam === 'true') {
    patch.skyDomePip = true;
  } else if (pipParam === '0' || pipParam === 'false') {
    patch.skyDomePip = false;
  }

  const selectedParam = params.get('selected');
  if (selectedParam) {
    patch.selectedId = selectedParam;
  }

  const dzParam = params.get('dz');
  if (dzParam === 'zenith' || dzParam === 'hemisphere') {
    patch.skyDomeZoom = dzParam;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function buildUrlHashString(): string {
  const s = useSkyStore.getState();
  const params = new URLSearchParams();
  const isPinnedStation =
    s.observer.source === 'search' ||
    s.observer.source === 'manual' ||
    s.observer.source === 'preset' ||
    s.observer.source === 'url';
  if (isPinnedStation) {
    params.set('pin', '1');
    params.set('lat', s.observer.lat.toFixed(4));
    params.set('lon', s.observer.lon.toFixed(4));
    params.set('alt', String(Math.round(s.observer.altM)));
    params.set('label', s.observer.label);
  }
  params.set('r', String(s.radiusKm));
  const activeLayers = ALL_CATEGORIES.filter((cat) => s.layers[cat]);
  params.set('layers', activeLayers.join(','));
  params.set('units', s.units);
  params.set('layout', s.layout);
  params.set('scope', s.orbitalScope);
  params.set('atm', s.atmosphericScope);
  params.set('pip', s.skyDomePip ? '1' : '0');
  params.set('dz', s.skyDomeZoom);
  if (s.selectedId) {
    params.set('selected', s.selectedId);
  }
  return `#${params.toString()}`;
}

export default function App() {
  const observer = useSkyStore((s) => s.observer);
  const locationStatus = useSkyStore((s) => s.locationStatus);
  const locationError = useSkyStore((s) => s.locationError);
  const commandPaletteOpen = useSkyStore((s) => s.commandPaletteOpen);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const layers = useSkyStore((s) => s.layers);
  const satGroups = useSkyStore((s) => s.satGroups);
  const balloonSublayers = useSkyStore((s) => s.balloonSublayers);
  const droneSublayers = useSkyStore((s) => s.droneSublayers);
  const fullConstellation = useSkyStore((s) => s.fullConstellation);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const atmosphericScope = useSkyStore((s) => s.atmosphericScope);
  const units = useSkyStore((s) => s.units);
  const layout = useSkyStore((s) => s.layout);
  const skyDomePip = useSkyStore((s) => s.skyDomePip);
  const skyDomeZoom = useSkyStore((s) => s.skyDomeZoom);
  const selectedId = useSkyStore((s) => s.selectedId);
  const workerReady = useSkyStore((s) => s.workerReady);
  const odidConfig = useSkyStore((s) => s.odidConfig);
  const airspace = useSkyStore((s) => s.airspace);
  const sweepPulseCounter = useSkyStore((s) => s.sweepPulseCounter);

  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const astroClientRef = useRef<AstroClient | null>(null);
  const odidClientRef = useRef<OpenDroneIdClient | null>(null);
  const deferredInstallPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const liveWebhookDronesRef = useRef<Map<string, DroneEntity>>(new Map());
  const localAdsbBalloonsRef = useRef<Map<string, BalloonEntity>>(new Map());
  const globalAdsbBalloonsRef = useRef<Map<string, BalloonEntity>>(new Map());
  const localAdsbDronesRef = useRef<Map<string, DroneEntity>>(new Map());
  const globalAdsbDronesRef = useRef<Map<string, DroneEntity>>(new Map());
  const simStartMsRef = useRef<number>(Date.now());
  const hydratedRef = useRef(false);
  const entityBuffersRef = useRef<[Map<string, SkyEntity>, Map<string, SkyEntity>]>([
    new Map(),
    new Map(),
  ]);
  const bufferToggleRef = useRef<0 | 1>(0);
  const autoLocateCancelRef = useRef<(() => void) | null>(null);
  const reverseGeoAbortRef = useRef<AbortController | null>(null);

  const flightsInFlightRef = useRef(false);
  const globalFlightsInFlightRef = useRef(false);
  const balloonsInFlightRef = useRef(false);
  const airspaceInFlightRef = useRef(false);

  const flightsAbortRef = useRef<AbortController | null>(null);
  const globalFlightsAbortRef = useRef<AbortController | null>(null);
  const balloonsAbortRef = useRef<AbortController | null>(null);
  const airspaceAbortRef = useRef<AbortController | null>(null);

  const flightsSeqRef = useRef(0);
  const globalFlightsSeqRef = useRef(0);
  const balloonsSeqRef = useRef(0);
  const airspaceSeqRef = useRef(0);

  const lastFlightsAttemptMsRef = useRef<number>(0);
  const nextFlightsDueMsRef = useRef<number>(Date.now() + 10_000);
  const lastGlobalFlightsAttemptMsRef = useRef<number>(0);
  const nextGlobalFlightsDueMsRef = useRef<number>(Date.now() + 18_000);
  const missingSelectedSinceRef = useRef<number | null>(null);
  const zenithNotifiedRef = useRef<Set<string>>(new Set());
  const alertNotifiedRef = useRef<Set<string>>(new Set());
  const prevSelectedIdRef = useRef<string | null>(null);
  const prevAtmosphericScopeRef = useRef<AtmosphericScope>(atmosphericScope);
  const prevBalloonSublayersRef = useRef(balloonSublayers);
  const lastFetchedCoordsRef = useRef<{ lat: number; lon: number } | null>(
    observer.source === 'pending' ? null : { lat: observer.lat, lon: observer.lon }
  );

  const syncAdsbSecondaryRegistries = useCallback(() => {
    const scope = useSkyStore.getState().atmosphericScope;
    const nextBalloons = new Map<string, BalloonEntity>();
    if (scope === 'global') {
      for (const [id, b] of globalAdsbBalloonsRef.current.entries()) {
        nextBalloons.set(id, b);
      }
    }
    for (const [id, b] of localAdsbBalloonsRef.current.entries()) {
      const existing = nextBalloons.get(id);
      nextBalloons.set(
        id,
        existing
          ? {
              ...b,
              icaoHex: b.icaoHex ?? existing.icaoHex,
              registration: b.registration ?? existing.registration,
              squawk: b.squawk ?? existing.squawk,
              emergencyFlag: b.emergencyFlag ?? existing.emergencyFlag,
            }
          : b
      );
    }
    liveKinematicsRegistry.rawAdsbBalloons = nextBalloons;

    const nextDrones = new Map<string, DroneEntity>();
    if (scope === 'global') {
      for (const [id, d] of globalAdsbDronesRef.current.entries()) {
        nextDrones.set(id, d);
      }
    }
    for (const [id, d] of localAdsbDronesRef.current.entries()) {
      const existing = nextDrones.get(id);
      if (!existing) {
        nextDrones.set(id, d);
      } else {
        const mergedIsMil = Boolean(existing.isMilitary || d.isMilitary);
        const mergedIsLadd = Boolean(existing.isLadd || d.isLadd);
        const mergedIsPia = Boolean(existing.isPia || d.isPia);
        nextDrones.set(id, {
          ...d,
          aircraftType: d.aircraftType ?? existing.aircraftType,
          registration: d.registration ?? existing.registration,
          squawk: d.squawk ?? existing.squawk,
          emergencyFlag: d.emergencyFlag ?? existing.emergencyFlag,
          isMilitary: mergedIsMil,
          isLadd: mergedIsLadd || undefined,
          isPia: mergedIsPia || undefined,
          missionDesc: mergedIsMil ? 'LIVE ATC UAS · MILITARY' : d.missionDesc,
        });
      }
    }
    liveKinematicsRegistry.rawAdsbDrones = nextDrones;
  }, []);

  const startAutoLocate = useCallback(() => {
    autoLocateCancelRef.current?.();
    const st0 = useSkyStore.getState();
    if (st0.observer.source === 'pending') {
      st0.setLocationStatus('locating', null);
    }

    const cancel = resolveCurrentGeographicLocation({
      onFix: (fix) => {
        const st = useSkyStore.getState();
        if (fix.source === 'ip' && st.observer.source !== 'pending') {
          return;
        }
        if (
          fix.source === 'gps' &&
          st.observer.source !== 'pending' &&
          st.observer.source !== 'ip'
        ) {
          return;
        }
        st.setObserver({
          lat: fix.lat,
          lon: fix.lon,
          altM: fix.altM,
          label: fix.label,
          source: fix.source,
        });
      },
      onLabelResolved: (lat, lon, source, label) => {
        useSkyStore.getState().updateObserverLabel(lat, lon, source, label);
      },
      onUnavailable: (reason) => {
        const st = useSkyStore.getState();
        if (st.observer.source === 'pending') {
          st.setLocationStatus('unavailable', reason);
        }
      },
    });

    autoLocateCancelRef.current = cancel;
    return () => {
      cancel();
      if (autoLocateCancelRef.current === cancel) {
        autoLocateCancelRef.current = null;
      }
    };
  }, []);

  // 1. Hydrate from explicit URL permalink & always resolve live current geographic location when unpinned
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const patch = parseUrlHashPatch({ ignoreLegacyDefaultDc: true });
      if (patch) {
        useSkyStore.getState().hydrateFromUrlState(patch);
      }
    }

    if (useSkyStore.getState().observer.source === 'pending') {
      return startAutoLocate();
    }
    return undefined;
  }, [startAutoLocate]);

  // Listen for manual URL hash edits cleanly across React StrictMode mounts
  useEffect(() => {
    const handleHashChange = () => {
      const nextPatch = parseUrlHashPatch({ ignoreLegacyDefaultDc: false });
      if (nextPatch) {
        useSkyStore.getState().hydrateFromUrlState(nextPatch);
      }
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // 1b. PWA Install Prompt (`beforeinstallprompt`) & Standalone Mode Detection
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia?.('(display-mode: standalone)') ?? null;
    const getStandalone = () =>
      Boolean(
        mql?.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true
      );

    let dismissed = false;
    try {
      dismissed = window.sessionStorage?.getItem(PWA_DISMISS_STORAGE_KEY) === '1';
    } catch {
      dismissed = false;
    }

    useSkyStore.getState().setPwaInstallState({
      standalone: getStandalone(),
      dismissed,
    });

    const handleDisplayModeChange = () => {
      const standalone = getStandalone();
      useSkyStore.getState().setPwaInstallState({
        standalone,
        available: standalone ? false : undefined,
      });
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      const bipEvent = event as BeforeInstallPromptEvent;
      if (typeof bipEvent.preventDefault === 'function') {
        bipEvent.preventDefault();
      }
      deferredInstallPromptRef.current = bipEvent;
      if (!getStandalone()) {
        useSkyStore.getState().setPwaInstallState({ available: true });
      }
    };

    const handleAppInstalled = () => {
      deferredInstallPromptRef.current = null;
      useSkyStore.getState().setPwaInstallState({
        available: false,
        standalone: true,
      });
    };

    mql?.addEventListener?.('change', handleDisplayModeChange);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      mql?.removeEventListener?.('change', handleDisplayModeChange);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  // 1c. Global Cockpit Keyboard Shortcuts (`⌘K` / `Ctrl+K`, `/`, `Escape`)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const st = useSkyStore.getState();
      const target = event.target as HTMLElement | null;
      const isTextEntry =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        Boolean(target?.isContentEditable);

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (st.odidModalOpen) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        st.setCommandPaletteOpen(!st.commandPaletteOpen);
        return;
      }

      if (event.key === '/' && !isTextEntry && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (!st.odidModalOpen) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.setCommandPaletteOpen(true);
        }
        return;
      }

      if (event.key === 'Escape') {
        if (st.odidModalOpen) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.setOdidModalOpen(false);
          return;
        }
        if (st.commandPaletteOpen) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.setCommandPaletteOpen(false);
          return;
        }
        if (st.diagnosticsOpen || st.settingsOpen) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.setDiagnosticsOpen(false);
          st.setSettingsOpen(false);
          return;
        }
        if (st.activeDockTray !== null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.setActiveDockTray(null);
          return;
        }
        if (st.inspectorOpen || st.selectedId !== null) {
          event.preventDefault();
          event.stopImmediatePropagation();
          st.selectEntity(null, false);
        }
        return;
      }

      if (
        !isTextEntry &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !st.odidModalOpen &&
        !st.commandPaletteOpen
      ) {
        switch (event.key.toLowerCase()) {
          case 'm':
            event.preventDefault();
            st.setLayout('map');
            break;
          case 's':
            event.preventDefault();
            st.setLayout('split');
            break;
          case 'd':
            event.preventDefault();
            st.setLayout('dome');
            break;
          case 'p':
            event.preventDefault();
            if (st.layout === 'map') {
              st.toggleSkyDomePip();
            } else {
              st.setLayout('map');
              st.setSkyDomePip(true);
            }
            break;
          case 'l':
            event.preventDefault();
            st.toggleDomeLabels();
            break;
          default:
            break;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 2. Debounced URL Hash Permalink Synchronization
  useEffect(() => {
    if (typeof window === 'undefined' || observer.source === 'pending') return;
    const timer = window.setTimeout(() => {
      try {
        const nextHash = buildUrlHashString();
        if (window.location.hash !== nextHash) {
          window.history.replaceState(null, '', nextHash);
        }
      } catch {
        // Ignore restricted history frames
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [observer, radiusKm, layers, units, layout, orbitalScope, atmosphericScope, skyDomePip, skyDomeZoom, selectedId]);

  // 3. Dedicated SGP4 Web Worker Lifecycle & TLE Bootstrap
  useEffect(() => {
    let disposed = false;

    const client = new AstroClient({
      onReady: ({ count }) => {
        if (disposed) return;
        const st = useSkyStore.getState();
        st.setWorkerReady(true);
        st.setFeedState('satellites', {
          count,
          status: st.feeds.satellites.status === 'idle' ? 'cached' : st.feeds.satellites.status,
        });
        if (st.observer.source !== 'pending') {
          client.updateConfig({
            observer: st.observer,
            radiusKm: st.radiusKm,
            orbitalScope: st.orbitalScope,
            activeGroups: st.satGroups,
            fullConstellation: st.fullConstellation,
          });
          client.tick(Date.now());
        }
      },
      onPropagated: ({ satellites }) => {
        if (disposed) return;
        const nextMap = new Map<string, SatelliteEntity>();
        for (const sat of satellites) {
          nextMap.set(sat.id, sat);
        }
        liveKinematicsRegistry.satellites = nextMap;
        useSkyStore.getState().setFeedState('satellites', {
          count: satellites.length,
        });
      },
      onOrbitOverlay: (overlay) => {
        if (disposed) return;
        if (useSkyStore.getState().selectedId !== `sat-${overlay.noradId}`) return;
        liveKinematicsRegistry.orbitOverlay = overlay;
        liveKinematicsRegistry.version += 1;
      },
      onError: (msg) => {
        if (disposed) return;
        useSkyStore.getState().setFeedState('satellites', {
          status: 'error',
          errorMsg: msg,
        });
      },
    });

    astroClientRef.current = client;

    // Immediate 0ms static TLE cold-boot, followed by background 2h-TTL CelesTrak refresh
    const bootAbort = new AbortController();
    (async () => {
      const st0 = useSkyStore.getState();
      st0.setFeedState('satellites', { status: 'loading' });
      const initialRecords = await loadInitialTles(bootAbort.signal);
      if (disposed) return;
      if (initialRecords.length > 0) {
        client.initTles(initialRecords, useSkyStore.getState().fullConstellation);
        useSkyStore.getState().setFeedState('satellites', {
          status: 'cached',
          provider: 'seeded-tle-bundle',
          lastUpdatedMs: Date.now(),
          nextRefreshSec: 7200,
        });
      }

      const refreshed = await refreshTlesIfStale(false, { signal: bootAbort.signal });
      if (disposed) return;
      if (refreshed.records.length > 0) {
        client.initTles(refreshed.records, useSkyStore.getState().fullConstellation);
      }
      useSkyStore.getState().setFeedState('satellites', {
        status: refreshed.status,
        provider: refreshed.provider,
        lastUpdatedMs: refreshed.lastUpdatedMs,
        nextRefreshSec: 7200,
        errorMsg: refreshed.errorMsg,
      });
    })().catch((err) => {
      if (!disposed) {
        useSkyStore.getState().setFeedState('satellites', {
          status: 'error',
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // 10Hz Worker propagation tick (paused when tab hidden)
    const tickTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const st = useSkyStore.getState();
      if (st.layers.satellite && st.workerReady && st.observer.source !== 'pending') {
        client.tick(Date.now());
      } else if (!st.layers.satellite && liveKinematicsRegistry.satellites.size > 0) {
        liveKinematicsRegistry.satellites.clear();
      }
    }, 100);

    return () => {
      disposed = true;
      bootAbort.abort();
      window.clearInterval(tickTimer);
      client.dispose();
      astroClientRef.current = null;
    };
  }, []);

  // Push worker configuration whenever observer / radius / scope / groups change
  useEffect(() => {
    const client = astroClientRef.current;
    if (!client || observer.source === 'pending') return;
    client.updateConfig({
      observer,
      radiusKm,
      orbitalScope,
      activeGroups: satGroups,
      fullConstellation,
    });
    if (useSkyStore.getState().workerReady) {
      client.tick(Date.now());
    }
  }, [observer, radiusKm, orbitalScope, satGroups, fullConstellation]);

  // Compute satellite ground track & Sky-Dome pass arc when a satellite is selected
  useEffect(() => {
    const client = astroClientRef.current;
    if (!selectedId || !selectedId.startsWith('sat-') || observer.source === 'pending') {
      liveKinematicsRegistry.orbitOverlay = null;
      return;
    }

    const noradId = Number.parseInt(selectedId.slice(4), 10);
    if (!Number.isFinite(noradId) || !client || !workerReady) {
      if (!Number.isFinite(noradId) || !client) {
        liveKinematicsRegistry.orbitOverlay = null;
      }
      return;
    }

    void client.computeOrbit(noradId, Date.now(), observer);
    const timer = window.setInterval(() => {
      const st = useSkyStore.getState();
      if (st.selectedId === selectedId && st.workerReady && st.observer.source !== 'pending') {
        void client.computeOrbit(noradId, Date.now(), st.observer);
      }
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [selectedId, observer, workerReady]);

  // 4. Data Feed Runners (Local Point Flights, Global Mil/LADD/PIA, Balloons + WindBorne, FAA Airspace)
  const runFlightsRefresh = useCallback(
    async (force = false, resetBreakers = false, abortPrevious = false) => {
      if (typeof document !== 'undefined' && document.hidden && !force) return;
      if (useSkyStore.getState().observer.source === 'pending') return;
      if (abortPrevious && flightsAbortRef.current) {
        flightsAbortRef.current.abort();
        flightsAbortRef.current = null;
        flightsInFlightRef.current = false;
      }
      if (flightsInFlightRef.current) return;

      flightsInFlightRef.current = true;
      const seq = ++flightsSeqRef.current;
      const controller = new AbortController();
      flightsAbortRef.current = controller;

      const attemptNowMs = Date.now();
      lastFlightsAttemptMsRef.current = attemptNowMs;
      nextFlightsDueMsRef.current = attemptNowMs + 10_000;

      const st = useSkyStore.getState();
      st.setFeedState('flights', { status: 'loading' });

      try {
        const res = await fetchFlightsCascade(
          st.observer,
          st.radiusKm,
          liveKinematicsRegistry.rawFlights,
          {
            force,
            resetBreakers,
            signal: controller.signal,
            airspace: st.airspace,
            prevDrones: liveKinematicsRegistry.rawAdsbDrones,
            prevBalloons: liveKinematicsRegistry.rawAdsbBalloons,
          }
        );
        if (seq !== flightsSeqRef.current || controller.signal.aborted) return;

        const nextMap = new Map<string, FlightEntity>();
        for (const f of res.entities) {
          if (!f.onGround) {
            nextMap.set(f.id, f);
          }
        }
        liveKinematicsRegistry.rawFlights = nextMap;

        const nextLocalDrones = new Map<string, DroneEntity>();
        for (const d of res.uasEntities ?? []) {
          nextLocalDrones.set(d.id, d);
        }
        localAdsbDronesRef.current = nextLocalDrones;

        const nextLocalBalloons = new Map<string, BalloonEntity>();
        for (const b of res.balloonEntities ?? []) {
          nextLocalBalloons.set(b.id, b);
        }
        localAdsbBalloonsRef.current = nextLocalBalloons;
        syncAdsbSecondaryRegistries();

        const latestStore = useSkyStore.getState();
        const prevFlightsFeed = latestStore.feeds.flights;
        const resolvedLastUpdated =
          res.timestampMs > 0 ? res.timestampMs : prevFlightsFeed.lastUpdatedMs;
        const checkedAtMs = Date.now();
        nextFlightsDueMsRef.current = checkedAtMs + 10_000;

        latestStore.setFeedState('flights', {
          status: res.status,
          provider: res.provider,
          lastUpdatedMs: resolvedLastUpdated,
          lastCheckedMs: checkedAtMs,
          httpStatus: res.httpStatus,
          nextRefreshSec: 10,
          count: nextMap.size,
          errorMsg: res.errorMsg,
          sourceBreakdown: `Local Point: ${nextMap.size} AC`,
        });
      } catch (err) {
        if (seq !== flightsSeqRef.current || controller.signal.aborted) return;
        const checkedAtMs = Date.now();
        nextFlightsDueMsRef.current = checkedAtMs + 10_000;
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        useSkyStore.getState().setFeedState('flights', {
          status: isOffline ? 'offline' : 'error',
          lastCheckedMs: checkedAtMs,
          nextRefreshSec: 10,
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (seq === flightsSeqRef.current) {
          flightsInFlightRef.current = false;
          if (flightsAbortRef.current === controller) {
            flightsAbortRef.current = null;
          }
        }
      }
    },
    [syncAdsbSecondaryRegistries]
  );

  const runGlobalFlightsRefresh = useCallback(
    async (force = false, resetBreakers = false, abortPrevious = false) => {
      if (typeof document !== 'undefined' && document.hidden && !force) return;
      const st0 = useSkyStore.getState();
      if (st0.observer.source === 'pending') return;
      if (st0.atmosphericScope !== 'global') return;
      if (abortPrevious && globalFlightsAbortRef.current) {
        globalFlightsAbortRef.current.abort();
        globalFlightsAbortRef.current = null;
        globalFlightsInFlightRef.current = false;
      }
      if (globalFlightsInFlightRef.current) return;

      globalFlightsInFlightRef.current = true;
      const seq = ++globalFlightsSeqRef.current;
      const controller = new AbortController();
      globalFlightsAbortRef.current = controller;

      const attemptNowMs = Date.now();
      lastGlobalFlightsAttemptMsRef.current = attemptNowMs;
      nextGlobalFlightsDueMsRef.current = attemptNowMs + 18_000;

      st0.setFeedState('military', { status: 'loading' });

      try {
        const res = await fetchGlobalSpecialFlights(
          st0.observer,
          liveKinematicsRegistry.rawGlobalFlights,
          {
            force,
            resetBreakers,
            signal: controller.signal,
            airspace: st0.airspace,
            prevDrones: liveKinematicsRegistry.rawAdsbDrones,
            prevBalloons: liveKinematicsRegistry.rawAdsbBalloons,
          }
        );
        if (seq !== globalFlightsSeqRef.current || controller.signal.aborted) return;

        const latestStore = useSkyStore.getState();
        if (latestStore.atmosphericScope !== 'global') {
          return;
        }

        const nextMap = new Map<string, FlightEntity>();
        for (const f of res.entities) {
          if (!f.onGround) {
            nextMap.set(f.id, f);
          }
        }
        liveKinematicsRegistry.rawGlobalFlights = nextMap;

        const nextGlobalDrones = new Map<string, DroneEntity>();
        for (const d of res.uasEntities ?? []) {
          nextGlobalDrones.set(d.id, d);
        }
        globalAdsbDronesRef.current = nextGlobalDrones;

        const nextGlobalBalloons = new Map<string, BalloonEntity>();
        for (const b of res.balloonEntities ?? []) {
          nextGlobalBalloons.set(b.id, b);
        }
        globalAdsbBalloonsRef.current = nextGlobalBalloons;
        syncAdsbSecondaryRegistries();

        const prevMilFeed = latestStore.feeds.military;
        const resolvedLastUpdated =
          res.timestampMs > 0 ? res.timestampMs : prevMilFeed.lastUpdatedMs;
        const checkedAtMs = Date.now();
        nextGlobalFlightsDueMsRef.current = checkedAtMs + 18_000;

        latestStore.setFeedState('military', {
          status: res.status,
          provider: res.provider,
          lastUpdatedMs: resolvedLastUpdated,
          lastCheckedMs: checkedAtMs,
          httpStatus: res.httpStatus,
          nextRefreshSec: 18,
          count: nextMap.size,
          errorMsg: res.errorMsg,
          sourceBreakdown: `MIL: ${res.sourceCounts.mil} · LADD: ${res.sourceCounts.ladd} · PIA: ${res.sourceCounts.pia}`,
        });
      } catch (err) {
        if (seq !== globalFlightsSeqRef.current || controller.signal.aborted) return;
        const checkedAtMs = Date.now();
        nextGlobalFlightsDueMsRef.current = checkedAtMs + 18_000;
        const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
        useSkyStore.getState().setFeedState('military', {
          status: isOffline ? 'offline' : 'error',
          lastCheckedMs: checkedAtMs,
          nextRefreshSec: 18,
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (seq === globalFlightsSeqRef.current) {
          globalFlightsInFlightRef.current = false;
          if (globalFlightsAbortRef.current === controller) {
            globalFlightsAbortRef.current = null;
          }
        }
      }
    },
    [syncAdsbSecondaryRegistries]
  );

  const runBalloonsRefresh = useCallback(
    async (force = false, resetBreakers = false, abortPrevious = false) => {
      if (useSkyStore.getState().observer.source === 'pending') return;
      if (abortPrevious && balloonsAbortRef.current) {
        balloonsAbortRef.current.abort();
        balloonsAbortRef.current = null;
        balloonsInFlightRef.current = false;
      }
      if (balloonsInFlightRef.current) return;

      balloonsInFlightRef.current = true;
      const seq = ++balloonsSeqRef.current;
      const controller = new AbortController();
      balloonsAbortRef.current = controller;

      const st = useSkyStore.getState();
      st.setFeedState('balloons', { status: 'loading' });

      try {
        const res = await fetchBalloons(
          st.observer,
          st.radiusKm,
          liveKinematicsRegistry.rawBalloons,
          {
            force,
            resetBreakers,
            scope: st.atmosphericScope,
            includeWindBorne: st.balloonSublayers.windborne,
            includeSondeHub: st.balloonSublayers.sondehub,
            signal: controller.signal,
          }
        );
        if (seq !== balloonsSeqRef.current || controller.signal.aborted) return;

        const nextMap = new Map<string, BalloonEntity>();
        for (const b of res.entities) {
          nextMap.set(b.id, b);
        }
        liveKinematicsRegistry.rawBalloons = nextMap;

        const store = useSkyStore.getState();
        const ltaCount = liveKinematicsRegistry.rawAdsbBalloons.size;
        const wbCount = res.sourceCounts?.windborne ?? 0;
        const shCount = res.sourceCounts?.sondehub ?? 0;

        store.setNearestSondeHint(res.nearestSondeHint);
        store.setFeedState('balloons', {
          status: res.status,
          provider: res.provider,
          lastUpdatedMs:
            res.timestampMs > 0 ? res.timestampMs : store.feeds.balloons.lastUpdatedMs,
          lastCheckedMs: Date.now(),
          nextRefreshSec: 30,
          count: res.entities.length + ltaCount,
          errorMsg: res.errorMsg,
          sourceBreakdown: `WindBorne: ${wbCount} · SondeHub: ${shCount} · ADS-B LTA: ${ltaCount}`,
        });
      } catch (err) {
        if (seq !== balloonsSeqRef.current || controller.signal.aborted) return;
        useSkyStore.getState().setFeedState('balloons', {
          status: 'error',
          lastCheckedMs: Date.now(),
          nextRefreshSec: 30,
          errorMsg: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (seq === balloonsSeqRef.current) {
          balloonsInFlightRef.current = false;
          if (balloonsAbortRef.current === controller) {
            balloonsAbortRef.current = null;
          }
        }
      }
    },
    []
  );

  const runAirspaceRefresh = useCallback(async (abortPrevious = false) => {
    if (useSkyStore.getState().observer.source === 'pending') return;
    if (abortPrevious && airspaceAbortRef.current) {
      airspaceAbortRef.current.abort();
      airspaceAbortRef.current = null;
      airspaceInFlightRef.current = false;
    }
    if (airspaceInFlightRef.current) return;

    airspaceInFlightRef.current = true;
    const seq = ++airspaceSeqRef.current;
    const controller = new AbortController();
    airspaceAbortRef.current = controller;

    const st = useSkyStore.getState();
    st.setFeedState('airspace', { status: 'loading' });

    try {
      const res = await fetchAirspace(st.observer, st.radiusKm, {
        signal: controller.signal,
      });
      if (seq !== airspaceSeqRef.current || controller.signal.aborted) return;

      const store = useSkyStore.getState();
      store.setAirspace(res.airspace);
      store.setFeedState('airspace', {
        status: res.status,
        provider: res.provider,
        lastUpdatedMs: res.timestampMs,
        lastCheckedMs: Date.now(),
        nextRefreshSec: 300,
        count: res.airspace.uasfm.features.length + res.airspace.sua.features.length,
        errorMsg: res.errorMsg,
        sourceBreakdown: `UASFM: ${res.airspace.uasfm.features.length} · SUA/TFR: ${res.airspace.sua.features.length}`,
      });
    } catch (err) {
      if (seq !== airspaceSeqRef.current || controller.signal.aborted) return;
      useSkyStore.getState().setFeedState('airspace', {
        status: 'error',
        lastCheckedMs: Date.now(),
        nextRefreshSec: 300,
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (seq === airspaceSeqRef.current) {
        airspaceInFlightRef.current = false;
        if (airspaceAbortRef.current === controller) {
          airspaceAbortRef.current = null;
        }
      }
    }
  }, []);

  // Abort active fetch controllers cleanly on App unmount
  useEffect(() => {
    return () => {
      autoLocateCancelRef.current?.();
      autoLocateCancelRef.current = null;
      reverseGeoAbortRef.current?.abort();
      reverseGeoAbortRef.current = null;
      flightsAbortRef.current?.abort();
      globalFlightsAbortRef.current?.abort();
      balloonsAbortRef.current?.abort();
      airspaceAbortRef.current?.abort();
    };
  }, []);

  // Refresh feeds on observer/radius change (purging distant targets immediately on >50km jumps)
  useEffect(() => {
    if (observer.source === 'pending') return undefined;

    const prevCoords = lastFetchedCoordsRef.current;
    const jumpKm = prevCoords
      ? haversineDistanceKm(prevCoords.lat, prevCoords.lon, observer.lat, observer.lon)
      : Number.POSITIVE_INFINITY;
    lastFetchedCoordsRef.current = { lat: observer.lat, lon: observer.lon };

    if (jumpKm > 50) {
      liveKinematicsRegistry.rawFlights.clear();
      localAdsbBalloonsRef.current.clear();
      localAdsbDronesRef.current.clear();
      liveKinematicsRegistry.rawDrones.clear();
      if (useSkyStore.getState().atmosphericScope === 'local') {
        liveKinematicsRegistry.rawBalloons.clear();
      }
      syncAdsbSecondaryRegistries();
      liveKinematicsRegistry.version += 1;
      useSkyStore.getState().setFeedState('flights', {
        lastUpdatedMs: null,
        lastCheckedMs: null,
        httpStatus: undefined,
        provider: 'adsb-cascade',
        count: 0,
        errorMsg: undefined,
      });
      void runFlightsRefresh(true, true, true);
      void runBalloonsRefresh(true, true, true);
      void runAirspaceRefresh(true);
      if (useSkyStore.getState().atmosphericScope === 'global') {
        void runGlobalFlightsRefresh(true, false, true);
      }
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void runFlightsRefresh(true, true, true);
      void runBalloonsRefresh(true, false, true);
      void runAirspaceRefresh(true);
      if (useSkyStore.getState().atmosphericScope === 'global') {
        void runGlobalFlightsRefresh(false, false, false);
      }
    }, 280);
    return () => window.clearTimeout(timer);
  }, [
    observer.lat,
    observer.lon,
    observer.source,
    radiusKm,
    runFlightsRefresh,
    runGlobalFlightsRefresh,
    runBalloonsRefresh,
    runAirspaceRefresh,
    syncAdsbSecondaryRegistries,
  ]);

  // React to Atmospheric Scope (`LOCAL` <-> `GLOBAL`) and Balloon sub-layer toggles
  useEffect(() => {
    const prevScope = prevAtmosphericScopeRef.current;
    prevAtmosphericScopeRef.current = atmosphericScope;

    if (prevScope === atmosphericScope) return;

    if (atmosphericScope === 'local') {
      globalFlightsAbortRef.current?.abort();
      globalFlightsAbortRef.current = null;
      globalFlightsInFlightRef.current = false;
      liveKinematicsRegistry.rawGlobalFlights.clear();
      const stNow = useSkyStore.getState();
      for (const [bId, bEntity] of liveKinematicsRegistry.rawBalloons.entries()) {
        if (
          bEntity.subSource === 'windborne' ||
          haversineDistanceKm(stNow.observer.lat, stNow.observer.lon, bEntity.lat, bEntity.lon) >
            stNow.radiusKm * 1.02
        ) {
          liveKinematicsRegistry.rawBalloons.delete(bId);
        }
      }
      globalAdsbBalloonsRef.current.clear();
      globalAdsbDronesRef.current.clear();
      syncAdsbSecondaryRegistries();
      liveKinematicsRegistry.version += 1;
      useSkyStore.getState().setFeedState('military', {
        status: 'idle',
        count: 0,
        sourceBreakdown: 'LOCAL SCOPE · VIA /V2/POINT',
        errorMsg: undefined,
      });
      void runBalloonsRefresh(true, false, true);
    } else {
      void runGlobalFlightsRefresh(true, false, true);
      void runBalloonsRefresh(true, false, true);
    }
  }, [atmosphericScope, runGlobalFlightsRefresh, runBalloonsRefresh, syncAdsbSecondaryRegistries]);

  useEffect(() => {
    const prev = prevBalloonSublayersRef.current;
    prevBalloonSublayersRef.current = balloonSublayers;
    if (
      (!prev.windborne && balloonSublayers.windborne) ||
      (!prev.sondehub && balloonSublayers.sondehub)
    ) {
      void runBalloonsRefresh(true, false, true);
    }
  }, [balloonSublayers, runBalloonsRefresh]);

  // Manual Sweep trigger
  useEffect(() => {
    if (sweepPulseCounter === 0) return;
    tacticalAudio.playSweepPulse();
    void runFlightsRefresh(true, true);
    void runBalloonsRefresh(true, true);
    void runAirspaceRefresh();
    if (useSkyStore.getState().atmosphericScope === 'global') {
      void runGlobalFlightsRefresh(true, true);
    }
    if (astroClientRef.current && useSkyStore.getState().workerReady) {
      astroClientRef.current.tick(Date.now());
    }
  }, [
    sweepPulseCounter,
    runFlightsRefresh,
    runGlobalFlightsRefresh,
    runBalloonsRefresh,
    runAirspaceRefresh,
  ]);

  // 1Hz Wall-Clock Scheduler & Online/Offline/Visibility Recovery
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const store = useSkyStore.getState();
      store.tickCountdowns();
      const nowMs = Date.now();
      const feeds = useSkyStore.getState().feeds;
      if (
        (nowMs >= nextFlightsDueMsRef.current || feeds.flights.nextRefreshSec <= 0) &&
        (store.layers.flight || store.layers.military || store.layers.balloon || store.layers.drone)
      ) {
        const shouldForce = nowMs - lastFlightsAttemptMsRef.current >= 9_800;
        void runFlightsRefresh(shouldForce, false);
      }
      if (
        store.atmosphericScope === 'global' &&
        (nowMs >= nextGlobalFlightsDueMsRef.current || feeds.military.nextRefreshSec <= 0) &&
        (store.layers.military || store.layers.balloon || store.layers.drone)
      ) {
        const shouldForceGlobal = nowMs - lastGlobalFlightsAttemptMsRef.current >= 17_500;
        void runGlobalFlightsRefresh(shouldForceGlobal, false);
      }
      if (feeds.balloons.nextRefreshSec <= 0 && store.layers.balloon) {
        void runBalloonsRefresh();
      }
      if (feeds.airspace.nextRefreshSec <= 0 && store.layers.drone) {
        void runAirspaceRefresh();
      }
    }, 1000);

    const handleOffline = () => {
      const nowMs = Date.now();
      let hasFresh = false;
      for (const [id, flight] of liveKinematicsRegistry.rawFlights.entries()) {
        if (nowMs - flight.timestampMs > 45_000) {
          liveKinematicsRegistry.rawFlights.delete(id);
        } else {
          hasFresh = true;
        }
      }
      if (!hasFresh) {
        liveKinematicsRegistry.rawFlights.clear();
        liveKinematicsRegistry.rawGlobalFlights.clear();
        liveKinematicsRegistry.version += 1;
        useSkyStore.getState().setFeedState('flights', {
          status: 'offline',
          lastCheckedMs: nowMs,
          count: 0,
          errorMsg: 'Network connection offline',
        });
        useSkyStore.getState().setFeedState('military', {
          status: 'offline',
          lastCheckedMs: nowMs,
          count: 0,
          errorMsg: 'Network connection offline',
        });
      }
    };

    const handleOnline = () => {
      const st = useSkyStore.getState();
      if (st.layers.flight || st.layers.military || st.layers.balloon || st.layers.drone) {
        void runFlightsRefresh(true, true);
      }
      if (st.atmosphericScope === 'global') {
        void runGlobalFlightsRefresh(true, true);
      }
      if (st.layers.balloon) {
        void runBalloonsRefresh(true, true);
      }
      if (st.layers.drone) {
        void runAirspaceRefresh();
      }
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const st = useSkyStore.getState();
      if (astroClientRef.current && st.workerReady && st.layers.satellite) {
        astroClientRef.current.tick(Date.now());
      }
      if (
        Date.now() >= nextFlightsDueMsRef.current &&
        (st.layers.flight || st.layers.military)
      ) {
        void runFlightsRefresh(true);
      }
      if (
        st.atmosphericScope === 'global' &&
        Date.now() >= nextGlobalFlightsDueMsRef.current &&
        (st.layers.military || st.layers.balloon || st.layers.drone)
      ) {
        void runGlobalFlightsRefresh(true);
      }
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [runFlightsRefresh, runGlobalFlightsRefresh, runBalloonsRefresh, runAirspaceRefresh]);

  // 5. OpenDroneID Live Client & 1Hz Tactical Drone Simulator
  useEffect(() => {
    const client = new OpenDroneIdClient(observer, airspace, {
      onDrones: (drones) => {
        const nowMs = Date.now();
        for (const d of drones) {
          liveWebhookDronesRef.current.set(d.id, d);
        }
        for (const [id, existing] of liveWebhookDronesRef.current.entries()) {
          if (nowMs - existing.timestampMs > 120_000) {
            liveWebhookDronesRef.current.delete(id);
          }
        }
      },
      onStatus: (status) => {
        useSkyStore.getState().updateOdidConfig({
          transport: status.transport,
          connected: status.connected,
          lastError: status.lastError,
        });
      },
    });

    odidClientRef.current = client;

    if (odidConfig.transport !== 'off' && odidConfig.endpointUrl.trim()) {
      client.connect(odidConfig.endpointUrl);
    }

    return () => {
      client.disconnect();
      liveWebhookDronesRef.current.clear();
      odidClientRef.current = null;
    };
  }, [odidConfig.endpointUrl, odidConfig.transport]);

  useEffect(() => {
    odidClientRef.current?.updateContext(observer, airspace);
  }, [observer, airspace]);

  useEffect(() => {
    const tickDrones = () => {
      const st = useSkyStore.getState();
      if (st.observer.source === 'pending') return;
      const combined = new Map<string, DroneEntity>();

      if (st.odidConfig.simulatorEnabled && st.droneSublayers.simOdid) {
        const elapsedSec = (Date.now() - simStartMsRef.current) / 1000;
        const simDrones = stepSimulatedDrones(
          st.observer,
          st.radiusKm,
          elapsedSec,
          st.airspace,
          liveKinematicsRegistry.rawDrones
        );
        for (const d of simDrones) {
          combined.set(d.id, d);
        }
      }

      if (st.odidConfig.connected || liveWebhookDronesRef.current.size > 0) {
        const nowMs = Date.now();
        for (const [id, drone] of liveWebhookDronesRef.current.entries()) {
          if (nowMs - drone.timestampMs > 120_000) {
            liveWebhookDronesRef.current.delete(id);
            continue;
          }
          const compliance = evaluateDroneAirspaceCompliance(
            drone.lat,
            drone.lon,
            drone.altAglM,
            st.airspace
          );
          const emergencyFlag = compliance.tfrBreach
            ? 'TFR / SUA INCURSION'
            : compliance.ceilingBreach
              ? `UASFM ${compliance.faaCeilingFt ?? 0}ft BREACH`
              : undefined;
          combined.set(id, {
            ...drone,
            subSource: drone.subSource ?? 'odid-live',
            hasOperatorLocation: true,
            faaCeilingFt: compliance.faaCeilingFt,
            ceilingBreach: compliance.ceilingBreach,
            tfrBreach: compliance.tfrBreach,
            emergencyFlag,
          });
        }
      }

      liveKinematicsRegistry.rawDrones = combined;
      const adsbUasCount = st.droneSublayers.liveUas
        ? liveKinematicsRegistry.rawAdsbDrones.size
        : 0;
      const totalDronesCount = combined.size + adsbUasCount;
      const droneActive =
        st.odidConfig.connected || st.odidConfig.simulatorEnabled || adsbUasCount > 0;
      const nextStatus = st.odidConfig.connected
        ? 'live'
        : adsbUasCount > 0
          ? 'live'
          : st.odidConfig.simulatorEnabled
            ? 'fallback'
            : 'idle';
      const nextProvider = st.odidConfig.connected
        ? adsbUasCount > 0
          ? 'opendroneid+adsb-uas'
          : 'opendroneid-stream'
        : adsbUasCount > 0
          ? 'adsb-live-uas'
          : st.odidConfig.simulatorEnabled
            ? 'sim-opendroneid'
            : 'off';

      const prevFeed = st.feeds.drones;
      const breakdown = `ATC UAS: ${adsbUasCount} · ODID: ${combined.size}`;
      if (
        droneActive ||
        prevFeed.status !== nextStatus ||
        prevFeed.provider !== nextProvider ||
        prevFeed.count !== totalDronesCount ||
        prevFeed.sourceBreakdown !== breakdown
      ) {
        st.setFeedState('drones', {
          status: nextStatus,
          provider: nextProvider,
          lastUpdatedMs: droneActive ? Date.now() : null,
          nextRefreshSec: 1,
          count: totalDronesCount,
          sourceBreakdown: breakdown,
        });
      }
    };

    tickDrones();
    const timer = window.setInterval(tickDrones, 1000);
    return () => window.clearInterval(timer);
  }, [
    observer,
    radiusKm,
    airspace,
    odidConfig.simulatorEnabled,
    odidConfig.connected,
    droneSublayers.simOdid,
    droneSublayers.liveUas,
  ]);

  // 6. Target Lock Audio Feedback
  useEffect(() => {
    if (selectedId && selectedId !== prevSelectedIdRef.current) {
      tacticalAudio.playTargetLock();
    }
    prevSelectedIdRef.current = selectedId;
  }, [selectedId]);

  // 7. 60fps Dead-Reckoning Kinematic Loop & Store Snapshot Sync
  useEffect(() => {
    let rafId = 0;
    let fpsFrameCount = 0;
    let fpsWindowStart = performance.now();
    let lastSnapshotSyncMs = 0;

    const stepKinematics = (perfNow: number) => {
      rafId = window.requestAnimationFrame(stepKinematics);

      const nowMs = Date.now();
      const st = useSkyStore.getState();
      const obs = st.observer;
      if (obs.source === 'pending') {
        if (liveKinematicsRegistry.entities.size > 0) {
          liveKinematicsRegistry.entities.clear();
          liveKinematicsRegistry.version += 1;
        }
        return;
      }
            const nextEntities = entityBuffersRef.current[bufferToggleRef.current];
      bufferToggleRef.current = bufferToggleRef.current === 0 ? 1 : 0;
      nextEntities.clear();

      const counts: {
        flight: number;
        military: number;
        satellite: number;
        balloon: number;
        drone: number;
        overhead: number;
        overheadConeDeg: 45 | 20;
        total: number;
      } = {
        flight: 0,
        military: 0,
        satellite: 0,
        balloon: 0,
        drone: 0,
        overhead: 0,
        overheadConeDeg: 45,
        total: 0,
      };
      let overheadPrimary = 0;
      let overheadFallback = 0;

      const checkAcousticEvents = (entity: SkyEntity, enabled: boolean) => {
        if (!enabled) return;
        if (entity.topocentric.elevationDeg >= 75) {
          if (!zenithNotifiedRef.current.has(entity.id)) {
            zenithNotifiedRef.current.add(entity.id);
            if (zenithNotifiedRef.current.size > 200) zenithNotifiedRef.current.clear();
            tacticalAudio.playZenithChime();
          }
        } else if (entity.topocentric.elevationDeg < 65) {
          zenithNotifiedRef.current.delete(entity.id);
        }

        const hasEmergency =
          (entity.category === 'flight' || entity.category === 'military') &&
          (entity.squawk === '7700' ||
            entity.squawk === '7600' ||
            entity.squawk === '7500' ||
            Boolean(entity.emergencyFlag));
        const hasBreach =
          entity.category === 'drone' && (entity.ceilingBreach || entity.tfrBreach);

        if (hasEmergency || hasBreach) {
          if (!alertNotifiedRef.current.has(entity.id)) {
            alertNotifiedRef.current.add(entity.id);
            if (alertNotifiedRef.current.size > 200) alertNotifiedRef.current.clear();
            tacticalAudio.playAlertTone();
          }
        } else {
          alertNotifiedRef.current.delete(entity.id);
        }
      };

      const isSublayerVisible = (entity: SkyEntity): boolean => {
        if (entity.category === 'balloon') {
          if (entity.subSource === 'windborne') return st.balloonSublayers.windborne;
          if (entity.subSource === 'adsb-lta') return st.balloonSublayers.adsbLta;
          return st.balloonSublayers.sondehub;
        }
        if (entity.category === 'drone') {
          if (entity.subSource === 'odid-sim' || entity.isSimulated) {
            return st.droneSublayers.simOdid;
          }
          return st.droneSublayers.liveUas;
        }
        return true;
      };

      const pushExtrapolatedEntity = (entity: SkyEntity) => {
        const prevExisting = nextEntities.get(entity.id);
        if (prevExisting) {
          if (
            (prevExisting.category === 'flight' || prevExisting.category === 'military') &&
            (entity.category === 'flight' || entity.category === 'military')
          ) {
            const mergedIsMil = prevExisting.isMilitary || entity.isMilitary;
            const mergedIsLadd = Boolean(prevExisting.isLadd || entity.isLadd);
            const mergedIsPia = Boolean(prevExisting.isPia || entity.isPia);
            const nextCat: 'flight' | 'military' =
              mergedIsMil || (!prevExisting.onGround && (mergedIsLadd || mergedIsPia))
                ? 'military'
                : prevExisting.category;

            if (nextCat !== prevExisting.category) {
              if (st.layers[prevExisting.category]) {
                counts[prevExisting.category] = Math.max(0, counts[prevExisting.category] - 1);
                counts.total = Math.max(0, counts.total - 1);
                if (prevExisting.topocentric.elevationDeg >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
                  overheadPrimary = Math.max(0, overheadPrimary - 1);
                } else if (prevExisting.topocentric.elevationDeg >= OVERHEAD_FALLBACK_MIN_EL_DEG) {
                  overheadFallback = Math.max(0, overheadFallback - 1);
                }
              }
              if (st.layers[nextCat]) {
                counts[nextCat] += 1;
                counts.total += 1;
                if (prevExisting.topocentric.elevationDeg >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
                  overheadPrimary += 1;
                } else if (prevExisting.topocentric.elevationDeg >= OVERHEAD_FALLBACK_MIN_EL_DEG) {
                  overheadFallback += 1;
                }
              } else {
                nextEntities.delete(entity.id);
                return;
              }
            }

            nextEntities.set(entity.id, {
              ...prevExisting,
              category: nextCat,
              airframeClass: pickRicherAirframeClass(prevExisting.airframeClass, entity.airframeClass),
              aircraftType: prevExisting.aircraftType ?? entity.aircraftType,
              registration: prevExisting.registration ?? entity.registration,
              squawk: prevExisting.squawk ?? entity.squawk,
              emergencyFlag: prevExisting.emergencyFlag ?? entity.emergencyFlag,
              isMilitary: mergedIsMil,
              isLadd: mergedIsLadd || undefined,
              isPia: mergedIsPia || undefined,
            });
          }
          return;
        }

        if (!st.layers[entity.category] || !isSublayerVisible(entity)) return;
        nextEntities.set(entity.id, entity);
        counts[entity.category] += 1;
        counts.total += 1;
        if (entity.topocentric.elevationDeg >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
          overheadPrimary += 1;
        } else if (entity.topocentric.elevationDeg >= OVERHEAD_FALLBACK_MIN_EL_DEG) {
          overheadFallback += 1;
        }
        checkAcousticEvents(entity, st.audioEnabled);
      };

      // Atmospheric feeds: dead-reckoning interpolation at 60fps + real-time WGS-84 look angles
      const pushAtmospheric = <T extends SkyEntity>(
        sourceMap: Map<string, T>,
        maxDtSec: number,
        pruneStaleMs: number
      ) => {
        const allowGlobalScope =
          sourceMap === liveKinematicsRegistry.rawGlobalFlights ||
          sourceMap === liveKinematicsRegistry.rawBalloons ||
          sourceMap === liveKinematicsRegistry.rawAdsbBalloons ||
          sourceMap === liveKinematicsRegistry.rawAdsbDrones;
        for (const [id, raw] of sourceMap.entries()) {
          if ((raw.category === 'flight' || raw.category === 'military') && raw.onGround) {
            sourceMap.delete(id);
            continue;
          }

          const ageMs = nowMs - raw.timestampMs;
          const isCachedSeedBalloon = raw.category === 'balloon' && Boolean(raw.isCachedSeed);
          if (!isCachedSeedBalloon && (ageMs > pruneStaleMs || ageMs < -60_000)) {
            sourceMap.delete(id);
            continue;
          }

          const dtSec = isCachedSeedBalloon
            ? 0
            : Math.max(0, Math.min(maxDtSec, ageMs / 1000));
          const isFlight = raw.category === 'flight' || raw.category === 'military';
          const isMoving = isFlight
            ? !raw.onGround &&
              raw.headingValid !== false &&
              raw.speedMs > 1 &&
              ageMs <= 15_000
            : raw.headingValid !== false && raw.speedMs > 0.2;

          const extrap = isMoving
            ? extrapolateDeadReckoning(
                raw.lat,
                raw.lon,
                raw.speedMs,
                raw.headingDeg,
                dtSec,
                raw.altM,
                raw.vertRateMs
              )
            : { lat: raw.lat, lon: raw.lon, altM: raw.altM };

          const topocentric = computeTopocentricLookAngles(
            obs,
            { lat: extrap.lat, lon: extrap.lon, altM: extrap.altM },
            true
          );

          const isLocalBalloon = raw.category === 'balloon' && (!allowGlobalScope || st.atmosphericScope === 'local');
          const isLocalMilitary = raw.category === 'military' && (!allowGlobalScope || st.atmosphericScope === 'local');
          const isLocalFlight = raw.category === 'flight';
          const isLocalAdsbDrone =
            raw.category === 'drone' &&
            raw.subSource === 'adsb-uas' &&
            st.atmosphericScope === 'local';

          if (
            (isLocalFlight || isLocalMilitary || isLocalBalloon || isLocalAdsbDrone) &&
            topocentric.groundDistKm > st.radiusKm * 1.02
          ) {
            sourceMap.delete(id);
            continue;
          }

          const updated: T = {
            ...raw,
            lat: extrap.lat,
            lon: extrap.lon,
            altM: extrap.altM,
            topocentric,
          };

          // Upgrade category cleanly before layer check if local point hex matches global military/LADD/PIA
          if (
            st.atmosphericScope === 'global' &&
            updated.category === 'flight' &&
            liveKinematicsRegistry.rawGlobalFlights.has(id)
          ) {
            const globalMatch = liveKinematicsRegistry.rawGlobalFlights.get(id)!;
            const mergedMil = updated.isMilitary || globalMatch.isMilitary;
            const mergedLadd = Boolean(updated.isLadd || globalMatch.isLadd);
            const mergedPia = Boolean(updated.isPia || globalMatch.isPia);
            const resolvedFlight: FlightEntity = {
              ...updated,
              airframeClass: pickRicherAirframeClass(updated.airframeClass, globalMatch.airframeClass),
              aircraftType: updated.aircraftType ?? globalMatch.aircraftType,
              registration: updated.registration ?? globalMatch.registration,
              squawk: updated.squawk ?? globalMatch.squawk,
              emergencyFlag: updated.emergencyFlag ?? globalMatch.emergencyFlag,
              isMilitary: mergedMil,
              isLadd: mergedLadd || undefined,
              isPia: mergedPia || undefined,
              category:
                mergedMil || (!updated.onGround && (mergedLadd || mergedPia))
                  ? 'military'
                  : updated.category,
            };
            pushExtrapolatedEntity(resolvedFlight);
            continue;
          }

          pushExtrapolatedEntity(updated);
        }
      };

      if (st.layers.flight || st.layers.military) {
        pushAtmospheric(liveKinematicsRegistry.rawFlights, 12, 60_000);
      }
      if (st.atmosphericScope === 'global' && st.layers.military) {
        pushAtmospheric(liveKinematicsRegistry.rawGlobalFlights, 18, 90_000);
      }
      if (st.layers.balloon) {
        pushAtmospheric(liveKinematicsRegistry.rawBalloons, 35, 21_600_000);
        pushAtmospheric(liveKinematicsRegistry.rawAdsbBalloons, 20, 180_000);
      }
      if (st.layers.drone) {
        pushAtmospheric(liveKinematicsRegistry.rawDrones, 3, 60_000);
        pushAtmospheric(liveKinematicsRegistry.rawAdsbDrones, 12, 90_000);
      }

      // Orbital satellites: smooth micro-interpolation between 10Hz SGP4 Worker frames
      if (st.layers.satellite) {
        for (const [id, sat] of liveKinematicsRegistry.satellites.entries()) {
          if (!st.satGroups[sat.group]) continue;
          const dtSec = Math.max(0, Math.min(0.25, (nowMs - sat.timestampMs) / 1000));
          const extrap =
            dtSec > 0.005
              ? extrapolateDeadReckoning(
                  sat.lat,
                  sat.lon,
                  sat.speedMs,
                  sat.headingDeg,
                  dtSec,
                  sat.altM,
                  0
                )
              : { lat: sat.lat, lon: sat.lon, altM: sat.altM };

          const topocentric =
            dtSec > 0.005
              ? computeTopocentricLookAngles(
                  obs,
                  { lat: extrap.lat, lon: extrap.lon, altM: extrap.altM },
                  false
                )
              : sat.topocentric;

          const updated: SatelliteEntity = {
            ...sat,
            lat: extrap.lat,
            lon: extrap.lon,
            altM: extrap.altM,
            topocentric,
          };
          nextEntities.set(id, updated);

          counts.satellite += 1;
          counts.total += 1;
          if (topocentric.elevationDeg >= OVERHEAD_PRIMARY_MIN_EL_DEG) {
            overheadPrimary += 1;
          } else if (topocentric.elevationDeg >= OVERHEAD_FALLBACK_MIN_EL_DEG) {
            overheadFallback += 1;
          }
          checkAcousticEvents(updated, st.audioEnabled);
        }
      }

      counts.overhead = overheadPrimary > 0 ? overheadPrimary : overheadFallback;
      counts.overheadConeDeg = overheadPrimary > 0 ? 45 : 20;

      liveKinematicsRegistry.entities = nextEntities;
      liveKinematicsRegistry.version += 1;

      fpsFrameCount += 1;
      if (perfNow - fpsWindowStart >= 1000) {
        const measuredFps = Math.round((fpsFrameCount * 1000) / (perfNow - fpsWindowStart));
        st.setFps(measuredFps);
        fpsFrameCount = 0;
        fpsWindowStart = perfNow;
      }

      if (perfNow - lastSnapshotSyncMs >= 200) {
        lastSnapshotSyncMs = perfNow;
        const prevCounts = st.counts;
        if (
          prevCounts.flight !== counts.flight ||
          prevCounts.military !== counts.military ||
          prevCounts.satellite !== counts.satellite ||
          prevCounts.balloon !== counts.balloon ||
          prevCounts.drone !== counts.drone ||
          prevCounts.overhead !== counts.overhead ||
          prevCounts.overheadConeDeg !== counts.overheadConeDeg ||
          prevCounts.total !== counts.total
        ) {
          st.setCounts(counts);
        }

        if (st.feeds.flights.count !== liveKinematicsRegistry.rawFlights.size) {
          st.setFeedState('flights', { count: liveKinematicsRegistry.rawFlights.size });
        }
        if (
          st.atmosphericScope === 'global' &&
          st.feeds.military.count !== liveKinematicsRegistry.rawGlobalFlights.size
        ) {
          st.setFeedState('military', { count: liveKinematicsRegistry.rawGlobalFlights.size });
        }
        const totalBalloonPool =
          liveKinematicsRegistry.rawBalloons.size + liveKinematicsRegistry.rawAdsbBalloons.size;
        if (st.feeds.balloons.count !== totalBalloonPool) {
          st.setFeedState('balloons', { count: totalBalloonPool });
        }

        if (st.selectedId) {
          const currentSelected = nextEntities.get(st.selectedId) ?? null;
          if (currentSelected) {
            missingSelectedSinceRef.current = null;
            st.setSelectedEntitySnapshot({ ...currentSelected });
          } else {
            st.setSelectedEntitySnapshot(null);
            if (st.workerReady && st.feeds.flights.lastCheckedMs !== null) {
              if (missingSelectedSinceRef.current === null) {
                missingSelectedSinceRef.current = perfNow;
              } else if (perfNow - missingSelectedSinceRef.current > 2500) {
                missingSelectedSinceRef.current = null;
                st.selectEntity(null, false);
              }
            }
          }
        } else {
          missingSelectedSinceRef.current = null;
          if (st.selectedEntitySnapshot !== null) {
            st.setSelectedEntitySnapshot(null);
          }
        }
      }
    };

    rafId = window.requestAnimationFrame(stepKinematics);
    return () => {
      window.cancelAnimationFrame(rafId);
      tacticalAudio.dispose();
    };
  }, []);

  // 8. Control Handlers
  const handleLocateGps = useCallback(() => {
    autoLocateCancelRef.current?.();
    autoLocateCancelRef.current = null;
    reverseGeoAbortRef.current?.abort();
    const revController = new AbortController();
    reverseGeoAbortRef.current = revController;

    setGpsBusy(true);
    setGpsError(null);

    void requestBrowserGeolocation({
      highAccuracyTimeoutMs: 8000,
      coarseTimeoutMs: 8000,
      maximumAgeMs: 0,
    })
      .then((fix) => {
        if (revController.signal.aborted) return;
        setGpsBusy(false);
        const st = useSkyStore.getState();
        st.setObserver({
          lat: fix.lat,
          lon: fix.lon,
          altM: fix.altM,
          label: fix.label,
          source: 'gps',
        });
        st.setCommandPaletteOpen(false);

        void reverseGeocodeLabel(fix.lat, fix.lon, revController.signal).then((resolvedLabel) => {
          if (!revController.signal.aborted && resolvedLabel) {
            useSkyStore.getState().updateObserverLabel(fix.lat, fix.lon, 'gps', resolvedLabel);
          }
        });
      })
      .catch(async (err) => {
        if (revController.signal.aborted) return;
        const gpsMsg =
          err instanceof Error && err.message
            ? err.message
            : 'Unable to acquire browser GPS fix.';
        const stBefore = useSkyStore.getState();
        // If not already on an IP fix, fall back to IP geolocation so Locate Me still centers on current geographic area
        if (stBefore.observer.source !== 'ip') {
          const ipFix = await fetchIpGeolocation({ signal: revController.signal });
          if (revController.signal.aborted) return;
          if (ipFix) {
            setGpsBusy(false);
            setGpsError(null);
            const stNow = useSkyStore.getState();
            stNow.setObserver({
              lat: ipFix.lat,
              lon: ipFix.lon,
              altM: ipFix.altM,
              label: ipFix.label,
              source: 'ip',
            });
            stNow.setCommandPaletteOpen(false);
            return;
          }
        }

        setGpsBusy(false);
        setGpsError(gpsMsg);
        const stNow = useSkyStore.getState();
        if (stNow.observer.source === 'pending') {
          stNow.setLocationStatus(
            'unavailable',
            `${gpsMsg} Network IP geolocation was also unavailable.`
          );
        }
      });
  }, []);

  const handleRetryAutoLocate = useCallback(() => {
    setGpsError(null);
    startAutoLocate();
  }, [startAutoLocate]);

  const handleSearchLocation = useCallback(
    async (query: string): Promise<LocationSearchResult[]> => {
      const results = await searchLocation(query);
      return results.map((r) => ({
        lat: r.lat,
        lon: r.lon,
        label: r.label,
        subtitle: r.subtitle,
        altM: r.altM,
      }));
    },
    []
  );

  const handleManualSweep = useCallback(() => {
    void tacticalAudio.unlock();
    useSkyStore.getState().triggerManualSweep();
  }, []);

  const handleToggleAudio = useCallback((enabled: boolean) => {
    if (enabled) {
      void tacticalAudio.unlock().then(() => {
        tacticalAudio.playTargetLock();
      });
    }
  }, []);

  const handleInstallPwa = useCallback(async () => {
    const promptEvent = deferredInstallPromptRef.current;
    if (!promptEvent) {
      useSkyStore.getState().setPwaInstallState({ available: false });
      return;
    }
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      deferredInstallPromptRef.current = null;
      if (choice.outcome === 'accepted') {
        useSkyStore.getState().setPwaInstallState({ available: false, standalone: true });
      } else {
        useSkyStore.getState().setPwaInstallState({ available: false });
      }
    } catch {
      deferredInstallPromptRef.current = null;
      useSkyStore.getState().setPwaInstallState({ available: false });
    }
  }, []);

  const handleDismissPwa = useCallback(() => {
    try {
      window.sessionStorage?.setItem(PWA_DISMISS_STORAGE_KEY, '1');
    } catch {
      // Ignore restricted sessionStorage
    }
    useSkyStore.getState().setPwaInstallState({ dismissed: true });
  }, []);

  const showLocationGate = observer.source === 'pending' && !commandPaletteOpen;

  return (
    <div className="cockpit-shell">
      <TopTelemetryBar
        onToggleAudio={handleToggleAudio}
        onManualSweep={handleManualSweep}
        onLocateCurrent={handleLocateGps}
        gpsBusy={gpsBusy}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissPwa={handleDismissPwa}
      />

      <main
        className={`skymap-stage skymap-stage--${layout}`}
        data-layout={layout}
        data-pip={layout === 'map' && skyDomePip ? 'true' : 'false'}
        aria-label="Krunked Sky-Map Dual Situational Awareness Stage"
      >
        <section className="stage-map-pane" data-pane="map" aria-label="Tactical Airspace Map">
          <TacticalMap />
        </section>

        <section
          className="stage-dome-pane"
          data-pane="dome"
          aria-label="Polar Sky-Dome Hemisphere Radar"
        >
          <PolarSkyDome />
        </section>

        {showLocationGate && locationStatus === 'locating' && (
          <div
            className="location-gate-overlay"
            data-testid="location-status-overlay"
            role="status"
            aria-live="polite"
          >
            <div className="location-gate-card location-gate-card--locating">
              <div className="location-gate-card__head">
                <span className="location-gate-pulse" aria-hidden="true" />
                <span className="location-gate-card__kicker tabular">ACQUIRING YOUR LOCATION</span>
              </div>
              <p className="location-gate-card__desc">
                Detecting your current geographic position via browser geolocation…
              </p>
              <div className="location-gate-card__actions">
                <button
                  type="button"
                  className="location-gate-btn location-gate-btn--ghost"
                  onClick={() => useSkyStore.getState().setCommandPaletteOpen(true)}
                >
                  <Search size={12} aria-hidden="true" />
                  <span>Enter Manually (⌘K)</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {showLocationGate && locationStatus === 'unavailable' && (
          <div
            className="location-gate-overlay"
            data-testid="location-unavailable-overlay"
            role="alert"
          >
            <div className="location-gate-card location-gate-card--unavailable">
              <div className="location-gate-card__head">
                <Crosshair size={14} color="#F59E0B" aria-hidden="true" />
                <span className="location-gate-card__kicker tabular">
                  CURRENT LOCATION REQUIRED
                </span>
              </div>
              <p className="location-gate-card__desc">
                {locationError ||
                  'Unable to determine your current geographic location automatically.'}
              </p>
              <div className="location-gate-card__actions">
                <button
                  type="button"
                  className="location-gate-btn location-gate-btn--primary"
                  data-testid="location-retry-btn"
                  onClick={handleRetryAutoLocate}
                  disabled={gpsBusy}
                >
                  <Crosshair size={12} aria-hidden="true" />
                  <span>{gpsBusy ? 'Locating…' : 'Retry Auto-Locate'}</span>
                </button>
                <button
                  type="button"
                  className="location-gate-btn location-gate-btn--ghost"
                  data-testid="location-manual-btn"
                  onClick={() => useSkyStore.getState().setCommandPaletteOpen(true)}
                >
                  <Search size={12} aria-hidden="true" />
                  <span>Search City / Coords (⌘K)</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <ControlDock
          onLocateGps={handleLocateGps}
          onSearchLocation={handleSearchLocation}
          onManualSweep={handleManualSweep}
          gpsBusy={gpsBusy}
          gpsError={gpsError}
        />

        <TargetInspector />
      </main>

      <OpenDroneIdModal />
    </div>
  );
}
