import type {
  AirspaceData,
  FeedHealthStatus,
  ObserverLocation,
} from '../types/sky-contracts';
import { pointInGeoJsonFeature } from './geoHelpers';
import { fetchJsonWithTimeout } from './httpClient';

const FT_TO_M = 0.3048;
const ARCGIS_TIMEOUT_MS = 6000;

const UASFM_ENDPOINT =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/FAA_UAS_FacilityMap_Data/FeatureServer/0/query';
const SUA_ENDPOINT =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Special_Use_Airspace/FeatureServer/0/query';
const BOUNDARY_AIRSPACE_ENDPOINT =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Boundary_Airspace/FeatureServer/0/query';

const EMPTY_FC: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [],
};

export interface AirspaceFetchResult {
  airspace: AirspaceData;
  status: FeedHealthStatus;
  provider: string;
  timestampMs: number;
  errorMsg?: string;
}

export interface AirspaceFetchOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DroneComplianceResult {
  faaCeilingFt: number | null;
  ceilingBreach: boolean;
  tfrBreach: boolean;
}

/**
 * Determine whether coordinates lie within CONUS, Alaska, Hawaii, Puerto Rico/USVI,
 * Guam/CNMI, or American Samoa where FAA ArcGIS UASFM & SUA data applies.
 */
export function isInsideContinentalUsOrTerritories(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

  // CONUS (including Great Lakes & coastal buffer)
  if (lat >= 24.0 && lat <= 49.6 && lon >= -125.2 && lon <= -66.5) return true;
  // Alaska (including Aleutian Arc crossing antimeridian)
  if (
    lat >= 51.0 &&
    lat <= 71.6 &&
    ((lon >= -179.9 && lon <= -129.9) || (lon >= 172.0 && lon <= 180.0))
  ) {
    return true;
  }
  // Hawaii
  if (lat >= 18.8 && lat <= 22.5 && lon >= -160.6 && lon <= -154.7) return true;
  // Puerto Rico & US Virgin Islands
  if (lat >= 17.6 && lat <= 18.6 && lon >= -68.0 && lon <= -64.5) return true;
  // Guam & Northern Mariana Islands
  if (lat >= 13.1 && lat <= 20.6 && lon >= 144.5 && lon <= 146.1) return true;
  // American Samoa
  if (lat >= -14.6 && lat <= -11.0 && lon >= -171.2 && lon <= -168.0) return true;

  return false;
}

function validateFeatureCollection(data: unknown): GeoJSON.FeatureCollection {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid GeoJSON payload');
  }
  const obj = data as { type?: unknown; features?: unknown; error?: { message?: string } };
  if (obj.error) {
    throw new Error(obj.error.message ?? 'ArcGIS FeatureServer returned error');
  }
  if (obj.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new Error('Expected GeoJSON FeatureCollection');
  }
  return {
    type: 'FeatureCollection',
    features: obj.features.filter(
      (f): f is GeoJSON.Feature => Boolean(f && typeof f === 'object' && f.geometry)
    ),
  };
}

function parseFallbackGeoJson(raw: unknown): {
  uasfm: GeoJSON.FeatureCollection;
  sua: GeoJSON.FeatureCollection;
} {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid fallback airspace JSON');
  }

  const obj = raw as {
    type?: unknown;
    features?: unknown;
    uasfm?: unknown;
    sua?: unknown;
  };

  if (obj.uasfm || obj.sua) {
    return {
      uasfm: obj.uasfm ? validateFeatureCollection(obj.uasfm) : EMPTY_FC,
      sua: obj.sua ? validateFeatureCollection(obj.sua) : EMPTY_FC,
    };
  }

  const fc = validateFeatureCollection(raw);
  const uasfmFeatures: GeoJSON.Feature[] = [];
  const suaFeatures: GeoJSON.Feature[] = [];

  for (const feature of fc.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const typeCode = String(props.TYPE_CODE ?? props.zoneType ?? '').toUpperCase();
    if (
      props.layer === 'sua' ||
      ['SATA', 'P', 'R', 'TFR', 'FRZ', 'SFRA', 'MOA', 'W', 'A'].includes(typeCode)
    ) {
      suaFeatures.push(feature);
    } else if (props.CEILING !== undefined || props.layer === 'uasfm') {
      uasfmFeatures.push(feature);
    } else {
      suaFeatures.push(feature);
    }
  }

  return {
    uasfm: { type: 'FeatureCollection', features: uasfmFeatures },
    sua: { type: 'FeatureCollection', features: suaFeatures },
  };
}

/**
 * Fetch FAA UAS Facility Maps, Special Use Airspace, and Boundary Airspace (SATA/P/R/TFR).
 * Returns usCoverage: false with empty collections outside US/territorial airspace.
 * Falls back to ./data/fallback-airspace.geojson when US ArcGIS requests fail.
 */
export async function fetchAirspace(
  observer: ObserverLocation,
  radiusKm: number,
  options: AirspaceFetchOptions = {}
): Promise<AirspaceFetchResult> {
  const nowMs = Date.now();
  if (!isInsideContinentalUsOrTerritories(observer.lat, observer.lon)) {
    return {
      airspace: {
        uasfm: EMPTY_FC,
        sua: EMPTY_FC,
        usCoverage: false,
      },
      status: 'live',
      provider: 'faa-arcgis-outside-us',
      timestampMs: nowMs,
    };
  }

  const timeoutMs = options.timeoutMs ?? ARCGIS_TIMEOUT_MS;
  const cosLat = Math.max(0.15, Math.cos((observer.lat * Math.PI) / 180));

  // Cap UASFM query envelope to min(radiusKm, 50 km) and strictly <= ±0.35°
  const uasfmKm = Math.min(Math.max(5, radiusKm), 50);
  const uasfmDLat = Math.min(0.35, uasfmKm / 111.32);
  const uasfmDLon = Math.min(0.35, uasfmKm / (111.32 * cosLat));
  const uMinLat = (observer.lat - uasfmDLat).toFixed(5);
  const uMaxLat = (observer.lat + uasfmDLat).toFixed(5);
  const uMinLon = (observer.lon - uasfmDLon).toFixed(5);
  const uMaxLon = (observer.lon + uasfmDLon).toFixed(5);

  const uasfmParams = new URLSearchParams({
    where: `LATITUDE BETWEEN ${uMinLat} AND ${uMaxLat} AND LONGITUDE BETWEEN ${uMinLon} AND ${uMaxLon}`,
    outFields: 'CEILING,UNIT,APT1_FAAID,APT1_ICAO,APT1_NAME,AIRSPACE_1',
    resultRecordCount: '1000',
    f: 'geojson',
  });

  // SUA & Boundary envelope based on scan radius (capped at ±1.8°)
  const suaKm = Math.min(Math.max(10, radiusKm), 200);
  const suaDLat = Math.min(1.8, suaKm / 111.32);
  const suaDLon = Math.min(1.8, suaKm / (111.32 * cosLat));
  const envelope = `${(observer.lon - suaDLon).toFixed(4)},${(observer.lat - suaDLat).toFixed(
    4
  )},${(observer.lon + suaDLon).toFixed(4)},${(observer.lat + suaDLat).toFixed(4)}`;

  const suaParams = new URLSearchParams({
    geometryType: 'esriGeometryEnvelope',
    geometry: envelope,
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    resultRecordCount: '500',
    f: 'geojson',
  });

  const boundaryParams = new URLSearchParams({
    where: "TYPE_CODE IN ('SATA','P','R','TFR')",
    geometryType: 'esriGeometryEnvelope',
    geometry: envelope,
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    resultRecordCount: '500',
    f: 'geojson',
  });

  const [uasfmRes, suaRes, boundaryRes] = await Promise.allSettled([
    fetchJsonWithTimeout<unknown>(`${UASFM_ENDPOINT}?${uasfmParams.toString()}`, {
      timeoutMs,
      signal: options.signal,
    }).then(validateFeatureCollection),
    fetchJsonWithTimeout<unknown>(`${SUA_ENDPOINT}?${suaParams.toString()}`, {
      timeoutMs,
      signal: options.signal,
    }).then(validateFeatureCollection),
    fetchJsonWithTimeout<unknown>(`${BOUNDARY_AIRSPACE_ENDPOINT}?${boundaryParams.toString()}`, {
      timeoutMs,
      signal: options.signal,
    }).then(validateFeatureCollection),
  ]);

  const anySuccess =
    uasfmRes.status === 'fulfilled' ||
    suaRes.status === 'fulfilled' ||
    boundaryRes.status === 'fulfilled';

  if (anySuccess) {
    const uasfm = uasfmRes.status === 'fulfilled' ? uasfmRes.value : EMPTY_FC;
    const suaFeatures: GeoJSON.Feature[] = [];
    if (suaRes.status === 'fulfilled') suaFeatures.push(...suaRes.value.features);
    if (boundaryRes.status === 'fulfilled') suaFeatures.push(...boundaryRes.value.features);

    return {
      airspace: {
        uasfm,
        sua: { type: 'FeatureCollection', features: suaFeatures },
        usCoverage: true,
      },
      status: 'live',
      provider: 'faa-arcgis',
      timestampMs: Date.now(),
    };
  }

  const errorMsg = [uasfmRes, suaRes, boundaryRes]
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
    .join(' | ');

  try {
    const fallbackRaw = await fetchJsonWithTimeout<unknown>('./data/fallback-airspace.geojson', {
      timeoutMs: 3500,
      signal: options.signal,
    });
    const parsed = parseFallbackGeoJson(fallbackRaw);
    return {
      airspace: {
        uasfm: parsed.uasfm,
        sua: parsed.sua,
        usCoverage: true,
      },
      status: 'fallback',
      provider: 'seeded-airspace',
      timestampMs: Date.now(),
      errorMsg,
    };
  } catch (fallbackErr) {
    return {
      airspace: {
        uasfm: EMPTY_FC,
        sua: EMPTY_FC,
        usCoverage: true,
      },
      status: 'error',
      provider: 'faa-arcgis',
      timestampMs: Date.now(),
      errorMsg: `${errorMsg} | fallback: ${
        fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
      }`,
    };
  }
}

function extractNumericCeilingFt(props: Record<string, unknown>): number | null {
  const raw = props.CEILING ?? props.ceiling;
  let val: number | null = null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    val = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed)) val = parsed;
  }
  if (val === null) return null;

  const unit = String(props.UNIT ?? props.unit ?? 'FT').toUpperCase();
  if (unit === 'M' || unit === 'METERS') {
    return val / FT_TO_M;
  }
  return val;
}

function isLowAltitudeTfrOrRestricted(
  props: Record<string, unknown>,
  altAglFt: number
): boolean {
  const typeCode = String(
    props.TYPE_CODE ?? props.type_code ?? props.zoneType ?? props.CLASS ?? ''
  )
    .trim()
    .toUpperCase();

  if (['TFR', 'P', 'R', 'SATA', 'FRZ', 'SFRA', 'PROHIBITED', 'RESTRICTED'].includes(typeCode)) {
    return true;
  }

  const lowerRaw = props.LOWER_VAL ?? props.lower_val;
  if (typeof lowerRaw === 'number' && Number.isFinite(lowerRaw)) {
    return lowerRaw <= Math.max(1200, altAglFt);
  }
  if (typeof lowerRaw === 'string' && /^\d+(\.\d+)?$/.test(lowerRaw.trim())) {
    return Number.parseFloat(lowerRaw.trim()) <= Math.max(1200, altAglFt);
  }

  // Surface / unspecified floor hazard zones (or test features) breach at low altitude
  return true;
}

/**
 * Evaluate drone position and AGL altitude against FAA UASFM ceilings and SUA/TFR hazard zones.
 */
export function evaluateDroneAirspaceCompliance(
  lat: number,
  lon: number,
  altAglM: number,
  airspace: AirspaceData
): DroneComplianceResult {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altAglM)) {
    return { faaCeilingFt: null, ceilingBreach: false, tfrBreach: false };
  }

  const altAglFt = altAglM / FT_TO_M;
  let lowestCeilingFt: number | null = null;

  for (const feature of airspace.uasfm?.features ?? []) {
    if (!pointInGeoJsonFeature(lon, lat, feature)) continue;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const ceilingFt = extractNumericCeilingFt(props);
    if (ceilingFt !== null) {
      lowestCeilingFt =
        lowestCeilingFt === null ? ceilingFt : Math.min(lowestCeilingFt, ceilingFt);
    }
  }

  const ceilingBreach = lowestCeilingFt !== null && altAglFt > lowestCeilingFt;

  let tfrBreach = false;
  for (const feature of airspace.sua?.features ?? []) {
    if (!pointInGeoJsonFeature(lon, lat, feature)) continue;
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    if (isLowAltitudeTfrOrRestricted(props, altAglFt)) {
      tfrBreach = true;
      break;
    }
  }

  return {
    faaCeilingFt: lowestCeilingFt,
    ceilingBreach,
    tfrBreach,
  };
}
