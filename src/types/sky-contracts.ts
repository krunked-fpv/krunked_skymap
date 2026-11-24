export type SkyCategory = 'flight' | 'military' | 'satellite' | 'balloon' | 'drone';

export type FeedKey = 'flights' | 'military' | 'satellites' | 'balloons' | 'airspace' | 'drones';

export type FeedHealthStatus =
  | 'idle'
  | 'loading'
  | 'live'
  | 'delayed'
  | 'rate-limited'
  | 'offline'
  | 'cached'
  | 'fallback'
  | 'error';

export type UnitSystem = 'aviation' | 'metric';

export type LayoutMode = 'split' | 'map' | 'dome';

export type OrbitalScope = 'cylinder' | 'hemisphere';

export type AtmosphericScope = 'local' | 'global';

export type SkyDomeZoomMode = 'hemisphere' | 'zenith';

export type TwilightState = 'day' | 'civil-twilight' | 'nautical-twilight' | 'night';

export interface CelestialBodyPosition {
  azimuthDeg: number;
  elevationDeg: number;
}

export interface LunarPosition extends CelestialBodyPosition {
  phaseFraction: number;
  illuminationFraction: number;
}

export interface CelestialPositions {
  sun: CelestialBodyPosition;
  moon: LunarPosition;
  twilightState: TwilightState;
}

export interface ClosestApproachPrediction {
  isApproaching: boolean;
  tcaSeconds: number;
  peakElevationDeg: number;
  minSlantRangeKm: number;
  peakAzimuthDeg: number;
}

export interface SkyDomeProjectionPoint {
  x: number;
  y: number;
  r: number;
  normR: number;
  visible: boolean;
}

export interface SkyDomeUnprojectionResult {
  azimuthDeg: number;
  elevationDeg: number;
  inBounds: boolean;
}

export type SatelliteGroup = 'stations' | 'visual' | 'starlink';

export type BalloonSubSource = 'windborne' | 'sondehub' | 'sondehub-amateur' | 'adsb-lta';

export type DroneSubSource = 'adsb-uas' | 'odid-live' | 'odid-sim';

export type AdsbSourceFeed = 'point' | 'mil' | 'ladd' | 'pia' | 'opensky';

export interface BalloonSublayerState {
  windborne: boolean;
  sondehub: boolean;
  adsbLta: boolean;
}

export interface DroneSublayerState {
  liveUas: boolean;
  airspace: boolean;
  simOdid: boolean;
}

export const CATEGORY_COLORS: Record<SkyCategory, string> = {
  flight: '#22D3EE',
  military: '#F59E0B',
  satellite: '#C084FC',
  balloon: '#34D399',
  drone: '#A3E635',
};

export const EMERGENCY_COLOR = '#EF4444';
export const BREACH_COLOR = '#FB7185';
export const SATELLITE_SUNLIT_COLOR = '#E879F9';
export const SATELLITE_ECLIPSED_COLOR = '#7E22CE';

export const CATEGORY_LABELS: Record<SkyCategory, string> = {
  flight: 'Civil Flights',
  military: 'Military / Uncensored',
  satellite: 'Active Satellites',
  balloon: 'Weather Balloons',
  drone: 'UAS / Drone Airspace',
};

export type ObserverLocationStatus = 'locating' | 'ready' | 'unavailable';

export interface ObserverLocation {
  lat: number;
  lon: number;
  altM: number;
  label: string;
  source: 'pending' | 'gps' | 'ip' | 'search' | 'manual' | 'preset' | 'url';
}

export interface AerospacePreset {
  id: string;
  name: string;
  subtitle: string;
  lat: number;
  lon: number;
  altM: number;
  defaultRadiusKm: number;
}

export const AEROSPACE_PRESETS: AerospacePreset[] = [
  {
    id: 'dca-potomac',
    name: 'DC / Potomac Corridor',
    subtitle: 'KDCA · KIAD · SFRA/FRZ · High Density',
    lat: 38.8512,
    lon: -77.0402,
    altM: 12,
    defaultRadiusKm: 120,
  },
  {
    id: 'lax-edwards',
    name: 'LAX / Edwards Flight Test',
    subtitle: 'KLAX · KEDW · SoCal Basin & Mojave',
    lat: 34.0522,
    lon: -118.2437,
    altM: 89,
    defaultRadiusKm: 160,
  },
  {
    id: 'cape-canaveral',
    name: 'Cape Canaveral Space Coast',
    subtitle: 'KSC · CCSFS · Launch Corridor',
    lat: 28.5729,
    lon: -80.649,
    altM: 3,
    defaultRadiusKm: 140,
  },
  {
    id: 'london-heathrow',
    name: 'London Heathrow / TMA',
    subtitle: 'EGLL · EGKK · North Atlantic Gateway',
    lat: 51.47,
    lon: -0.4543,
    altM: 25,
    defaultRadiusKm: 120,
  },
  {
    id: 'tokyo-haneda',
    name: 'Tokyo Haneda / Kanto',
    subtitle: 'RJTT · RJAA · Tokyo Bay Corridor',
    lat: 35.5494,
    lon: 139.7798,
    altM: 11,
    defaultRadiusKm: 130,
  },
  {
    id: 'anchorage-polar',
    name: 'Anchorage Polar Cargo Hub',
    subtitle: 'PANC · High-Latitude Polar LEO Overpasses',
    lat: 61.1743,
    lon: -149.9981,
    altM: 46,
    defaultRadiusKm: 180,
  },
];

export interface TopocentricCoords {
  azimuthDeg: number;
  elevationDeg: number;
  slantRangeKm: number;
  groundDistKm: number;
  belowHorizon: boolean;
}

export interface TrailPoint {
  lon: number;
  lat: number;
  altM: number;
  ts: number;
}

export interface BaseSkyEntity {
  id: string;
  category: SkyCategory;
  callsign: string;
  subtitle: string;
  country: string;
  lat: number;
  lon: number;
  altM: number;
  altBaroM?: number;
  speedMs: number;
  headingDeg: number;
  headingValid?: boolean;
  vertRateMs: number;
  timestampMs: number;
  topocentric: TopocentricCoords;
  trail: TrailPoint[];
  isSimulated?: boolean;
  emergencyFlag?: string;
}

export interface FlightEntity extends BaseSkyEntity {
  category: 'flight' | 'military';
  icaoHex: string;
  registration?: string;
  aircraftType?: string;
  squawk?: string;
  onGround: boolean;
  isMilitary: boolean;
  isLadd?: boolean;
  isPia?: boolean;
  adsbCategory?: string;
  sourceFeed?: AdsbSourceFeed;
  airframeClass: 'heavy' | 'jet' | 'prop' | 'heli' | 'fast-mil';
}

export interface SatelliteEntity extends BaseSkyEntity {
  category: 'satellite';
  noradId: number;
  group: SatelliteGroup;
  inclinationDeg: number;
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
  sunlit: boolean;
  radialVelocityKmS: number;
  dopplerHz437MHz: number;
}

export interface BalloonEntity extends BaseSkyEntity {
  category: 'balloon';
  serial: string;
  sondeType: string;
  subSource?: BalloonSubSource;
  constellationId?: string;
  icaoHex?: string;
  registration?: string;
  squawk?: string;
  isCachedSeed?: boolean;
  freqMHz?: number;
  tempC?: number;
  pressureHPa?: number;
  humidityPct?: number;
  burstState: 'ascending' | 'descending' | 'float';
  uploaderCallsign?: string;
}

export interface DroneEntity extends BaseSkyEntity {
  category: 'drone';
  uasId: string;
  uaType: 'multirotor' | 'fixed-wing' | 'vtol';
  subSource?: DroneSubSource;
  icaoHex?: string;
  registration?: string;
  aircraftType?: string;
  adsbCategory?: string;
  squawk?: string;
  isMilitary?: boolean;
  isLadd?: boolean;
  isPia?: boolean;
  hasOperatorLocation?: boolean;
  altAglM: number;
  operatorLat: number;
  operatorLon: number;
  operatorDistM: number;
  missionDesc: string;
  faaCeilingFt: number | null;
  ceilingBreach: boolean;
  tfrBreach: boolean;
}

export type SkyEntity = FlightEntity | SatelliteEntity | BalloonEntity | DroneEntity;

export interface FeedTelemetryState {
  status: FeedHealthStatus;
  lastUpdatedMs: number | null;
  lastCheckedMs?: number | null;
  nextRefreshSec: number;
  intervalSec: number;
  provider: string;
  errorMsg?: string;
  httpStatus?: number;
  count: number;
  sourceBreakdown?: string;
}

export interface OpenDroneIdConfig {
  simulatorEnabled: boolean;
  endpointUrl: string;
  transport: 'off' | 'ws' | 'http';
  connected: boolean;
  lastError?: string;
}

export interface AirspaceData {
  uasfm: GeoJSON.FeatureCollection;
  sua: GeoJSON.FeatureCollection;
  usCoverage: boolean;
}

export interface TleRecord {
  name: string;
  noradId: number;
  group: SatelliteGroup;
  line1: string;
  line2: string;
}

export interface SatelliteOrbitOverlay {
  noradId: number;
  groundTrackSegments: Array<Array<[number, number]>>;
  passArcAzEl: Array<{ azDeg: number; elDeg: number; ts: number; isPeak?: boolean }>;
  footprintRadiusKm: number;
}

export interface SatelliteWorkerMeta {
  id: string;
  noradId: number;
  name: string;
  group: SatelliteGroup;
  inclinationDeg: number;
  periodMin: number;
  apogeeKm: number;
  perigeeKm: number;
}

export const SAT_KINEMATICS_STRIDE = 12;

export type WorkerRequestMessage =
  | { type: 'init-tles'; records: TleRecord[]; fullConstellation?: boolean }
  | {
      type: 'update-config';
      observer: ObserverLocation;
      radiusKm: number;
      orbitalScope: OrbitalScope;
      activeGroups: Record<SatelliteGroup, boolean>;
      fullConstellation?: boolean;
    }
  | { type: 'tick'; timestampMs: number }
  | { type: 'compute-orbit'; noradId: number; timestampMs: number; observer: ObserverLocation };

export type WorkerResponseMessage =
  | { type: 'ready'; count: number; totalParsed: number }
  | {
      type: 'propagated';
      timestampMs: number;
      count: number;
      totalLoaded: number;
      kinematics: Float32Array;
      meta: SatelliteWorkerMeta[];
    }
  | { type: 'orbit-overlay'; overlay: SatelliteOrbitOverlay }
  | { type: 'error'; message: string };
