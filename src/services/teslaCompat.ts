const TESLA_UA_REGEX = /(?:Tesla\/|QtCarBrowser)/i;
const DEFAULT_BASE_TIMEOUT_MS = 5000;

export const TESLA_MIN_TIMEOUT_MS = 10_000;
export const TESLA_MAX_ADAPTIVE_TIMEOUT_MS = 20_000;
export const TESLA_TIMEOUT_MULTIPLIER = 2;
export const TESLA_CACHE_BUST_PARAM = '_refresh';
export const TESLA_SW_PURGE_RELOAD_KEY = 'krunked_tesla_sw_purged';

export interface PurgeCachesResult {
  unregisteredWorkers: number;
  deletedCaches: number;
}

export interface RuntimeSwBootstrapOptions {
  userAgent?: string;
  swUrl?: string;
  scope?: string;
  nowMs?: number;
}

export type RuntimeSwBootstrapOutcome = 'purged-tesla' | 'registered' | 'unsupported';

/**
 * Detect Tesla in-car browsers (modern Tesla Chromium UA containing `Tesla/`
 * as well as legacy `QtCarBrowser`).
 */
export function isTeslaBrowser(userAgent?: string): boolean {
  const ua =
    typeof userAgent === 'string'
      ? userAgent
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';
  return TESLA_UA_REGEX.test(ua);
}

/**
 * Compute an adaptive request timeout in milliseconds.
 * - Desktop / mobile browsers keep `baseMs` unchanged (zero regression).
 * - Tesla in-car browsers on LTE cellular connections receive more generous
 *   timeouts (at least 10s, scaled 2x up to 20s, never shrinking larger bases).
 */
export function resolveAdaptiveTimeoutMs(baseMs: number, userAgent?: string): number {
  const safeBase =
    typeof baseMs === 'number' && Number.isFinite(baseMs)
      ? Math.max(0, baseMs)
      : DEFAULT_BASE_TIMEOUT_MS;

  if (safeBase === 0 || !isTeslaBrowser(userAgent)) {
    return safeBase;
  }

  const scaled = Math.round(safeBase * TESLA_TIMEOUT_MULTIPLIER);
  const clamped = Math.min(
    TESLA_MAX_ADAPTIVE_TIMEOUT_MS,
    Math.max(TESLA_MIN_TIMEOUT_MS, scaled)
  );
  return Math.max(safeBase, clamped);
}

/**
 * Safely unregister every registered Service Worker and delete all Cache Storage buckets.
 * Never throws even when storage APIs are unavailable or restricted.
 */
export async function purgeServiceWorkersAndCaches(): Promise<PurgeCachesResult> {
  let unregisteredWorkers = 0;
  let deletedCaches = 0;

  try {
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      typeof navigator.serviceWorker?.getRegistrations === 'function'
    ) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const results = await Promise.allSettled(
        registrations.map((registration) => registration.unregister())
      );
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value !== false) {
          unregisteredWorkers += 1;
        }
      }
    }
  } catch {
    // Ignore SecurityError / restricted SW environments
  }

  try {
    const cacheStorage =
      typeof caches !== 'undefined'
        ? caches
        : typeof window !== 'undefined'
          ? window.caches
          : undefined;

    if (cacheStorage && typeof cacheStorage.keys === 'function') {
      const keys = await cacheStorage.keys();
      const results = await Promise.allSettled(keys.map((key) => cacheStorage.delete(key)));
      for (const res of results) {
        if (res.status === 'fulfilled' && res.value !== false) {
          deletedCaches += 1;
        }
      }
    }
  } catch {
    // Ignore Cache Storage quota / permission failures
  }

  return { unregisteredWorkers, deletedCaches };
}

/**
 * Append or replace a cache-busting query parameter while preserving path,
 * existing query params, and hash permalink state.
 */
export function buildCacheBustedReloadUrl(currentHref: string, nowMs = Date.now()): string {
  try {
    const parsed = new URL(currentHref);
    parsed.searchParams.set(TESLA_CACHE_BUST_PARAM, String(nowMs));
    return parsed.toString();
  } catch {
    const [withoutHash, hashPart] = currentHref.split('#', 2);
    const sep = withoutHash.includes('?') ? '&' : '?';
    const hashSuffix = hashPart !== undefined ? `#${hashPart}` : '';
    return `${withoutHash}${sep}${TESLA_CACHE_BUST_PARAM}=${nowMs}${hashSuffix}`;
  }
}

/**
 * Purge all Service Workers and Cache Storage entries, then trigger a hard
 * navigation reload with a cache-busting query parameter so stale HTML/bundles
 * cannot be replayed from aggressive browser HTTP caches.
 */
export async function forceHardReloadWithCacheBust(options?: {
  nowMs?: number;
}): Promise<PurgeCachesResult> {
  const result = await purgeServiceWorkersAndCaches();

  if (typeof window !== 'undefined' && window.location) {
    const currentHref =
      typeof window.location.href === 'string' && window.location.href.length > 0
        ? window.location.href
        : '';
    if (currentHref) {
      const nextUrl = buildCacheBustedReloadUrl(currentHref, options?.nowMs);
      try {
        if (typeof window.location.replace === 'function') {
          window.location.replace(nextUrl);
          return result;
        }
        if (typeof window.location.assign === 'function') {
          window.location.assign(nextUrl);
          return result;
        }
      } catch {
        // Fallback to standard reload below if replace/assign is restricted
      }
    }
    try {
      if (typeof window.location.reload === 'function') {
        window.location.reload();
      }
    } catch {
      // Ignore navigation errors in headless/sandboxed environments
    }
  }

  return result;
}

declare global {
  interface Window {
    __krunkedSwBootstrapped?: boolean;
  }
}

/**
 * Runtime Service Worker bootstrap invoked from `src/main.tsx`.
 * - On Tesla browsers: never registers a Service Worker; proactively unregisters
 *   stale workers and purges Cache Storage, performing at most one guarded
 *   cache-busted reload if an old SW controller was still intercepting this load.
 * - On non-Tesla browsers: registers `./sw.js` with `updateViaCache: 'none'`
 *   and triggers a safe background update check.
 */
export async function bootstrapRuntimeServiceWorker(
  options: RuntimeSwBootstrapOptions = {}
): Promise<RuntimeSwBootstrapOutcome> {
  if (typeof window === 'undefined' || !window.location) {
    return 'unsupported';
  }
  const protocol = window.location.protocol;
  if (protocol !== 'https:' && protocol !== 'http:') {
    return 'unsupported';
  }

  if (isTeslaBrowser(options.userAgent)) {
    const hadController = Boolean(
      typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        navigator.serviceWorker?.controller
    );
    await purgeServiceWorkersAndCaches();

    if (hadController) {
      try {
        if (!window.sessionStorage?.getItem(TESLA_SW_PURGE_RELOAD_KEY)) {
          window.sessionStorage?.setItem(TESLA_SW_PURGE_RELOAD_KEY, '1');
          const nextUrl = buildCacheBustedReloadUrl(window.location.href, options.nowMs);
          if (typeof window.location.replace === 'function') {
            window.location.replace(nextUrl);
          }
        }
      } catch {
        // Never risk an unguarded reload loop when sessionStorage is unavailable
      }
    }

    return 'purged-tesla';
  }

  if (
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    typeof navigator.serviceWorker?.register !== 'function'
  ) {
    return 'unsupported';
  }

  const swUrl = options.swUrl ?? './sw.js';
  const scope = options.scope ?? './';

  if (window.__krunkedSwBootstrapped) {
    try {
      if (typeof navigator.serviceWorker.getRegistration === 'function') {
        const existing = await navigator.serviceWorker.getRegistration(scope);
        if (existing && typeof existing.update === 'function') {
          await existing.update().catch(() => {});
        }
      }
    } catch {
      // Ignore update check errors
    }
    return 'registered';
  }

  try {
    const registration = await navigator.serviceWorker.register(swUrl, {
      scope,
      updateViaCache: 'none',
    });
    window.__krunkedSwBootstrapped = true;
    if (registration && typeof registration.update === 'function') {
      registration.update().catch(() => {});
    }
    return 'registered';
  } catch {
    return 'unsupported';
  }
}
