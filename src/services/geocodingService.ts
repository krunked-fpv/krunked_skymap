import { fetchJsonWithTimeout } from './httpClient';

export interface ParsedCoordinates {
  lat: number;
  lon: number;
  label: string;
}

export interface GeocodingResult {
  name: string;
  label: string;
  subtitle: string;
  lat: number;
  lon: number;
  altM: number;
  country?: string;
  source: 'coords' | 'open-meteo' | 'nominatim';
}

function validateLatLon(lat: number, lon: number): ParsedCoordinates | null {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return null;
  }
  const latHem = lat >= 0 ? 'N' : 'S';
  const lonHem = lon >= 0 ? 'E' : 'W';
  const label = `${Math.abs(lat).toFixed(4)}°${latHem}, ${Math.abs(lon).toFixed(4)}°${lonHem}`;
  return { lat, lon, label };
}

function parseDmsPart(
  degStr: string,
  minStr: string | undefined,
  secStr: string | undefined,
  hem: string
): number | null {
  const deg = Number.parseFloat(degStr);
  const min = minStr ? Number.parseFloat(minStr) : 0;
  const sec = secStr ? Number.parseFloat(secStr) : 0;
  if (!Number.isFinite(deg) || !Number.isFinite(min) || !Number.isFinite(sec)) {
    return null;
  }
  if (min < 0 || min >= 60 || sec < 0 || sec >= 60) {
    return null;
  }
  const absVal = Math.abs(deg) + min / 60 + sec / 3600;
  const upperHem = hem.toUpperCase();
  return upperHem === 'S' || upperHem === 'W' ? -absVal : absVal;
}

/**
 * Parse direct latitude/longitude expressions such as:
 * - "38.85, -77.04"
 * - "34.9054N 117.8839W"
 * - "34.9054° N, 117.8839° W"
 * - "N34.9054 W117.8839"
 * - "38°51'04\"N 77°02'25\"W"
 */
export function parseDirectCoordinates(query: string): ParsedCoordinates | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim();
  if (!trimmed) return null;

  // 1. Plain signed decimal degrees: "38.85, -77.04" or "38.85 -77.04"
  const signedMatch = trimmed.match(
    /^([+-]?\d+(?:\.\d+)?)\s*°?\s*[,\s;]+\s*([+-]?\d+(?:\.\d+)?)\s*°?$/
  );
  if (signedMatch) {
    const lat = Number.parseFloat(signedMatch[1]);
    const lon = Number.parseFloat(signedMatch[2]);
    return validateLatLon(lat, lon);
  }

  // 2. Suffix hemisphere decimal degrees: "34.9054N 117.8839W" / "34.9054° N, 117.8839° W"
  const suffixHemMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*°?\s*([NSns])\s*[,\s;]*\s*(\d+(?:\.\d+)?)\s*°?\s*([EWew])$/
  );
  if (suffixHemMatch) {
    const latMag = Number.parseFloat(suffixHemMatch[1]);
    const lonMag = Number.parseFloat(suffixHemMatch[3]);
    const lat = suffixHemMatch[2].toUpperCase() === 'S' ? -latMag : latMag;
    const lon = suffixHemMatch[4].toUpperCase() === 'W' ? -lonMag : lonMag;
    return validateLatLon(lat, lon);
  }

  // 3. Prefix hemisphere decimal degrees: "N34.9054 W117.8839"
  const prefixHemMatch = trimmed.match(
    /^([NSns])\s*(\d+(?:\.\d+)?)\s*°?\s*[,\s;]*\s*([EWew])\s*(\d+(?:\.\d+)?)\s*°?$/
  );
  if (prefixHemMatch) {
    const latMag = Number.parseFloat(prefixHemMatch[2]);
    const lonMag = Number.parseFloat(prefixHemMatch[4]);
    const lat = prefixHemMatch[1].toUpperCase() === 'S' ? -latMag : latMag;
    const lon = prefixHemMatch[3].toUpperCase() === 'W' ? -lonMag : lonMag;
    return validateLatLon(lat, lon);
  }

  // 4. DMS / DDM with hemisphere suffix: 38°51'04"N 77°02'25"W
  const dmsMatch = trimmed.match(
    /^(\d{1,2})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*['′]?\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″]?)?\s*([NSns])\s*[,\s;]*\s*(\d{1,3})\s*°\s*(\d{1,2}(?:\.\d+)?)\s*['′]?\s*(?:(\d{1,2}(?:\.\d+)?)\s*["″]?)?\s*([EWew])$/
  );
  if (dmsMatch) {
    const lat = parseDmsPart(dmsMatch[1], dmsMatch[2], dmsMatch[3], dmsMatch[4]);
    const lon = parseDmsPart(dmsMatch[5], dmsMatch[6], dmsMatch[7], dmsMatch[8]);
    if (lat === null || lon === null) return null;
    return validateLatLon(lat, lon);
  }

  return null;
}

interface OpenMeteoResponse {
  results?: Array<{
    name?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    elevation?: unknown;
    country?: unknown;
    admin1?: unknown;
    admin2?: unknown;
  }>;
}

interface NominatimItem {
  display_name?: unknown;
  name?: unknown;
  lat?: unknown;
  lon?: unknown;
  type?: unknown;
  addresstype?: unknown;
}

/**
 * Search coordinates, cities, or landmarks using direct coordinate parsing,
 * Open-Meteo Geocoding API, and OpenStreetMap Nominatim fallback.
 */
export async function searchLocation(
  query: string,
  signal?: AbortSignal
): Promise<GeocodingResult[]> {
  if (typeof query !== 'string') return [];
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const direct = parseDirectCoordinates(trimmed);
  if (direct) {
    return [
      {
        name: direct.label,
        label: direct.label,
        subtitle: 'Direct Coordinates',
        lat: direct.lat,
        lon: direct.lon,
        altM: 0,
        source: 'coords',
      },
    ];
  }

  // 1. Primary: Open-Meteo Geocoding API (CORS *)
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(
      trimmed
    )}&count=6&language=en&format=json`;
    const data = await fetchJsonWithTimeout<OpenMeteoResponse>(url, {
      timeoutMs: 4000,
      signal,
    });

    if (data && Array.isArray(data.results) && data.results.length > 0) {
      const mapped: GeocodingResult[] = [];
      for (const item of data.results) {
        const lat = typeof item.latitude === 'number' ? item.latitude : Number.NaN;
        const lon = typeof item.longitude === 'number' ? item.longitude : Number.NaN;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : trimmed;
        const admin1 = typeof item.admin1 === 'string' ? item.admin1.trim() : '';
        const country = typeof item.country === 'string' ? item.country.trim() : '';
        const altM =
          typeof item.elevation === 'number' && Number.isFinite(item.elevation)
            ? item.elevation
            : 0;
        const subtitle = [admin1, country].filter(Boolean).join(', ') || 'Location';
        mapped.push({
          name,
          label: name,
          subtitle,
          lat,
          lon,
          altM,
          country: country || undefined,
          source: 'open-meteo',
        });
      }
      if (mapped.length > 0) {
        return mapped;
      }
    }
  } catch {
    // Fall through to Nominatim
  }

  // 2. Fallback: OpenStreetMap Nominatim (great for airports, bases, postcodes)
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      trimmed
    )}&format=jsonv2&limit=6`;
    const data = await fetchJsonWithTimeout<NominatimItem[]>(url, {
      timeoutMs: 4500,
      signal,
    });
    if (!Array.isArray(data)) return [];

    const mapped: GeocodingResult[] = [];
    for (const item of data) {
      const lat = typeof item.lat === 'string' ? Number.parseFloat(item.lat) : Number.NaN;
      const lon = typeof item.lon === 'string' ? Number.parseFloat(item.lon) : Number.NaN;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const display =
        typeof item.display_name === 'string' ? item.display_name.trim() : trimmed;
      const parts = display.split(',').map((p) => p.trim()).filter(Boolean);
      const name =
        (typeof item.name === 'string' && item.name.trim()) || parts[0] || trimmed;
      const subtitle = parts.slice(1, 4).join(', ') || display;
      mapped.push({
        name,
        label: name,
        subtitle,
        lat,
        lon,
        altM: 0,
        source: 'nominatim',
      });
    }
    return mapped;
  } catch {
    return [];
  }
}
