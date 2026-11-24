import { fetchJsonWithTimeout } from './httpClient';

export interface GeoFix {
  lat: number;
  lon: number;
  altM: number;
  label: string;
  source: 'gps' | 'ip';
  accuracyM?: number;
}

export type GeolocationFailureCode =
  | 'UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'POSITION_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INVALID_COORDS';

export class GeolocationLookupError extends Error {
  readonly code: GeolocationFailureCode;

  constructor(code: GeolocationFailureCode, message: string) {
    super(message);
    this.name = 'GeolocationLookupError';
    this.code = code;
  }
}

export interface BrowserGeolocationOptions {
  highAccuracyTimeoutMs?: number;
  coarseTimeoutMs?: number;
  maximumAgeMs?: number;
}

export interface IpGeolocationOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AutoLocateCallbacks {
  onFix: (fix: GeoFix) => void;
  onLabelResolved?: (lat: number, lon: number, source: 'gps' | 'ip', label: string) => void;
  onUnavailable?: (reason: string) => void;
}

export interface AutoLocateOptions {
  signal?: AbortSignal;
  /**
   * Grace window (ms) to wait for browser GPS before kicking off IP geolocation
   * while a permission prompt or slow GPS lock is still in flight.
   */
  ipFallbackDelayMs?: number;
  highAccuracyTimeoutMs?: number;
  coarseTimeoutMs?: number;
  maximumAgeMs?: number;
  ipTimeoutMs?: number;
}

function parseFiniteCoord(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return Number.parseFloat(raw.trim());
  }
  return Number.NaN;
}

function isValidCoordinatePair(lat: number, lon: number, rejectNullIsland = false): boolean {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return false;
  }
  if (rejectNullIsland && Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) {
    return false;
  }
  return true;
}

function cleanPlaceToken(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

function formatPlaceLabel(parts: {
  city?: unknown;
  locality?: unknown;
  regionCode?: unknown;
  region?: unknown;
  countryCode?: unknown;
  country?: unknown;
}): string {
  const city = cleanPlaceToken(parts.city) || cleanPlaceToken(parts.locality);
  let regionCode = cleanPlaceToken(parts.regionCode);
  if (regionCode.includes('-')) {
    const suffix = regionCode.split('-').pop()?.trim() ?? '';
    if (suffix && suffix.length <= 4) {
      regionCode = suffix;
    }
  }
  const region = cleanPlaceToken(parts.region);
  const countryCode = cleanPlaceToken(parts.countryCode);
  const country = cleanPlaceToken(parts.country);

  const secondary =
    (regionCode && regionCode.length <= 4 && regionCode !== city ? regionCode : '') ||
    (region && region !== city ? region : '') ||
    (countryCode && countryCode !== city ? countryCode : '') ||
    (country && country !== city ? country : '');

  if (city && secondary) {
    return `${city}, ${secondary}`;
  }
  if (city) {
    return city;
  }
  if (region && countryCode) {
    return `${region}, ${countryCode}`;
  }
  if (region) {
    return region;
  }
  if (country) {
    return country;
  }
  return 'Current Location';
}

function requestPositionOnce(
  geolocation: Geolocation,
  options: PositionOptions
): Promise<GeolocationPosition> {
  return new Promise<GeolocationPosition>((resolve, reject) => {
    geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function mapDomGeolocationError(err: unknown): GeolocationLookupError {
  if (err instanceof GeolocationLookupError) return err;
  const geoErr = err as { code?: unknown; message?: unknown } | null;
  const code = typeof geoErr?.code === 'number' ? geoErr.code : 0;
  const rawMessage = typeof geoErr?.message === 'string' && geoErr.message.trim()
    ? geoErr.message.trim()
    : '';

  if (code === 1) {
    return new GeolocationLookupError(
      'PERMISSION_DENIED',
      rawMessage || 'Browser location permission was denied.'
    );
  }
  if (code === 2) {
    return new GeolocationLookupError(
      'POSITION_UNAVAILABLE',
      rawMessage || 'Current position is unavailable from device location services.'
    );
  }
  if (code === 3) {
    return new GeolocationLookupError(
      'TIMEOUT',
      rawMessage || 'Timed out waiting for browser location fix.'
    );
  }
  return new GeolocationLookupError(
    'POSITION_UNAVAILABLE',
    rawMessage || 'Unable to acquire browser location fix.'
  );
}

/**
 * Request the user's current geographic position directly from the browser Geolocation API.
 * Retries once with coarse (network/Wi-Fi) accuracy if high-accuracy GPS times out or is unavailable.
 */
export async function requestBrowserGeolocation(
  options: BrowserGeolocationOptions = {}
): Promise<GeoFix> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new GeolocationLookupError(
      'UNAVAILABLE',
      'Browser Geolocation API is unavailable in this environment.'
    );
  }

  const highAccuracyTimeoutMs = options.highAccuracyTimeoutMs ?? 8000;
  const coarseTimeoutMs = options.coarseTimeoutMs ?? 8000;
  const maximumAgeMs = options.maximumAgeMs ?? 30_000;

  let pos: GeolocationPosition;
  try {
    pos = await requestPositionOnce(navigator.geolocation, {
      enableHighAccuracy: true,
      timeout: highAccuracyTimeoutMs,
      maximumAge: maximumAgeMs,
    });
  } catch (err) {
    const mapped = mapDomGeolocationError(err);
    if (mapped.code === 'PERMISSION_DENIED') {
      throw mapped;
    }
    try {
      pos = await requestPositionOnce(navigator.geolocation, {
        enableHighAccuracy: false,
        timeout: coarseTimeoutMs,
        maximumAge: Math.max(maximumAgeMs, 60_000),
      });
    } catch (retryErr) {
      throw mapDomGeolocationError(retryErr);
    }
  }

  const lat = pos.coords?.latitude;
  const lon = pos.coords?.longitude;
  if (!isValidCoordinatePair(lat, lon, false)) {
    throw new GeolocationLookupError(
      'INVALID_COORDS',
      'Browser returned invalid geographic coordinates.'
    );
  }

  const altM =
    typeof pos.coords.altitude === 'number' && Number.isFinite(pos.coords.altitude)
      ? pos.coords.altitude
      : 12;
  const accuracyM =
    typeof pos.coords.accuracy === 'number' && Number.isFinite(pos.coords.accuracy)
      ? pos.coords.accuracy
      : undefined;

  return {
    lat,
    lon,
    altM,
    label: 'Current Location',
    source: 'gps',
    accuracyM,
  };
}

interface IpProviderSpec {
  name: string;
  url: string;
  parse: (data: unknown) => GeoFix | null;
}

const IP_GEOLOCATION_PROVIDERS: IpProviderSpec[] = [
  {
    name: 'geojs',
    url: 'https://get.geojs.io/v1/ip/geo.json',
    parse: (data) => {
      if (!data || typeof data !== 'object') return null;
      const obj = data as Record<string, unknown>;
      if (obj.error) return null;
      const lat = parseFiniteCoord(obj.latitude);
      const lon = parseFiniteCoord(obj.longitude);
      if (!isValidCoordinatePair(lat, lon, true)) return null;
      return {
        lat,
        lon,
        altM: 12,
        label: formatPlaceLabel({
          city: obj.city,
          region: obj.region,
          countryCode: obj.country_code,
          country: obj.country,
        }),
        source: 'ip',
      };
    },
  },
  {
    name: 'ipwho.is',
    url: 'https://ipwho.is/',
    parse: (data) => {
      if (!data || typeof data !== 'object') return null;
      const obj = data as Record<string, unknown>;
      if (obj.success === false) return null;
      const lat = parseFiniteCoord(obj.latitude);
      const lon = parseFiniteCoord(obj.longitude);
      if (!isValidCoordinatePair(lat, lon, true)) return null;
      return {
        lat,
        lon,
        altM: 12,
        label: formatPlaceLabel({
          city: obj.city,
          regionCode: obj.region_code,
          region: obj.region,
          countryCode: obj.country_code,
          country: obj.country,
        }),
        source: 'ip',
      };
    },
  },
  {
    name: 'ip.sb',
    url: 'https://api.ip.sb/geoip',
    parse: (data) => {
      if (!data || typeof data !== 'object') return null;
      const obj = data as Record<string, unknown>;
      if (obj.error || obj.code) return null;
      const lat = parseFiniteCoord(obj.latitude);
      const lon = parseFiniteCoord(obj.longitude);
      if (!isValidCoordinatePair(lat, lon, true)) return null;
      return {
        lat,
        lon,
        altM: 12,
        label: formatPlaceLabel({
          city: obj.city,
          regionCode: obj.region_code,
          region: obj.region,
          countryCode: obj.country_code,
          country: obj.country,
        }),
        source: 'ip',
      };
    },
  },
  {
    name: 'ipinfo',
    url: 'https://ipinfo.io/json',
    parse: (data) => {
      if (!data || typeof data !== 'object') return null;
      const obj = data as Record<string, unknown>;
      if (obj.error || typeof obj.loc !== 'string') return null;
      const parts = obj.loc.split(',');
      if (parts.length !== 2) return null;
      const lat = parseFiniteCoord(parts[0]);
      const lon = parseFiniteCoord(parts[1]);
      if (!isValidCoordinatePair(lat, lon, true)) return null;
      return {
        lat,
        lon,
        altM: 12,
        label: formatPlaceLabel({
          city: obj.city,
          region: obj.region,
          countryCode: obj.country,
        }),
        source: 'ip',
      };
    },
  },
];

/**
 * Resolve the user's current approximate geographic location via zero-key HTTPS CORS IP geolocation.
 * Returns null if all providers fail — never falls back to a hardcoded city.
 */
export async function fetchIpGeolocation(
  options: IpGeolocationOptions = {}
): Promise<GeoFix | null> {
  const timeoutMs = options.timeoutMs ?? 3200;

  for (const provider of IP_GEOLOCATION_PROVIDERS) {
    if (options.signal?.aborted) return null;
    try {
      const payload = await fetchJsonWithTimeout<unknown>(provider.url, {
        timeoutMs,
        signal: options.signal,
        init: { cache: 'no-store' },
      });
      const parsed = provider.parse(payload);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Try next CORS-enabled HTTPS IP geolocation provider
    }
  }

  return null;
}

interface BigDataCloudReverseResponse {
  city?: unknown;
  locality?: unknown;
  principalSubdivision?: unknown;
  principalSubdivisionCode?: unknown;
  countryCode?: unknown;
  countryName?: unknown;
}

/**
 * Best-effort, zero-key client-side reverse geocoding to turn a live GPS fix
 * into a concise human-readable station name (e.g. "Seattle, WA").
 */
export async function reverseGeocodeLabel(
  lat: number,
  lon: number,
  signal?: AbortSignal
): Promise<string | null> {
  if (!isValidCoordinatePair(lat, lon, false) || signal?.aborted) {
    return null;
  }

  try {
    const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${encodeURIComponent(
      lat.toFixed(5)
    )}&longitude=${encodeURIComponent(lon.toFixed(5))}&localityLanguage=en`;
    const data = await fetchJsonWithTimeout<BigDataCloudReverseResponse>(url, {
      timeoutMs: 3500,
      signal,
      init: { cache: 'no-store' },
    });
    if (!data || typeof data !== 'object') return null;

    const label = formatPlaceLabel({
      city: data.city,
      locality: data.locality,
      regionCode: data.principalSubdivisionCode,
      region: data.principalSubdivision,
      countryCode: data.countryCode,
      country: data.countryName,
    });
    return label && label !== 'Current Location' ? label : null;
  } catch {
    return null;
  }
}

/**
 * Automatically resolve the user's current geographic location on page load:
 * 1. Invokes browser Geolocation directly (prompting if needed, resolving immediately if granted).
 * 2. Falls back immediately to zero-key HTTPS IP geolocation if GPS is denied/unavailable,
 *    or after a brief grace window if the browser permission prompt is still open.
 * 3. Smoothly upgrades an IP fix to exact GPS if the user grants permission afterward.
 * 4. Never loads a hardcoded fallback city such as Washington, DC; calls onUnavailable if all fail.
 */
export function resolveCurrentGeographicLocation(
  callbacks: AutoLocateCallbacks,
  options: AutoLocateOptions = {}
): () => void {
  const controller = new AbortController();
  const externalSignal = options.signal;

  let cancelled = false;
  let gpsSettled = false;
  let gpsSucceeded = false;
  let gpsErrorMsg: string | null = null;
  let ipStarted = false;
  let ipSettled = false;
  let ipSucceeded = false;
  let unavailableReported = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearGraceTimer = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    clearGraceTimer();
    controller.abort();
    if (externalSignal) {
      externalSignal.removeEventListener('abort', cancel);
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      cancel();
      return cancel;
    }
    externalSignal.addEventListener('abort', cancel, { once: true });
  }

  const maybeReportUnavailable = () => {
    if (cancelled || unavailableReported || gpsSucceeded || ipSucceeded) return;
    if (gpsSettled && ipSettled) {
      unavailableReported = true;
      const reason =
        gpsErrorMsg && gpsErrorMsg.trim().length > 0
          ? `${gpsErrorMsg} Network IP geolocation was also unavailable.`
          : 'Unable to determine your current location via browser GPS or network geolocation.';
      callbacks.onUnavailable?.(reason);
    }
  };

  const startIpFallback = () => {
    if (cancelled || ipStarted || gpsSucceeded) return;
    ipStarted = true;
    clearGraceTimer();

    void fetchIpGeolocation({
      signal: controller.signal,
      timeoutMs: options.ipTimeoutMs ?? 3200,
    })
      .then((ipFix) => {
        ipSettled = true;
        if (cancelled || gpsSucceeded) return;
        if (ipFix) {
          ipSucceeded = true;
          callbacks.onFix(ipFix);
        } else {
          maybeReportUnavailable();
        }
      })
      .catch(() => {
        ipSettled = true;
        maybeReportUnavailable();
      });
  };

  const hasBrowserGeo =
    typeof navigator !== 'undefined' &&
    Boolean(navigator.geolocation && typeof navigator.geolocation.getCurrentPosition === 'function');

  if (!hasBrowserGeo) {
    gpsSettled = true;
    gpsErrorMsg = 'Browser geolocation is unavailable.';
    startIpFallback();
    return cancel;
  }

  // Optimization: if permission is already explicitly denied, start IP geolocation immediately
  if (typeof navigator.permissions?.query === 'function') {
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (!cancelled && !gpsSucceeded && status.state === 'denied') {
          startIpFallback();
        }
      })
      .catch(() => {
        // Permissions API unsupported or blocked — rely on direct getCurrentPosition + grace timer
      });
  }

  const ipFallbackDelayMs = options.ipFallbackDelayMs ?? 1800;
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (!cancelled && !gpsSucceeded) {
      startIpFallback();
    }
  }, ipFallbackDelayMs);

  void requestBrowserGeolocation({
    highAccuracyTimeoutMs: options.highAccuracyTimeoutMs ?? 8000,
    coarseTimeoutMs: options.coarseTimeoutMs ?? 8000,
    maximumAgeMs: options.maximumAgeMs ?? 30_000,
  })
    .then((gpsFix) => {
      gpsSettled = true;
      if (cancelled) return;
      gpsSucceeded = true;
      clearGraceTimer();
      callbacks.onFix(gpsFix);

      void reverseGeocodeLabel(gpsFix.lat, gpsFix.lon, controller.signal).then((resolvedLabel) => {
        if (!cancelled && resolvedLabel) {
          callbacks.onLabelResolved?.(gpsFix.lat, gpsFix.lon, 'gps', resolvedLabel);
        }
      });
    })
    .catch((err) => {
      gpsSettled = true;
      if (cancelled) return;
      const mapped = mapDomGeolocationError(err);
      gpsErrorMsg = mapped.message;
      if (!ipStarted) {
        startIpFallback();
      } else {
        maybeReportUnavailable();
      }
    });

  return cancel;
}
