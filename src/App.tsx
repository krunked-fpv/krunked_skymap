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
import { computeTopocentricLookAngles, extrapolateDeadReckoning } from './math/geodesy';
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
  const odidConfig = useSkyStore((s) => s.odidConfig);
  const airspace = useSkyStore((s) => s.airspace);
  const sweepPulseCounter = useSkyStore((s) => s.sweepPulseCounter);

  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  const astroClientRef = useRef<AstroClient | null>(null);
  const odidClientRef = useRef<OpenDroneIdClient | null>(null);
  const liveWebhookDronesRef = useRef<Map<string, DroneEntity>>(new Map());
  const simStartMsRef = useRef<number>(Date.now());
  const hydratedRef = useRef(false);
  const flightsInFlightRef = useRef(false);
  const balloonsInFlightRef = useRef(false);
  const airspaceInFlightRef = useRef(false);
  const zenithNotifiedRef = useRef<Set<string>>(new Set());
  const alertNotifiedRef = useRef<Set<string>>(new Set());
  const prevSelectedIdRef = useRef<string | null>(null);

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
                { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
              );
            }
          })
          .catch(() => {
            // Permissions API unsupported — keep default hub
          });
      }
    }
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

    // 10Hz Worker propagation tick
    const tickTimer = window.setInterval(() => {
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
    if (!selectedId || !selectedId.startsWith('sat:')) {
      liveKinematicsRegistry.orbitOverlay = null;
      return;
    }

    const noradId = Number.parseInt(selectedId.slice(4), 10);
    if (!Number.isFinite(noradId) || !client) {
      liveKinematicsRegistry.orbitOverlay = null;
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
  }, [selectedId, observer]);

  // 4. Data Feed Runners (Flights, Balloons, FAA Airspace)
  const runFlightsRefresh = useCallback(async (force = false) => {
    if (flightsInFlightRef.current) return;
    flightsInFlightRef.current = true;
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
        nextMap.set(f.id, f);
      }
      liveKinematicsRegistry.rawFlights = nextMap;
      useSkyStore.getState().setFeedState('flights', {
        status: res.status,
        provider: res.provider,
        lastUpdatedMs: res.timestampMs,
        nextRefreshSec: 10,
        count: res.entities.length,
        errorMsg: res.errorMsg,
      });
    } catch (err) {
      useSkyStore.getState().setFeedState('flights', {
        status: 'error',
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

  // Debounced immediate sweep when observer or radius changes
  useEffect(() => {
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

  // 1Hz Countdown Scheduler for all polling feeds
  useEffect(() => {
    const interval = window.setInterval(() => {
      const store = useSkyStore.getState();
      store.tickCountdowns();
      const feeds = useSkyStore.getState().feeds;
      if (feeds.flights.nextRefreshSec <= 0 && (store.layers.flight || store.layers.military)) {
        void runFlightsRefresh(false);
      }
      if (feeds.balloons.nextRefreshSec <= 0 && store.layers.balloon) {
        void runBalloonsRefresh();
      }
      if (feeds.airspace.nextRefreshSec <= 0 && store.layers.drone) {
        void runAirspaceRefresh();
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [runFlightsRefresh, runBalloonsRefresh, runAirspaceRefresh]);

  // 5. OpenDroneID Live Client & 1Hz Tactical Drone Simulator
  useEffect(() => {
    const client = new OpenDroneIdClient(observer, airspace, {
      onDrones: (drones) => {
        const nextMap = new Map<string, DroneEntity>();
        for (const d of drones) {
          nextMap.set(d.id, d);
        }
        liveWebhookDronesRef.current = nextMap;
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
        for (const [id, drone] of liveWebhookDronesRef.current.entries()) {
          const compliance = evaluateDroneAirspaceCompliance(
            drone.lat,
            drone.lon,
            drone.altAglM,
            st.airspace
          );
          combined.set(id, {
            ...drone,
            faaCeilingFt: compliance.faaCeilingFt,
            ceilingBreach: compliance.ceilingBreach,
            tfrBreach: compliance.tfrBreach,
          });
        }
      }

      liveKinematicsRegistry.rawDrones = combined;
      st.setFeedState('drones', {
        status: st.odidConfig.connected
          ? 'live'
          : st.odidConfig.simulatorEnabled
            ? 'fallback'
            : 'idle',
        provider: st.odidConfig.connected
          ? 'opendroneid-stream'
          : st.odidConfig.simulatorEnabled
            ? 'sim-opendroneid'
            : 'off',
        lastUpdatedMs: Date.now(),
        nextRefreshSec: 1,
        count: combined.size,
      });
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
          const ageMs = nowMs - raw.timestampMs;
          if (ageMs > pruneStaleMs) {
            sourceMap.delete(id);
            continue;
          }
          const dtSec = Math.max(0, Math.min(maxDtSec, ageMs / 1000));
          const isMoving =
            raw.category === 'flight' || raw.category === 'military'
              ? !raw.onGround && raw.speedMs > 1
              : raw.speedMs > 0.2;

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
            checkAcousticEvents(updated, true);
          }
        }
      };

      pushAtmospheric(liveKinematicsRegistry.rawFlights, 12, 120_000);
      pushAtmospheric(liveKinematicsRegistry.rawBalloons, 35, 300_000);
      pushAtmospheric(liveKinematicsRegistry.rawDrones, 3, 60_000);

      // Orbital satellites: smooth micro-interpolation between 10Hz SGP4 Worker frames
      for (const [id, sat] of liveKinematicsRegistry.satellites.entries()) {
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
          checkAcousticEvents(updated, true);
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

        if (st.selectedId) {
          const currentSelected = nextEntities.get(st.selectedId) ?? null;
          st.setSelectedEntitySnapshot(currentSelected ? { ...currentSelected } : null);
        } else if (st.selectedEntitySnapshot !== null) {
          st.setSelectedEntitySnapshot(null);
        }
      }
    };

    rafId = window.requestAnimationFrame(stepKinematics);
    return () => window.cancelAnimationFrame(rafId);
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
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
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

  return (
    <div className="cockpit-shell">
      <TopTelemetryBar onToggleAudio={handleToggleAudio} />

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
