import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserverLocation } from '../../src/types/sky-contracts';
import {
  TESLA_MIN_TIMEOUT_MS,
  TESLA_SW_PURGE_RELOAD_KEY,
  bootstrapRuntimeServiceWorker,
  buildCacheBustedReloadUrl,
  forceHardReloadWithCacheBust,
  isTeslaBrowser,
  purgeServiceWorkersAndCaches,
  resolveAdaptiveTimeoutMs,
} from '../../src/services/teslaCompat';
import {
  CircuitBreaker,
  TokenBucketRateLimiter,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  fetchWithTimeout,
} from '../../src/services/httpClient';
import {
  clearFlightsServiceCache,
  fetchFlightsCascade,
  fetchGlobalSpecialFlights,
  flightsCircuitBreaker,
} from '../../src/services/flightsService';
import { clearBalloonsCache, fetchBalloons } from '../../src/services/balloonsService';
import { clearTleCache, refreshTlesIfStale } from '../../src/services/satellitesService';
import { fetchAirspace } from '../../src/services/airspaceService';

const TESLA_CHROMIUM_UA =
  'Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/114.0.5735.199 Chrome/114.0.5735.199 Safari/537.36 Tesla/2024.26.7-abc123';
const TESLA_QT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/534.34 (KHTML, like Gecko) QtCarBrowser Safari/534.34';
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MOBILE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

const DCA_OBSERVER: ObserverLocation = {
  lat: 38.8512,
  lon: -77.0402,
  altM: 12,
  label: 'DC / Potomac Corridor',
  source: 'preset',
};

describe('teslaCompat — UA detection, adaptive timeouts, SW/cache purge, and reload', () => {
  beforeEach(() => {
    clearFlightsServiceCache();
    clearBalloonsCache();
    clearTleCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('accurately detects Tesla Chromium and QtCarBrowser UAs without false positives', () => {
    expect(isTeslaBrowser(TESLA_CHROMIUM_UA)).toBe(true);
    expect(isTeslaBrowser(TESLA_QT_UA)).toBe(true);
    expect(isTeslaBrowser('custom tesla/2025.2')).toBe(true);
    expect(isTeslaBrowser('custom qtcarbrowser')).toBe(true);

    expect(isTeslaBrowser(DESKTOP_CHROME_UA)).toBe(false);
    expect(isTeslaBrowser(MOBILE_SAFARI_UA)).toBe(false);
    expect(isTeslaBrowser('')).toBe(false);

    vi.stubGlobal('navigator', { userAgent: TESLA_CHROMIUM_UA });
    expect(isTeslaBrowser()).toBe(true);

    vi.stubGlobal('navigator', { userAgent: DESKTOP_CHROME_UA });
    expect(isTeslaBrowser()).toBe(false);
  });

  it('scales timeouts generously on Tesla browser while preserving exact baseMs on desktop/mobile', () => {
    // Non-Tesla preserves baseMs verbatim
    expect(resolveAdaptiveTimeoutMs(3500, DESKTOP_CHROME_UA)).toBe(3500);
    expect(resolveAdaptiveTimeoutMs(6500, MOBILE_SAFARI_UA)).toBe(6500);
    expect(resolveAdaptiveTimeoutMs(0, DESKTOP_CHROME_UA)).toBe(0);

    // Tesla scales to >= 10s (and up to 20s cap without shrinking >20s overrides)
    expect(resolveAdaptiveTimeoutMs(3500, TESLA_CHROMIUM_UA)).toBe(TESLA_MIN_TIMEOUT_MS);
    expect(resolveAdaptiveTimeoutMs(5000, TESLA_CHROMIUM_UA)).toBe(10_000);
    expect(resolveAdaptiveTimeoutMs(6500, TESLA_CHROMIUM_UA)).toBe(13_000);
    expect(resolveAdaptiveTimeoutMs(8000, TESLA_QT_UA)).toBe(16_000);
    expect(resolveAdaptiveTimeoutMs(15_000, TESLA_CHROMIUM_UA)).toBe(20_000);
    expect(resolveAdaptiveTimeoutMs(25_000, TESLA_CHROMIUM_UA)).toBe(25_000);
  });

  it('purgeServiceWorkersAndCaches safely unregisters all SWs and deletes all Cache Storage buckets', async () => {
    const unreg1 = vi.fn(async () => true);
    const unreg2 = vi.fn(async () => true);
    const deletedKeys: string[] = [];

    vi.stubGlobal('navigator', {
      userAgent: TESLA_CHROMIUM_UA,
      serviceWorker: {
        getRegistrations: vi.fn(async () => [{ unregister: unreg1 }, { unregister: unreg2 }]),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => ['krunked-skymap-v4', 'krunked-skymap-v5', 'krunked-skymap-v6']),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
        return true;
      }),
    });

    const result = await purgeServiceWorkersAndCaches();
    expect(result).toEqual({ unregisteredWorkers: 2, deletedCaches: 3 });
    expect(unreg1).toHaveBeenCalledTimes(1);
    expect(unreg2).toHaveBeenCalledTimes(1);
    expect(deletedKeys).toEqual(['krunked-skymap-v4', 'krunked-skymap-v5', 'krunked-skymap-v6']);

    // Resilient when APIs throw SecurityError / missing
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: vi.fn(async () => {
          throw new Error('SecurityError');
        }),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => {
        throw new Error('QuotaExceededError');
      }),
    });
    await expect(purgeServiceWorkersAndCaches()).resolves.toEqual({
      unregisteredWorkers: 0,
      deletedCaches: 0,
    });
  });

  it('buildCacheBustedReloadUrl preserves path, query params, and hash while replacing _refresh', () => {
    const withHash = buildCacheBustedReloadUrl(
      'https://krunked-fpv.github.io/krunked_skymap/?foo=bar#lat=38.85&lon=-77.04',
      1760000001234
    );
    expect(withHash).toBe(
      'https://krunked-fpv.github.io/krunked_skymap/?foo=bar&_refresh=1760000001234#lat=38.85&lon=-77.04'
    );

    const replaced = buildCacheBustedReloadUrl(withHash, 1760000009999);
    expect(replaced).toBe(
      'https://krunked-fpv.github.io/krunked_skymap/?foo=bar&_refresh=1760000009999#lat=38.85&lon=-77.04'
    );
  });

  it('forceHardReloadWithCacheBust purges SW/caches first and navigates via location.replace with _refresh', async () => {
    const unregister = vi.fn(async () => true);
    const deleteCache = vi.fn(async () => true);
    const replaceSpy = vi.fn();

    vi.stubGlobal('navigator', {
      userAgent: TESLA_CHROMIUM_UA,
      serviceWorker: {
        getRegistrations: vi.fn(async () => [{ unregister }]),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => ['krunked-skymap-v5']),
      delete: deleteCache,
    });
    vi.stubGlobal('window', {
      location: {
        href: 'https://krunked-fpv.github.io/krunked_skymap/#r=120',
        replace: replaceSpy,
      },
    });

    const res = await forceHardReloadWithCacheBust({ nowMs: 123456789 });
    expect(res).toEqual({ unregisteredWorkers: 1, deletedCaches: 1 });
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(deleteCache).toHaveBeenCalledWith('krunked-skymap-v5');
    expect(replaceSpy).toHaveBeenCalledWith(
      'https://krunked-fpv.github.io/krunked_skymap/?_refresh=123456789#r=120'
    );
  });

  it('bootstrapRuntimeServiceWorker skips SW registration & purges caches on Tesla, and registers with updateViaCache:none on desktop', async () => {
    // 1. Tesla browser without active controller -> unregisters & purges, NEVER registers, no reload loop
    const registerTesla = vi.fn();
    const unregisterTesla = vi.fn(async () => true);
    const deleteTesla = vi.fn(async () => true);
    const replaceTesla = vi.fn();
    const sessionMap = new Map<string, string>();

    vi.stubGlobal('navigator', {
      userAgent: TESLA_CHROMIUM_UA,
      serviceWorker: {
        controller: null,
        register: registerTesla,
        getRegistrations: vi.fn(async () => [{ unregister: unregisterTesla }]),
      },
    });
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => ['krunked-skymap-v5']),
      delete: deleteTesla,
    });
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        href: 'https://krunked-fpv.github.io/krunked_skymap/',
        replace: replaceTesla,
      },
      sessionStorage: {
        getItem: (k: string) => sessionMap.get(k) ?? null,
        setItem: (k: string, v: string) => sessionMap.set(k, v),
      },
    });

    await expect(bootstrapRuntimeServiceWorker()).resolves.toBe('purged-tesla');
    expect(registerTesla).not.toHaveBeenCalled();
    expect(unregisterTesla).toHaveBeenCalledTimes(1);
    expect(deleteTesla).toHaveBeenCalledWith('krunked-skymap-v5');
    expect(replaceTesla).not.toHaveBeenCalled();

    // 2. Tesla browser WITH stale SW controller -> single guarded cache-busted reload
    vi.stubGlobal('navigator', {
      userAgent: TESLA_QT_UA,
      serviceWorker: {
        controller: { scriptURL: 'https://krunked-fpv.github.io/krunked_skymap/sw.js' },
        register: registerTesla,
        getRegistrations: vi.fn(async () => [{ unregister: unregisterTesla }]),
      },
    });
    await expect(bootstrapRuntimeServiceWorker({ nowMs: 999 })).resolves.toBe('purged-tesla');
    expect(replaceTesla).toHaveBeenCalledTimes(1);
    expect(replaceTesla).toHaveBeenCalledWith(
      'https://krunked-fpv.github.io/krunked_skymap/?_refresh=999'
    );
    expect(sessionMap.get(TESLA_SW_PURGE_RELOAD_KEY)).toBe('1');

    // Second boot in same session must NOT reload again
    await expect(bootstrapRuntimeServiceWorker({ nowMs: 1000 })).resolves.toBe('purged-tesla');
    expect(replaceTesla).toHaveBeenCalledTimes(1);

    // 3. Desktop Chrome -> registers ./sw.js with updateViaCache:'none' and calls update()
    const updateSpy = vi.fn(async () => {});
    const registerDesktop = vi.fn(async () => ({ update: updateSpy }));
    vi.stubGlobal('navigator', {
      userAgent: DESKTOP_CHROME_UA,
      serviceWorker: {
        register: registerDesktop,
      },
    });
    vi.stubGlobal('window', {
      location: {
        protocol: 'https:',
        href: 'https://krunked-fpv.github.io/krunked_skymap/',
      },
    });

    await expect(bootstrapRuntimeServiceWorker()).resolves.toBe('registered');
    expect(registerDesktop).toHaveBeenCalledWith('./sw.js', {
      scope: './',
      updateViaCache: 'none',
    });
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });
});

describe('httpClient & telemetry services — cache:no-store, zero CORS preflight headers, adaptive timeouts & recovery', () => {
  beforeEach(() => {
    clearFlightsServiceCache();
    clearBalloonsCache();
    clearTleCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defaults fetchWithTimeout and fetchTextWithTimeout to cache:no-store & cross-origin credentials:omit with zero custom headers', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('window', { location: { origin: 'https://krunked-fpv.github.io', hostname: 'krunked-fpv.github.io' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), init });
        return new Response('{"ok":true}', { status: 200 });
      })
    );

    await fetchWithTimeout('https://r.jina.ai/https://api.adsb.lol/v2/mil?_=1');
    await fetchTextWithTimeout('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle');
    await fetchJsonWithTimeout('https://api.v2.sondehub.org/sondes?lat=38.85&lon=-77.04');
    await fetchTextWithTimeout('./data/tle/stations.tle');

    // Cross-origin relay/text fetches: cache:'no-store', credentials:'omit', NO custom headers (no Cache-Control/Pragma!)
    expect(captured[0].init?.cache).toBe('no-store');
    expect(captured[0].init?.credentials).toBe('omit');
    expect(captured[0].init?.headers).toBeUndefined();

    expect(captured[1].init?.cache).toBe('no-store');
    expect(captured[1].init?.credentials).toBe('omit');
    expect(captured[1].init?.headers).toBeUndefined();

    // Cross-origin JSON fetch: cache:'no-store', credentials:'omit', ONLY safelisted Accept header (no Cache-Control/Pragma)
    expect(captured[2].init?.cache).toBe('no-store');
    expect(captured[2].init?.credentials).toBe('omit');
    const jsonHeaders = captured[2].init?.headers as Record<string, string>;
    expect(jsonHeaders).toEqual({ Accept: 'application/json' });
    expect(jsonHeaders['Cache-Control']).toBeUndefined();
    expect(jsonHeaders['Pragma']).toBeUndefined();

    // Same-origin relative asset: cache:'no-store', credentials left default (undefined)
    expect(captured[3].init?.cache).toBe('no-store');
    expect(captured[3].init?.credentials).toBeUndefined();
    expect(captured[3].init?.headers).toBeUndefined();
  });

  it('uses adaptive >=10s timeouts on Tesla UA across flights, global military, balloons, satellites, and airspace', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { userAgent: TESLA_CHROMIUM_UA, onLine: true });
    vi.stubGlobal('window', {
      location: { origin: 'https://krunked-fpv.github.io', hostname: 'krunked-fpv.github.io' },
    });

    // Simulate a slow 7.5s LTE response on r.jina.ai (would have timed out at 6.5s on desktop!)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const url = String(input);
            const timer = setTimeout(() => {
              if (url.startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
                resolve(
                  new Response(
                    JSON.stringify({
                      aircraft: [
                        {
                          hex: 'a12345',
                          flight: 'TSLA1',
                          lat: 38.86,
                          lon: -77.05,
                          alt_baro: 10000,
                          gs: 250,
                          track: 90,
                          seen_pos: 2,
                        },
                      ],
                    }),
                    { status: 200 }
                  )
                );
              } else {
                resolve(new Response('Not mocked', { status: 503 }));
              }
            }, 7500);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const promise = fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    await vi.advanceTimersByTimeAsync(8000);
    const res = await promise;
    expect(res.status).toBe('live');
    expect(res.provider).toBe('cors-relay:adsb.fi');
    expect(res.entities.map((e) => e.callsign)).toEqual(['TSLA1']);

    // Verify SondeHub / ArcGIS / CelesTrak also survive a 7s Tesla cellular RTT without timing out
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const url = String(input);
            const timer = setTimeout(() => {
              if (url.includes('sondehub.org/sondes')) {
                resolve(
                  new Response(
                    JSON.stringify([
                      { serial: 'TSLA-SONDE', lat: 38.9, lon: -77.01, alt: 12000, vel_v: 4, vel_h: 15 },
                    ]),
                    { status: 200 }
                  )
                );
              } else if (url.includes('sondehub.org/amateur')) {
                resolve(new Response(JSON.stringify({}), { status: 200 }));
              } else if (url.includes('arcgis.com')) {
                resolve(
                  new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
                    status: 200,
                  })
                );
              } else if (url.includes('celestrak.org')) {
                resolve(
                  new Response(
                    'ISS (ZARYA)\n1 25544U 98067A   26324.51234567  .00016717  00000-0  10270-3 0  9005\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
                    { status: 200 }
                  )
                );
              } else {
                resolve(new Response('Err', { status: 503 }));
              }
            }, 7000);
            init?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const [balloonP, airspaceP, tleP] = [
      fetchBalloons(DCA_OBSERVER, 120, undefined, { scope: 'local', includeWindBorne: false }),
      fetchAirspace(DCA_OBSERVER, 120),
      refreshTlesIfStale(true),
    ];
    await vi.advanceTimersByTimeAsync(7500);
    const [balloonRes, airspaceRes, tleRes] = await Promise.all([balloonP, airspaceP, tleP]);
    expect(balloonRes.status).toBe('live');
    expect(balloonRes.entities.map((e) => e.serial)).toEqual(['TSLA-SONDE']);
    expect(airspaceRes.status).toBe('live');
    expect(tleRes.status).toBe('live');
    expect(tleRes.records.length).toBeGreaterThan(0);
  });

  it('uses distinct per-request relay cache-busters on Tesla browser and forced retries without breaking URLs or adding preflight headers', async () => {
    vi.stubGlobal('navigator', { userAgent: TESLA_CHROMIUM_UA, onLine: true });
    vi.stubGlobal('window', {
      location: { origin: 'https://krunked-fpv.github.io', hostname: 'krunked-fpv.github.io' },
    });

    const seenRelayCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://r.jina.ai/')) {
          seenRelayCalls.push({ url, init });
          return new Response(
            JSON.stringify({
              ac: [
                {
                  hex: 'ae1001',
                  flight: 'RCH01',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 25000,
                  gs: 400,
                  track: 90,
                  seen_pos: 2,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    vi.useFakeTimers();
    vi.setSystemTime(1_760_000_000_100);
    await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });

    vi.setSystemTime(1_760_000_000_600); // Only 500ms later (same 10s bucket, different ms!)
    await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    await fetchGlobalSpecialFlights(DCA_OBSERVER, undefined, { force: true });

    expect(seenRelayCalls.length).toBeGreaterThanOrEqual(5);
    expect(seenRelayCalls[0].url).toContain('?_=1760000000100');
    expect(seenRelayCalls[1].url).toContain('?_=1760000000600');
    expect(seenRelayCalls[0].url).not.toBe(seenRelayCalls[1].url);

    for (const call of seenRelayCalls) {
      expect(call.init?.cache).toBe('no-store');
      expect(call.init?.credentials).toBe('omit');
      expect(call.init?.headers).toBeUndefined();
    }
  });

  it('recovers CircuitBreaker & TokenBucketRateLimiter cleanly from backwards NTP clock jumps and external AbortSignal cancellations', async () => {
    // 1. Backwards clock jump on wake must immediately release open breaker & rate-limiter cooldown
    let now = 1_760_000_100_000;
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
      nowFn: () => now,
    });
    breaker.recordFailure('feed', new Error('err1'));
    breaker.recordFailure('feed', new Error('err2'));
    expect(breaker.getState('feed')).toBe('open');

    // Clock jumps backwards by 2 minutes (e.g. car MCU NTP re-sync after sleep)
    now -= 120_000;
    expect(breaker.getState('feed')).toBe('half-open');
    await expect(breaker.execute(async () => 'live', 'feed')).resolves.toBe('live');
    expect(breaker.getState('feed')).toBe('closed');

    const limiter = new TokenBucketRateLimiter({
      minIntervalMs: 10_000,
      capacity: 1,
      nowFn: () => now,
    });
    expect(limiter.tryConsume('adsb')).toBe(true);
    expect(limiter.tryConsume('adsb')).toBe(false);
    now -= 60_000; // Backward jump
    expect(limiter.tryConsume('adsb')).toBe(true);

    // 2. External caller AbortSignal cancellation must NOT trip CircuitBreaker or poison half-open probe
    vi.stubGlobal('window', {
      location: { origin: 'https://krunked-fpv.github.io', hostname: 'krunked-fpv.github.io' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const extBreaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000 });
    const abortCtrl = new AbortController();
    const pending = extBreaker.execute(
      () => fetchTextWithTimeout('https://r.jina.ai/https://opendata.adsb.fi/api/v3/lat/0/lon/0/dist/10', { signal: abortCtrl.signal }),
      'adsb-fi'
    );
    abortCtrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(extBreaker.getState('adsb-fi')).toBe('closed');

    // 3. resetBreakers:true recovers immediately even without explicit force:true after a failed cooldown
    clearFlightsServiceCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unavailable', { status: 503 }))
    );
    const failed = await fetchFlightsCascade(DCA_OBSERVER, 120);
    expect(failed.status).toBe('error');

    // Trip breaker completely
    await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, { force: true });
    expect(flightsCircuitBreaker.getState('cors-relay-adsb-fi')).toBe('open');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('https://r.jina.ai/https://opendata.adsb.fi/')) {
          return new Response(
            JSON.stringify({
              aircraft: [
                {
                  hex: 'a99111',
                  flight: 'RECOV1',
                  lat: 38.86,
                  lon: -77.05,
                  alt_baro: 8000,
                  gs: 220,
                  track: 180,
                  seen_pos: 1,
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response('Down', { status: 503 });
      })
    );

    const recovered = await fetchFlightsCascade(DCA_OBSERVER, 120, undefined, {
      resetBreakers: true,
    });
    expect(recovered.status).toBe('live');
    expect(recovered.entities.map((e) => e.callsign)).toEqual(['RECOV1']);
  });
});

interface NodeFsSubset {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

interface NodeVmSubset {
  runInNewContext(code: string, context: Record<string, unknown>): unknown;
}

async function loadNodeFs(): Promise<NodeFsSubset> {
  const mod = 'node:fs';
  return (await import(/* @vite-ignore */ mod)) as NodeFsSubset;
}

async function loadNodeVm(): Promise<NodeVmSubset> {
  const mod = 'node:vm';
  return (await import(/* @vite-ignore */ mod)) as NodeVmSubset;
}

describe('public/sw.js v6 — networkFirst cache:no-store, v5 pruning & cross-origin bypass', () => {
  it('uses krunked-skymap-v6, prunes v1-v5 on activate, fetches shell with cache:no-store, and bypasses live telemetry', async () => {
    const fs = await loadNodeFs();
    const vm = await loadNodeVm();
    const swSource = fs.readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');

    expect(swSource).toContain("const CACHE_VERSION = 'krunked-skymap-v6'");

    const listeners = new Map<string, (ev: unknown) => void>();
    const deletedCaches: string[] = [];
    const openedCaches = new Map<string, Map<string, Response>>();
    const fetchCalls: Array<{ input: unknown; init?: RequestInit }> = [];

    const mockFetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      fetchCalls.push({ input, init });
      return new Response('<html>fresh-shell</html>', { status: 200 });
    });

    const sandboxSelf = {
      location: {
        origin: 'https://krunked-fpv.github.io',
        href: 'https://krunked-fpv.github.io/krunked_skymap/sw.js',
      },
      addEventListener(type: string, cb: (ev: unknown) => void) {
        listeners.set(type, cb);
      },
      skipWaiting: vi.fn(async () => {}),
      clients: { claim: vi.fn(async () => {}) },
    };

    const sandboxCaches = {
      async open(name: string) {
        let store = openedCaches.get(name);
        if (!store) {
          store = new Map<string, Response>();
          openedCaches.set(name, store);
        }
        return {
          async add(req: Request | string) {
            store!.set(typeof req === 'string' ? req : req.url, new Response('precached', { status: 200 }));
          },
          async put(req: Request | string, res: Response) {
            store!.set(typeof req === 'string' ? req : req.url, res);
          },
        };
      },
      async keys() {
        return [
          'krunked-skymap-v1',
          'krunked-skymap-v2',
          'krunked-skymap-v3',
          'krunked-skymap-v4',
          'krunked-skymap-v5',
          'krunked-skymap-v6',
        ];
      },
      async delete(key: string) {
        deletedCaches.push(key);
        return true;
      },
      async match() {
        return undefined;
      },
    };

    vm.runInNewContext(swSource, {
      self: sandboxSelf,
      caches: sandboxCaches,
      fetch: mockFetch,
      URL,
      Request,
      Response,
      Promise,
    });

    // Activate prunes v1..v5 and preserves v6
    const activateTasks: Array<Promise<unknown>> = [];
    listeners.get('activate')?.({
      waitUntil(p: Promise<unknown>) {
        activateTasks.push(p);
      },
    });
    await Promise.all(activateTasks);
    expect(deletedCaches).toEqual([
      'krunked-skymap-v1',
      'krunked-skymap-v2',
      'krunked-skymap-v3',
      'krunked-skymap-v4',
      'krunked-skymap-v5',
    ]);
    expect(deletedCaches).not.toContain('krunked-skymap-v6');

    // Navigation fetch uses URL string + { cache: 'no-store', credentials: 'same-origin' }
    const fetchListener = listeners.get('fetch')!;
    const navRespondWith = vi.fn();
    fetchListener({
      request: {
        method: 'GET',
        cache: 'default',
        mode: 'navigate',
        destination: 'document',
        url: 'https://krunked-fpv.github.io/krunked_skymap/index.html',
      },
      respondWith: navRespondWith,
    });
    expect(navRespondWith).toHaveBeenCalledTimes(1);
    await navRespondWith.mock.calls[0][0];
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].input).toBe('https://krunked-fpv.github.io/krunked_skymap/index.html');
    expect(fetchCalls[0].init).toEqual({
      cache: 'no-store',
      credentials: 'same-origin',
    });

    // Cross-origin, /api-proxy/, and same-origin .json (non-manifest) still strictly bypass SW
    const bypassUrls = [
      'https://r.jina.ai/https://opendata.adsb.fi/api/v3/lat/38.85/lon/-77.04/dist/65?_=123',
      'https://api.adsb.lol/v2/mil',
      'https://api.v2.sondehub.org/sondes?lat=38.85&lon=-77.04',
      'https://krunked-fpv.github.io/krunked_skymap/api-proxy/adsb-fi/api/v3/lat/38.85/lon/-77.04/dist/65',
      'https://krunked-fpv.github.io/krunked_skymap/data/windborne-balloons.json',
    ];
    for (const url of bypassUrls) {
      const respondWith = vi.fn();
      fetchListener({
        request: { method: 'GET', cache: 'default', mode: 'cors', url },
        respondWith,
      });
      expect(respondWith, `SW must bypass ${url}`).not.toHaveBeenCalled();
    }
  });
});

