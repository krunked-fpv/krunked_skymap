import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { greatCircleDestination } from '../../src/math/geodesy';
import {
  computeDisplayedSkyCounts,
  isEntityWithinDisplayCountScope,
  liveKinematicsRegistry,
  useSkyStore,
  type DisplayCountContext,
} from '../../src/store/useSkyStore';
import { clearBrowserCachesAndReload } from '../../src/components/hud/TopTelemetryBar';
import controlDockSourceRaw from '../../src/components/hud/ControlDock.tsx?raw';
import topTelemetryBarSourceRaw from '../../src/components/hud/TopTelemetryBar.tsx?raw';
import appSourceRaw from '../../src/App.tsx?raw';
import type {
  BalloonEntity,
  DroneEntity,
  FlightEntity,
  ObserverLocation,
  SatelliteEntity,
  SkyEntity,
} from '../../src/types/sky-contracts';

const OBSERVER: ObserverLocation = {
  lat: 38.8512,
  lon: -77.0402,
  altM: 12,
  label: 'DC / Potomac Corridor',
  source: 'preset',
};

function makeContext(overrides: Partial<DisplayCountContext> = {}): DisplayCountContext {
  return {
    observer: OBSERVER,
    radiusKm: 120,
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
      simOdid: true,
    },
    ...overrides,
  };
}

function makeFlight(
  id: string,
  category: 'flight' | 'military',
  groundDistKm: number,
  options: {
    elevationDeg?: number;
    useNanGroundDist?: boolean;
  } = {}
): FlightEntity {
  const pos = greatCircleDestination(OBSERVER.lat, OBSERVER.lon, 45, groundDistKm);
  return {
    id,
    category,
    callsign: id.toUpperCase(),
    subtitle: category === 'military' ? 'MIL · C17' : 'CIVIL · B738',
    country: 'US',
    lat: pos.lat,
    lon: pos.lon,
    altM: 10_000,
    speedMs: 240,
    headingDeg: 90,
    vertRateMs: 0,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 45,
      elevationDeg: options.elevationDeg ?? 12,
      slantRangeKm: Math.hypot(groundDistKm, 10),
      groundDistKm: options.useNanGroundDist ? Number.NaN : groundDistKm,
      belowHorizon: false,
    },
    trail: [],
    icaoHex: id.slice(-6),
    onGround: false,
    isMilitary: category === 'military',
    airframeClass: category === 'military' ? 'fast-mil' : 'jet',
  };
}

function makeSatellite(
  id: string,
  groundDistKm: number,
  options: {
    group?: SatelliteEntity['group'];
    elevationDeg?: number;
    useNanGroundDist?: boolean;
  } = {}
): SatelliteEntity {
  const pos = greatCircleDestination(OBSERVER.lat, OBSERVER.lon, 135, groundDistKm);
  return {
    id,
    category: 'satellite',
    callsign: id.toUpperCase(),
    subtitle: 'NORAD 25544 · STATIONS',
    country: 'ORBITAL',
    lat: pos.lat,
    lon: pos.lon,
    altM: 420_000,
    speedMs: 7660,
    headingDeg: 51,
    vertRateMs: 0,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 135,
      elevationDeg: options.elevationDeg ?? 35,
      slantRangeKm: Math.hypot(groundDistKm, 420),
      groundDistKm: options.useNanGroundDist ? Number.NaN : groundDistKm,
      belowHorizon: false,
    },
    trail: [],
    noradId: 25544,
    group: options.group ?? 'stations',
    inclinationDeg: 51.6,
    periodMin: 92.9,
    apogeeKm: 422,
    perigeeKm: 418,
    sunlit: true,
    radialVelocityKmS: 0.4,
    dopplerHz437MHz: -600,
  };
}

function makeBalloon(
  id: string,
  groundDistKm: number,
  options: {
    subSource?: BalloonEntity['subSource'];
    elevationDeg?: number;
    useNanGroundDist?: boolean;
  } = {}
): BalloonEntity {
  const pos = greatCircleDestination(OBSERVER.lat, OBSERVER.lon, 225, groundDistKm);
  return {
    id,
    category: 'balloon',
    callsign: id.toUpperCase(),
    subtitle: 'STRATOSPHERIC SONDE',
    country: 'GLOBAL',
    lat: pos.lat,
    lon: pos.lon,
    altM: 22_000,
    speedMs: 18,
    headingDeg: 85,
    vertRateMs: 4,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 225,
      elevationDeg: options.elevationDeg ?? 18,
      slantRangeKm: Math.hypot(groundDistKm, 22),
      groundDistKm: options.useNanGroundDist ? Number.NaN : groundDistKm,
      belowHorizon: false,
    },
    trail: [],
    serial: id,
    sondeType: 'RS41',
    subSource: options.subSource ?? 'sondehub',
    burstState: 'ascending',
  };
}

function makeDrone(
  id: string,
  groundDistKm: number,
  options: {
    subSource?: DroneEntity['subSource'];
    isSimulated?: boolean;
    elevationDeg?: number;
  } = {}
): DroneEntity {
  const pos = greatCircleDestination(OBSERVER.lat, OBSERVER.lon, 315, groundDistKm);
  return {
    id,
    category: 'drone',
    callsign: id.toUpperCase(),
    subtitle: 'LIVE ATC UAS',
    country: 'US',
    lat: pos.lat,
    lon: pos.lon,
    altM: 120,
    speedMs: 15,
    headingDeg: 180,
    vertRateMs: 0,
    timestampMs: Date.now(),
    topocentric: {
      azimuthDeg: 315,
      elevationDeg: options.elevationDeg ?? 4,
      slantRangeKm: groundDistKm,
      groundDistKm,
      belowHorizon: groundDistKm > 50,
    },
    trail: [],
    isSimulated: options.isSimulated,
    uasId: id,
    uaType: 'fixed-wing',
    subSource: options.subSource ?? 'adsb-uas',
    altAglM: 100,
    operatorLat: pos.lat,
    operatorLon: pos.lon,
    operatorDistM: 0,
    missionDesc: 'LIVE ATC UAS',
    faaCeilingFt: 400,
    ceilingBreach: false,
    tfrBreach: false,
  };
}

function resetRegistryAndStore() {
  liveKinematicsRegistry.entities = new Map<string, SkyEntity>();
  liveKinematicsRegistry.rawFlights.clear();
  liveKinematicsRegistry.rawGlobalFlights.clear();
  liveKinematicsRegistry.rawBalloons.clear();
  liveKinematicsRegistry.rawAdsbBalloons.clear();
  liveKinematicsRegistry.rawDrones.clear();
  liveKinematicsRegistry.rawAdsbDrones.clear();
  liveKinematicsRegistry.satellites.clear();
  liveKinematicsRegistry.orbitOverlay = null;

  useSkyStore.setState({
    observer: OBSERVER,
    locationStatus: 'ready',
    radiusKm: 120,
    atmosphericScope: 'global',
    orbitalScope: 'hemisphere',
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
      simOdid: true,
    },
    counts: {
      flight: 0,
      military: 0,
      satellite: 0,
      balloon: 0,
      drone: 0,
      overhead: 0,
      overheadConeDeg: 45,
      total: 0,
    },
  });
}

describe('Radius-scoped HUD counts (with global UAS)', () => {
  beforeEach(() => {
    resetRegistryAndStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('strictly scopes Flights, Military, Orbital, and Balloons to groundDistKm <= radiusKm (including exact boundary) while keeping out-of-range entities in the live map', () => {
    const entities = new Map<string, SkyEntity>();
    // Flights: inside (50 km), exact boundary (120 km), outside (120.01 km)
    const fIn = makeFlight('f-in', 'flight', 50);
    const fBoundary = makeFlight('f-edge', 'flight', 120);
    const fOut = makeFlight('f-out', 'flight', 120.01);

    // Military: inside (80 km), exact boundary (120 km), global outside (1500 km)
    const mIn = makeFlight('m-in', 'military', 80);
    const mBoundary = makeFlight('m-edge', 'military', 120);
    const mGlobalOut = makeFlight('m-far', 'military', 1500);

    // Satellites: inside (40 km), exact boundary (120 km), horizon outside (950 km)
    const sIn = makeSatellite('sat-in', 40);
    const sBoundary = makeSatellite('sat-edge', 120);
    const sOut = makeSatellite('sat-far', 950);

    // Balloons: inside (65 km), exact boundary (120 km), global WindBorne outside (2400 km)
    const bIn = makeBalloon('b-in', 65, { subSource: 'sondehub' });
    const bBoundary = makeBalloon('b-edge', 120, { subSource: 'adsb-lta' });
    const bGlobalOut = makeBalloon('b-far', 2400, { subSource: 'windborne' });

    for (const e of [
      fIn,
      fBoundary,
      fOut,
      mIn,
      mBoundary,
      mGlobalOut,
      sIn,
      sBoundary,
      sOut,
      bIn,
      bBoundary,
      bGlobalOut,
    ]) {
      entities.set(e.id, e);
    }

    liveKinematicsRegistry.entities = entities;
    const counts = computeDisplayedSkyCounts(liveKinematicsRegistry.entities.values(), makeContext({ radiusKm: 120 }));

    expect(counts.flight).toBe(2);
    expect(counts.military).toBe(2);
    expect(counts.satellite).toBe(2);
    expect(counts.balloon).toBe(2);
    expect(counts.drone).toBe(0);
    expect(counts.total).toBe(
      counts.flight + counts.military + counts.satellite + counts.balloon + counts.drone
    );
    expect(counts.total).toBe(8);

    // Out-of-radius global entities remain untouched in the live entity map for map/dome rendering
    expect(liveKinematicsRegistry.entities.size).toBe(12);
    expect(liveKinematicsRegistry.entities.has('m-far')).toBe(true);
    expect(liveKinematicsRegistry.entities.has('sat-far')).toBe(true);
    expect(liveKinematicsRegistry.entities.has('b-far')).toBe(true);
  });

  it('keeps UAS (drone) count GLOBAL across 500 km and 5,000 km distances regardless of radiusKm', () => {
    const dLocal = makeDrone('uas-local', 15, { subSource: 'odid-live' });
    const d500 = makeDrone('uas-500', 500, { subSource: 'adsb-uas' });
    const d5000 = makeDrone('uas-5000', 5000, { subSource: 'adsb-uas' });
    const m500 = makeFlight('mil-500', 'military', 500);
    const s500 = makeSatellite('sat-500', 500);
    const b500 = makeBalloon('bal-500', 500, { subSource: 'windborne' });

    const all: SkyEntity[] = [dLocal, d500, d5000, m500, s500, b500];

    expect(isEntityWithinDisplayCountScope(d500, OBSERVER, 10)).toBe(true);
    expect(isEntityWithinDisplayCountScope(d5000, OBSERVER, 10)).toBe(true);
    expect(isEntityWithinDisplayCountScope(m500, OBSERVER, 120)).toBe(false);
    expect(isEntityWithinDisplayCountScope(s500, OBSERVER, 120)).toBe(false);
    expect(isEntityWithinDisplayCountScope(b500, OBSERVER, 120)).toBe(false);

    const counts = computeDisplayedSkyCounts(all, makeContext({ radiusKm: 50 }));
    expect(counts.drone).toBe(3);
    expect(counts.military).toBe(0);
    expect(counts.satellite).toBe(0);
    expect(counts.balloon).toBe(0);
    expect(counts.flight).toBe(0);
    expect(counts.total).toBe(3);
  });

  it('falls back to haversineDistanceKm when entity.topocentric.groundDistKm is non-finite', () => {
    const milNearNan = makeFlight('mil-nan-near', 'military', 60, { useNanGroundDist: true });
    const milFarNan = makeFlight('mil-nan-far', 'military', 220, { useNanGroundDist: true });
    const satNearNan = makeSatellite('sat-nan-near', 95, { useNanGroundDist: true });
    const balFarNan = makeBalloon('bal-nan-far', 400, { useNanGroundDist: true });

    expect(isEntityWithinDisplayCountScope(milNearNan, OBSERVER, 120)).toBe(true);
    expect(isEntityWithinDisplayCountScope(milFarNan, OBSERVER, 120)).toBe(false);
    expect(isEntityWithinDisplayCountScope(satNearNan, OBSERVER, 120)).toBe(true);
    expect(isEntityWithinDisplayCountScope(balFarNan, OBSERVER, 120)).toBe(false);

    const counts = computeDisplayedSkyCounts(
      [milNearNan, milFarNan, satNearNan, balFarNan],
      makeContext({ radiusKm: 120 })
    );
    expect(counts.military).toBe(1);
    expect(counts.satellite).toBe(1);
    expect(counts.balloon).toBe(0);
    expect(counts.total).toBe(2);
  });

  it('updates military, orbital, balloon, and flight counts immediately when radiusKm changes while preserving global UAS count and global map entities', () => {
    const entities = new Map<string, SkyEntity>([
      ['f-40', makeFlight('f-40', 'flight', 40)],
      ['f-150', makeFlight('f-150', 'flight', 150)],
      ['m-30', makeFlight('m-30', 'military', 30)],
      ['m-110', makeFlight('m-110', 'military', 110)],
      ['m-220', makeFlight('m-220', 'military', 220)],
      ['m-1200', makeFlight('m-1200', 'military', 1200)],
      ['s-45', makeSatellite('s-45', 45)],
      ['s-140', makeSatellite('s-140', 140)],
      ['s-600', makeSatellite('s-600', 600)],
      ['b-50', makeBalloon('b-50', 50)],
      ['b-180', makeBalloon('b-180', 180, { subSource: 'windborne' })],
      ['d-500', makeDrone('d-500', 500, { subSource: 'adsb-uas' })],
      ['d-5000', makeDrone('d-5000', 5000, { subSource: 'adsb-uas' })],
    ]);
    liveKinematicsRegistry.entities = entities;

    // Narrow to 50 km
    useSkyStore.getState().setRadiusKm(50);
    let counts = useSkyStore.getState().counts;
    expect(counts.flight).toBe(1);
    expect(counts.military).toBe(1);
    expect(counts.satellite).toBe(1);
    expect(counts.balloon).toBe(1);
    expect(counts.drone).toBe(2);
    expect(counts.total).toBe(6);

    // Expand to 150 km
    useSkyStore.getState().setRadiusKm(150);
    counts = useSkyStore.getState().counts;
    expect(counts.flight).toBe(2);
    expect(counts.military).toBe(2);
    expect(counts.satellite).toBe(2);
    expect(counts.balloon).toBe(1);
    expect(counts.drone).toBe(2);
    expect(counts.total).toBe(9);

    // Expand to 250 km
    useSkyStore.getState().setRadiusKm(250);
    counts = useSkyStore.getState().counts;
    expect(counts.flight).toBe(2);
    expect(counts.military).toBe(3);
    expect(counts.satellite).toBe(2);
    expect(counts.balloon).toBe(2);
    expect(counts.drone).toBe(2);
    expect(counts.total).toBe(11);

    // Global entities remain in liveKinematicsRegistry.entities untouched
    expect(liveKinematicsRegistry.entities.size).toBe(13);
    expect(liveKinematicsRegistry.entities.has('m-1200')).toBe(true);
    expect(liveKinematicsRegistry.entities.has('s-600')).toBe(true);
  });

  it('excludes disabled top-level layers and disabled sublayers cleanly from counts and total', () => {
    const entities: SkyEntity[] = [
      makeFlight('f-1', 'flight', 30),
      makeFlight('m-1', 'military', 30),
      makeSatellite('s-station', 30, { group: 'stations' }),
      makeSatellite('s-starlink', 30, { group: 'starlink' }),
      makeBalloon('b-wb', 30, { subSource: 'windborne' }),
      makeBalloon('b-sh', 30, { subSource: 'sondehub' }),
      makeBalloon('b-lta', 30, { subSource: 'adsb-lta' }),
      makeDrone('d-live', 800, { subSource: 'adsb-uas' }),
      makeDrone('d-sim', 12, { subSource: 'odid-sim', isSimulated: true }),
    ];

    // Disable specific sublayers
    const sublayerCounts = computeDisplayedSkyCounts(
      entities,
      makeContext({
        radiusKm: 120,
        satGroups: { stations: true, visual: true, starlink: false },
        balloonSublayers: { windborne: false, sondehub: true, adsbLta: false },
        droneSublayers: { liveUas: true, airspace: true, simOdid: false },
      })
    );
    expect(sublayerCounts.flight).toBe(1);
    expect(sublayerCounts.military).toBe(1);
    expect(sublayerCounts.satellite).toBe(1);
    expect(sublayerCounts.balloon).toBe(1);
    expect(sublayerCounts.drone).toBe(1);
    expect(sublayerCounts.total).toBe(5);

    // Disable top-level military, balloon, and drone layers
    const layerOffCounts = computeDisplayedSkyCounts(
      entities,
      makeContext({
        radiusKm: 120,
        layers: {
          flight: true,
          military: false,
          satellite: true,
          balloon: false,
          drone: false,
        },
      })
    );
    expect(layerOffCounts.flight).toBe(1);
    expect(layerOffCounts.military).toBe(0);
    expect(layerOffCounts.satellite).toBe(2);
    expect(layerOffCounts.balloon).toBe(0);
    expect(layerOffCounts.drone).toBe(0);
    expect(layerOffCounts.total).toBe(3);

    // Store toggleLayer immediately updates counts synchronously
    liveKinematicsRegistry.entities = new Map(entities.map((e) => [e.id, e]));
    useSkyStore.getState().setRadiusKm(120);
    expect(useSkyStore.getState().counts.total).toBe(9);
    useSkyStore.getState().toggleLayer('military');
    expect(useSkyStore.getState().counts.military).toBe(0);
    expect(useSkyStore.getState().counts.total).toBe(8);
  });

  it('never double-counts or produces negative counts when a local flight is upgraded to military inside or outside radiusKm', () => {
    const insideEntities = new Map<string, SkyEntity>([
      ['ac-inside', makeFlight('ac-inside', 'flight', 60)],
      ['ac-outside', makeFlight('ac-outside', 'flight', 122)],
    ]);

    const beforeUpgrade = computeDisplayedSkyCounts(
      insideEntities.values(),
      makeContext({ radiusKm: 120 })
    );
    expect(beforeUpgrade.flight).toBe(1);
    expect(beforeUpgrade.military).toBe(0);
    expect(beforeUpgrade.total).toBe(1);

    // Upgrade both in-place (mirrors App.tsx pushExtrapolatedEntity category promotion)
    insideEntities.set('ac-inside', {
      ...(insideEntities.get('ac-inside') as FlightEntity),
      category: 'military',
      isMilitary: true,
    });
    insideEntities.set('ac-outside', {
      ...(insideEntities.get('ac-outside') as FlightEntity),
      category: 'military',
      isMilitary: true,
    });

    const afterUpgrade = computeDisplayedSkyCounts(
      insideEntities.values(),
      makeContext({ radiusKm: 120 })
    );
    expect(afterUpgrade.flight).toBe(0);
    expect(afterUpgrade.military).toBe(1);
    expect(afterUpgrade.total).toBe(1);

    // If military layer is disabled after promotion, counts cleanly drop to 0 without going negative
    const milDisabled = computeDisplayedSkyCounts(
      insideEntities.values(),
      makeContext({
        radiusKm: 120,
        layers: {
          flight: true,
          military: false,
          satellite: true,
          balloon: true,
          drone: true,
        },
      })
    );
    expect(milDisabled.flight).toBe(0);
    expect(milDisabled.military).toBe(0);
    expect(milDisabled.total).toBe(0);
  });
});

describe('HUD tooltips & Tesla wake/cache-reload recovery wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clearBrowserCachesAndReload unregisters service workers, clears Cache Storage, and performs a cache-busted location.replace preserving hash', async () => {
    const unregisterA = vi.fn().mockResolvedValue(true);
    const unregisterB = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi
      .fn()
      .mockResolvedValue([{ unregister: unregisterA }, { unregister: unregisterB }]);

    const cacheDelete = vi.fn().mockResolvedValue(true);
    const cacheKeys = vi.fn().mockResolvedValue(['krunked-v5', 'tiles-cache']);
    const replaceSpy = vi.fn();
    const reloadSpy = vi.fn();

    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations },
    });
    vi.stubGlobal('window', {
      caches: { keys: cacheKeys, delete: cacheDelete },
      location: {
        href: 'https://example.com/skymap/?foo=bar#r=120&layout=split',
        replace: replaceSpy,
        reload: reloadSpy,
      },
    });

    await clearBrowserCachesAndReload();

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregisterA).toHaveBeenCalledTimes(1);
    expect(unregisterB).toHaveBeenCalledTimes(1);
    expect(cacheKeys).toHaveBeenCalledTimes(1);
    expect(cacheDelete).toHaveBeenCalledWith('krunked-v5');
    expect(cacheDelete).toHaveBeenCalledWith('tiles-cache');
    expect(replaceSpy).toHaveBeenCalledTimes(1);

    const replacedUrl = new URL(replaceSpy.mock.calls[0][0] as string);
    expect(replacedUrl.pathname).toBe('/skymap/');
    expect(replacedUrl.searchParams.get('foo')).toBe('bar');
    expect(replacedUrl.searchParams.get('_cb')).toMatch(/^\d+$/);
    expect(replacedUrl.hash).toBe('#r=120&layout=split');
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it('clearBrowserCachesAndReload falls back cleanly to location.reload when SW/caches reject or href is opaque', async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn().mockRejectedValue(new Error('SW blocked')),
      },
    });
    vi.stubGlobal('window', {
      caches: {
        keys: vi.fn().mockRejectedValue(new Error('CacheStorage blocked')),
        delete: vi.fn(),
      },
      location: {
        href: 'not-a-valid-url',
        replace: vi.fn(),
        reload: reloadSpy,
      },
    });

    await expect(clearBrowserCachesAndReload()).resolves.toBeUndefined();
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it('wires radius-scoped chip titles, Clear Cache & Reload action, and pageshow/focus wake recovery', () => {
    expect(controlDockSourceRaw).toContain("category === 'drone' ? 'global' : `within ${radiusKm} km`");
    expect(topTelemetryBarSourceRaw).toContain('Clear Cache & Reload');
    expect(topTelemetryBarSourceRaw).toContain('data-testid="diag-clear-cache-reload"');
    expect(appSourceRaw).toContain("window.addEventListener('pageshow', handlePageShow)");
    expect(appSourceRaw).toContain("window.addEventListener('focus', handleWindowFocus)");
    expect(appSourceRaw).toContain('event.persisted');
    expect(appSourceRaw).toContain('clearStaleInFlightLocks');
  });
});
