import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type DroneEntity,
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
import { fetchFlightsCascade } from './services/flightsService';
import { loadInitialTles, refreshTlesIfStale } from './services/satellitesService';
import { fetchBalloons } from './services/balloonsService';
import { evaluateDroneAirspaceCompliance, fetchAirspace } from './services/airspaceService';
import { OpenDroneIdClient, stepSimulatedDrones } from './services/openDroneIdService';
import { searchLocation } from './services/geocodingService';
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

function parseUrlHashPatch(): UrlHydrationPatch | null {
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

  const selectedParam = params.get('selected');
  if (selectedParam) {
    patch.selectedId = selectedParam;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function buildUrlHashString(): string {
  const s = useSkyStore.getState();
  const params = new URLSearchParams();
  params.set('lat', s.observer.lat.toFixed(4));
  params.set('lon', s.observer.lon.toFixed(4));
  params.set('alt', String(Math.round(s.observer.altM)));
  params.set('label', s.observer.label);
  params.set('r', String(s.radiusKm));
  const activeLayers = ALL_CATEGORIES.filter((cat) => s.layers[cat]);
  params.set('layers', activeLayers.join(','));
  params.set('units', s.units);
  params.set('layout', s.layout);
  params.set('scope', s.orbitalScope);
  if (s.selectedId) {
    params.set('selected', s.selectedId);
  }
  return `#${params.toString()}`;
}

export default function App() {
  const observer = useSkyStore((s) => s.observer);
  const radiusKm = useSkyStore((s) => s.radiusKm);
  const layers = useSkyStore((s) => s.layers);
  const satGroups = useSkyStore((s) => s.satGroups);
  const fullConstellation = useSkyStore((s) => s.fullConstellation);
  const orbitalScope = useSkyStore((s) => s.orbitalScope);
  const units = useSkyStore((s) => s.units);
  const layout = useSkyStore((s) => s.layout);
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
  const simStartMsRef = useRef<number>(Date.now());
  const hydratedRef = useRef(false);
  const flightsInFlightRef = useRef(false);
  const balloonsInFlightRef = useRef(false);
  const airspaceInFlightRef = useRef(false);
  const lastFlightsAttemptMsRef = useRef<number>(0);
  const nextFlightsDueMsRef = useRef<number>(Date.now() + 10_000);
  const missingSelectedSinceRef = useRef<number | null>(null);
  const zenithNotifiedRef = useRef<Set<string>>(new Set());
  const alertNotifiedRef = useRef<Set<string>>(new Set());
  const prevSelectedIdRef = useRef<string | null>(null);
  const lastFetchedCoordsRef = useRef<{ lat: number; lon: number }>({
    lat: observer.lat,
    lon: observer.lon,
  });

  // 1. Hydrate from URL permalink immediately once & honor pre-granted geolocation non-blockingly
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const patch = parseUrlHashPatch();
      if (patch) {
        useSkyStore.getState().hydrateFromUrlState(patch);
      } else if (
        typeof navigator !== 'undefined' &&
        navigator.permissions?.query &&
        navigator.geolocation
      ) {
        navigator.permissions
          .query({ name: 'geolocation' })
          .then((status) => {
            if (status.state === 'granted') {
              navigator.geolocation.getCurrentPosition(
                (pos) => {
                  const st = useSkyStore.getState();
                  if (st.observer.source === 'default') {
                    st.setObserver({
                      lat: pos.coords.latitude,
                      lon: pos.coords.longitude,
                      altM: Number.isFinite(pos.coords.altitude ?? NaN)
                        ? (pos.coords.altitude as number)
                        : 12,
                      label: 'GPS Station',
                      source: 'gps',
                    });
                  }
                },
                () => {
                  // Stay on default aerospace hub silently
                },
                { enableHighAccuracy: true, timeout: 6000, maximumAge: 15_000 }
              );
            }
          })
          .catch(() => {
            // Permissions API unsupported — keep default hub
          });
      }
    }
  }, []);

  // Listen for manual URL hash edits cleanly across React StrictMode mounts
  useEffect(() => {
    const handleHashChange = () => {
      const nextPatch = parseUrlHashPatch();
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

  // 2. Debounced URL Hash Permalink Synchronization
  useEffect(() => {
    if (typeof window === 'undefined') return;
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
  }, [observer, radiusKm, layers, units, layout, orbitalScope, selectedId]);

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
        client.updateConfig({
          observer: st.observer,
          radiusKm: st.radiusKm,
          orbitalScope: st.orbitalScope,
          activeGroups: st.satGroups,
          fullConstellation: st.fullConstellation,
        });
        client.tick(Date.now());
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
      if (st.layers.satellite && st.workerReady) {
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
    if (!client) return;
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
    if (!selectedId || !selectedId.startsWith('sat-')) {
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
      if (st.selectedId === selectedId && st.workerReady) {
        void client.computeOrbit(noradId, Date.now(), st.observer);
      }
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [selectedId, observer, workerReady]);

  // 4. Data Feed Runners (Flights, Balloons, FAA Airspace)
  const runFlightsRefresh = useCallback(async (force = false) => {
    if (typeof document !== 'undefined' && document.hidden && !force) return;
    if (flightsInFlightRef.current) return;
    flightsInFlightRef.current = true;
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
        { force }
      );
      const nextMap = new Map<string, (typeof res.entities)[number]>();
      for (const f of res.entities) {
        if (!f.onGround) {
          nextMap.set(f.id, f);
        }
      }
      liveKinematicsRegistry.rawFlights = nextMap;
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
      });
    } catch (err) {
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
      flightsInFlightRef.current = false;
    }
  }, []);

  const runBalloonsRefresh = useCallback(async () => {
    if (balloonsInFlightRef.current) return;
    balloonsInFlightRef.current = true;
    const st = useSkyStore.getState();
    st.setFeedState('balloons', { status: 'loading' });

    try {
      const res = await fetchBalloons(
        st.observer,
        st.radiusKm,
        liveKinematicsRegistry.rawBalloons
      );
      const nextMap = new Map<string, (typeof res.entities)[number]>();
      for (const b of res.entities) {
        nextMap.set(b.id, b);
      }
      liveKinematicsRegistry.rawBalloons = nextMap;
      const store = useSkyStore.getState();
      store.setNearestSondeHint(res.nearestSondeHint);
      store.setFeedState('balloons', {
        status: res.status,
        provider: res.provider,
        lastUpdatedMs: res.timestampMs,
        nextRefreshSec: 30,
        count: res.entities.length,
        errorMsg: res.errorMsg,
      });
    } catch (err) {
      useSkyStore.getState().setFeedState('balloons', {
        status: 'error',
        nextRefreshSec: 30,
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      balloonsInFlightRef.current = false;
    }
  }, []);

  const runAirspaceRefresh = useCallback(async () => {
    if (airspaceInFlightRef.current) return;
    airspaceInFlightRef.current = true;
    const st = useSkyStore.getState();
    st.setFeedState('airspace', { status: 'loading' });

    try {
      const res = await fetchAirspace(st.observer, st.radiusKm);
      const store = useSkyStore.getState();
      store.setAirspace(res.airspace);
      store.setFeedState('airspace', {
        status: res.status,
        provider: res.provider,
        lastUpdatedMs: res.timestampMs,
        nextRefreshSec: 300,
        count: res.airspace.uasfm.features.length + res.airspace.sua.features.length,
        errorMsg: res.errorMsg,
      });
    } catch (err) {
      useSkyStore.getState().setFeedState('airspace', {
        status: 'error',
        nextRefreshSec: 300,
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    } finally {
      airspaceInFlightRef.current = false;
    }
  }, []);

  // Refresh feeds on observer/radius change (purging distant targets immediately on >50km jumps)
  useEffect(() => {
    const jumpKm = haversineDistanceKm(
      lastFetchedCoordsRef.current.lat,
      lastFetchedCoordsRef.current.lon,
      observer.lat,
      observer.lon
    );
    lastFetchedCoordsRef.current = { lat: observer.lat, lon: observer.lon };

    if (jumpKm > 50) {
      liveKinematicsRegistry.rawFlights.clear();
      liveKinematicsRegistry.rawBalloons.clear();
      liveKinematicsRegistry.rawDrones.clear();
      liveKinematicsRegistry.version += 1;
      useSkyStore.getState().setFeedState('flights', {
        lastUpdatedMs: null,
        lastCheckedMs: null,
        httpStatus: undefined,
        provider: 'adsb-cascade',
        count: 0,
        errorMsg: undefined,
      });
      void runFlightsRefresh(true);
      void runBalloonsRefresh();
      void runAirspaceRefresh();
      return undefined;
    }

    const timer = window.setTimeout(() => {
      void runFlightsRefresh(true);
      void runBalloonsRefresh();
      void runAirspaceRefresh();
    }, 280);
    return () => window.clearTimeout(timer);
  }, [observer.lat, observer.lon, radiusKm, runFlightsRefresh, runBalloonsRefresh, runAirspaceRefresh]);

  // Manual Sweep trigger
  useEffect(() => {
    if (sweepPulseCounter === 0) return;
    tacticalAudio.playSweepPulse();
    void runFlightsRefresh(true);
    void runBalloonsRefresh();
    void runAirspaceRefresh();
    if (astroClientRef.current && useSkyStore.getState().workerReady) {
      astroClientRef.current.tick(Date.now());
    }
  }, [sweepPulseCounter, runFlightsRefresh, runBalloonsRefresh, runAirspaceRefresh]);

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
        (store.layers.flight || store.layers.military)
      ) {
        const shouldForce = nowMs - lastFlightsAttemptMsRef.current >= 9_800;
        void runFlightsRefresh(shouldForce);
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
        liveKinematicsRegistry.version += 1;
        useSkyStore.getState().setFeedState('flights', {
          status: 'offline',
          lastCheckedMs: nowMs,
          count: 0,
          errorMsg: 'Network connection offline',
        });
      }
    };

    const handleOnline = () => {
      const st = useSkyStore.getState();
      if (st.layers.flight || st.layers.military) {
        void runFlightsRefresh(true);
      }
      if (st.layers.balloon) {
        void runBalloonsRefresh();
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
  }, [runFlightsRefresh, runBalloonsRefresh, runAirspaceRefresh]);

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
      const combined = new Map<string, DroneEntity>();

      if (st.odidConfig.simulatorEnabled) {
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
            faaCeilingFt: compliance.faaCeilingFt,
            ceilingBreach: compliance.ceilingBreach,
            tfrBreach: compliance.tfrBreach,
            emergencyFlag,
          });
        }
      }

      const droneActive = st.odidConfig.connected || st.odidConfig.simulatorEnabled;
      const nextStatus = st.odidConfig.connected
        ? 'live'
        : st.odidConfig.simulatorEnabled
          ? 'fallback'
          : 'idle';
      const nextProvider = st.odidConfig.connected
        ? 'opendroneid-stream'
        : st.odidConfig.simulatorEnabled
          ? 'sim-opendroneid'
          : 'off';

      liveKinematicsRegistry.rawDrones = combined;
      if (
        droneActive ||
        st.feeds.drones.status !== nextStatus ||
        st.feeds.drones.provider !== nextProvider ||
        st.feeds.drones.count !== combined.size
      ) {
        st.setFeedState('drones', {
          status: nextStatus,
          provider: nextProvider,
          lastUpdatedMs: droneActive ? Date.now() : null,
          nextRefreshSec: 1,
          count: combined.size,
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
      const nextEntities = new Map<string, SkyEntity>();

      const counts = {
        flight: 0,
        military: 0,
        satellite: 0,
        balloon: 0,
        drone: 0,
        overhead: 0,
        total: 0,
      };

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

      // Atmospheric feeds: dead-reckoning interpolation at 60fps + real-time WGS-84 look angles
      const pushAtmospheric = <T extends SkyEntity>(
        sourceMap: Map<string, T>,
        maxDtSec: number,
        pruneStaleMs: number
      ) => {
        for (const [id, raw] of sourceMap.entries()) {
          if ((raw.category === 'flight' || raw.category === 'military') && raw.onGround) {
            sourceMap.delete(id);
            continue;
          }

          const ageMs = nowMs - raw.timestampMs;
          if (ageMs > pruneStaleMs || ageMs < -60_000) {
            sourceMap.delete(id);
            continue;
          }

          const dtSec = Math.max(0, Math.min(maxDtSec, ageMs / 1000));
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

          if (
            (raw.category === 'flight' || raw.category === 'military' || raw.category === 'balloon') &&
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
          nextEntities.set(id, updated);

          if (st.layers[updated.category]) {
            counts[updated.category] += 1;
            counts.total += 1;
            if (topocentric.elevationDeg >= 30) counts.overhead += 1;
            checkAcousticEvents(updated, st.audioEnabled);
          }
        }
      };

      pushAtmospheric(liveKinematicsRegistry.rawFlights, 12, 60_000);
      pushAtmospheric(liveKinematicsRegistry.rawBalloons, 35, 21_600_000);
      pushAtmospheric(liveKinematicsRegistry.rawDrones, 3, 60_000);

      // Orbital satellites: smooth micro-interpolation between 10Hz SGP4 Worker frames
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

        if (st.layers.satellite) {
          counts.satellite += 1;
          counts.total += 1;
          if (topocentric.elevationDeg >= 30) counts.overhead += 1;
          checkAcousticEvents(updated, st.audioEnabled);
        }
      }

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
          prevCounts.total !== counts.total
        ) {
          st.setCounts(counts);
        }

        if (st.feeds.flights.count !== liveKinematicsRegistry.rawFlights.size) {
          st.setFeedState('flights', { count: liveKinematicsRegistry.rawFlights.size });
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
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsError('Geolocation API is unavailable in this browser.');
      return;
    }
    setGpsBusy(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsBusy(false);
        const alt =
          typeof pos.coords.altitude === 'number' && Number.isFinite(pos.coords.altitude)
            ? pos.coords.altitude
            : 12;
        useSkyStore.getState().setObserver({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          altM: alt,
          label: 'GPS Station',
          source: 'gps',
        });
      },
      (err) => {
        setGpsBusy(false);
        setGpsError(err.message || 'Unable to acquire GPS fix.');
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 }
    );
  }, []);

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

  return (
    <div className="cockpit-shell">
      <TopTelemetryBar
        onToggleAudio={handleToggleAudio}
        onInstallPwa={() => void handleInstallPwa()}
        onDismissPwa={handleDismissPwa}
      />

      <main
        className={`skymap-stage skymap-stage--${layout}`}
        data-layout={layout}
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
