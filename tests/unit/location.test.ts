import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchIpGeolocation,
  GeolocationLookupError,
  requestBrowserGeolocation,
  resolveCurrentGeographicLocation,
  reverseGeocodeLabel,
} from '../../src/services/locationService';
import {
  DEFAULT_SCAN_RADIUS_KM,
  liveKinematicsRegistry,
  PENDING_OBSERVER,
  useSkyStore,
} from '../../src/store/useSkyStore';

function resetStoreToPending() {
  liveKinematicsRegistry.entities.clear();
  liveKinematicsRegistry.rawFlights.clear();
  liveKinematicsRegistry.rawGlobalFlights.clear();
  liveKinematicsRegistry.rawBalloons.clear();
  liveKinematicsRegistry.rawAdsbBalloons.clear();
  liveKinematicsRegistry.rawDrones.clear();
  liveKinematicsRegistry.rawAdsbDrones.clear();
  liveKinematicsRegistry.satellites.clear();
  liveKinematicsRegistry.orbitOverlay = null;
  useSkyStore.getState().selectEntity(null, false);
  useSkyStore.setState({
    observer: { ...PENDING_OBSERVER },
    locationStatus: 'locating',
    locationError: null,
    radiusKm: DEFAULT_SCAN_RADIUS_KM,
    commandPaletteOpen: false,
    odidModalOpen: false,
    diagnosticsOpen: false,
    settingsOpen: false,
    inspectorOpen: false,
    selectedEntitySnapshot: null,
  });
}

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

describe('Live Geographic Location Service & Zero-DC-Default Boot', () => {
  beforeEach(() => {
    resetStoreToPending();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetStoreToPending();
  });

  it('initializes observer state as pending without ever defaulting to Washington DC', () => {
    expect(PENDING_OBSERVER.source).toBe('pending');
    expect(PENDING_OBSERVER.label).not.toMatch(/DC|Potomac/i);
    expect(Math.abs(PENDING_OBSERVER.lat - 38.8512)).toBeGreaterThan(1);
    expect(Math.abs(PENDING_OBSERVER.lon - -77.0402)).toBeGreaterThan(1);

    const st = useSkyStore.getState();
    expect(st.observer.source).toBe('pending');
    expect(st.locationStatus).toBe('locating');

    // updateObserverLabel updates only label for matching fix without bumping recenterNonce
    st.setObserver({
      lat: 47.6062,
      lon: -122.3321,
      altM: 25,
      label: 'Current Location',
      source: 'gps',
    });
    const nonceAfterFix = useSkyStore.getState().recenterNonce;
    useSkyStore.getState().updateObserverLabel(47.6062, -122.3321, 'gps', 'Seattle, WA');
    expect(useSkyStore.getState().observer.label).toBe('Seattle, WA');
    expect(useSkyStore.getState().recenterNonce).toBe(nonceAfterFix);

    // Must NOT overwrite label if observer moved to a different station
    useSkyStore.getState().updateObserverLabel(35.5494, 139.7798, 'gps', 'Tokyo, JP');
    expect(useSkyStore.getState().observer.label).toBe('Seattle, WA');
  });

  it('requestBrowserGeolocation invokes getCurrentPosition directly and retries coarse accuracy on timeout', async () => {
    const getCurrentPosition = vi
      .fn()
      .mockImplementationOnce((_ok: PositionCallback, err: PositionErrorCallback) => {
        err({ code: 3, message: 'Timeout expired' } as GeolocationPositionError);
      })
      .mockImplementationOnce((ok: PositionCallback) => {
        ok({
          coords: {
            latitude: 39.7392,
            longitude: -104.9903,
            altitude: 1609,
            accuracy: 45,
          },
        } as GeolocationPosition);
      });

    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });

    const fix = await requestBrowserGeolocation({
      highAccuracyTimeoutMs: 2000,
      coarseTimeoutMs: 2000,
    });

    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(getCurrentPosition.mock.calls[0][2]).toMatchObject({ enableHighAccuracy: true });
    expect(getCurrentPosition.mock.calls[1][2]).toMatchObject({ enableHighAccuracy: false });
    expect(fix).toMatchObject({
      lat: 39.7392,
      lon: -104.9903,
      altM: 1609,
      source: 'gps',
    });
  });

  it('requestBrowserGeolocation fails fast without retry on PERMISSION_DENIED', async () => {
    const getCurrentPosition = vi.fn((_ok: PositionCallback, err: PositionErrorCallback) => {
      err({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError);
    });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });

    await expect(requestBrowserGeolocation()).rejects.toMatchObject({
      name: 'GeolocationLookupError',
      code: 'PERMISSION_DENIED',
    });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
  });

  it('requestBrowserGeolocation throws UNAVAILABLE when navigator.geolocation is absent', async () => {
    vi.stubGlobal('navigator', {});
    await expect(requestBrowserGeolocation()).rejects.toBeInstanceOf(GeolocationLookupError);
    await expect(requestBrowserGeolocation()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('fetchIpGeolocation cascades across HTTPS CORS providers, rejects Null Island, and never defaults to DC', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.cache).toBe('no-store');
      if (url.includes('geojs.io')) {
        // Broken Null Island payload -> must be rejected
        return new Response(JSON.stringify({ latitude: '0', longitude: '0', city: '' }), {
          status: 200,
        });
      }
      if (url.includes('ipwho.is')) {
        return new Response(JSON.stringify({ success: false, message: 'rate limit' }), {
          status: 200,
        });
      }
      if (url.includes('api.ip.sb')) {
        return new Response('Upstream error', { status: 503 });
      }
      if (url.includes('ipinfo.io')) {
        return new Response(
          JSON.stringify({
            city: 'Austin',
            region: 'Texas',
            country: 'US',
            loc: '30.2672,-97.7431',
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fix = await fetchIpGeolocation({ timeoutMs: 2000 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fix).toMatchObject({
      lat: 30.2672,
      lon: -97.7431,
      label: 'Austin, Texas',
      source: 'ip',
    });

    // When ALL providers fail -> returns null (NEVER DC!)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 }))
    );
    const failedFix = await fetchIpGeolocation({ timeoutMs: 1000 });
    expect(failedFix).toBeNull();
  });

  it('reverseGeocodeLabel resolves BigDataCloud response into concise city/region label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain('bigdatacloud.net/data/reverse-geocode-client');
        return new Response(
          JSON.stringify({
            city: 'Seattle',
            principalSubdivision: 'Washington',
            principalSubdivisionCode: 'US-WA',
            countryCode: 'US',
          }),
          { status: 200 }
        );
      })
    );

    const label = await reverseGeocodeLabel(47.6062, -122.3321);
    expect(label).toBe('Seattle, WA');
  });

  it('resolveCurrentGeographicLocation uses exact GPS immediately without calling IP geo when GPS succeeds quickly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('bigdatacloud.net')) {
        return new Response(
          JSON.stringify({
            city: 'Boulder',
            principalSubdivisionCode: 'US-CO',
            countryCode: 'US',
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected IP geo call: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) => {
          ok({
            coords: { latitude: 40.015, longitude: -105.2705, altitude: 1655, accuracy: 20 },
          } as GeolocationPosition);
        },
      },
    });

    const onFix = vi.fn();
    const onLabelResolved = vi.fn();
    const onUnavailable = vi.fn();

    const cancel = resolveCurrentGeographicLocation(
      { onFix, onLabelResolved, onUnavailable },
      { ipFallbackDelayMs: 1500 }
    );
    await flushMicrotasks(12);
    cancel();

    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix.mock.calls[0][0]).toMatchObject({
      lat: 40.015,
      lon: -105.2705,
      altM: 1655,
      source: 'gps',
    });
    expect(onLabelResolved).toHaveBeenCalledWith(40.015, -105.2705, 'gps', 'Boulder, CO');
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('resolveCurrentGeographicLocation falls back to IP during slow prompt and seamlessly upgrades when GPS resolves', async () => {
    vi.useFakeTimers();

    let deferredGpsSuccess: PositionCallback | null = null;
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (ok: PositionCallback) => {
          deferredGpsSuccess = ok;
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('geojs.io')) {
          return new Response(
            JSON.stringify({
              latitude: '45.5152',
              longitude: '-122.6784',
              city: 'Portland',
              region: 'Oregon',
              country_code: 'US',
            }),
            { status: 200 }
          );
        }
        if (url.includes('bigdatacloud.net')) {
          return new Response(
            JSON.stringify({
              city: 'Beaverton',
              principalSubdivisionCode: 'US-OR',
              countryCode: 'US',
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 404 });
      })
    );

    const onFix = vi.fn();
    const onLabelResolved = vi.fn();
    const onUnavailable = vi.fn();

    const cancel = resolveCurrentGeographicLocation(
      { onFix, onLabelResolved, onUnavailable },
      { ipFallbackDelayMs: 1500 }
    );

    // Before grace period: nothing resolved yet (no DC default!)
    expect(onFix).not.toHaveBeenCalled();

    // Advance past grace timer while permission prompt is still open -> IP fix resolves
    await vi.advanceTimersByTimeAsync(1600);
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix.mock.calls[0][0]).toMatchObject({
      lat: 45.5152,
      lon: -122.6784,
      label: 'Portland, Oregon',
      source: 'ip',
    });

    // User subsequently clicks "Allow" -> exact GPS upgrades the IP fix
    expect(deferredGpsSuccess).not.toBeNull();
    deferredGpsSuccess!({
      coords: { latitude: 45.4871, longitude: -122.8037, altitude: 60, accuracy: 12 },
    } as GeolocationPosition);
    await flushMicrotasks(12);

    expect(onFix).toHaveBeenCalledTimes(2);
    expect(onFix.mock.calls[1][0]).toMatchObject({
      lat: 45.4871,
      lon: -122.8037,
      source: 'gps',
    });
    expect(onLabelResolved).toHaveBeenCalledWith(45.4871, -122.8037, 'gps', 'Beaverton, OR');
    expect(onUnavailable).not.toHaveBeenCalled();

    cancel();
  });

  it('resolveCurrentGeographicLocation reports unavailable without DC fallback when GPS and IP both fail', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) => {
          err({ code: 1, message: 'Permission denied' } as GeolocationPositionError);
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 }))
    );

    const onFix = vi.fn();
    let resolveUnavailable!: (reason: string) => void;
    const unavailablePromise = new Promise<string>((resolve) => {
      resolveUnavailable = resolve;
    });
    const onUnavailable = vi.fn((reason: string) => resolveUnavailable(reason));
    const cancel = resolveCurrentGeographicLocation({ onFix, onUnavailable });
    const reason = await unavailablePromise;
    cancel();

    expect(onFix).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(reason).toContain('Permission denied');
  });

  it('App boot resolves live GPS without DC, ignores legacy DC URL hash, and never freezes live GPS coordinates into window.location.hash', async () => {
    const jsdomMod = (await import('jsdom')) as {
      JSDOM: new (
        html: string,
        opts?: Record<string, unknown>
      ) => { window: Window & typeof globalThis };
    };

    // Simulate a user reloading an old tab/bookmark that still had the legacy auto-written DC hash
    const legacyDcUrl =
      'https://krunked-fpv.github.io/krunked_skymap/#lat=38.8512&lon=-77.0402&alt=12&label=DC+%2F+Potomac+Corridor&r=120&units=metric';
    const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: legacyDcUrl,
    });

    const w = dom.window as unknown as Record<string, unknown>;
    if (typeof w.requestAnimationFrame !== 'function') w.requestAnimationFrame = () => 1;
    if (typeof w.cancelAnimationFrame !== 'function') w.cancelAnimationFrame = () => {};
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    if (!w.ResizeObserver) {
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    const mockGeolocation = {
      getCurrentPosition: vi.fn((ok: PositionCallback) => {
        ok({
          coords: {
            latitude: 39.7392,
            longitude: -104.9903,
            altitude: 1609,
            accuracy: 15,
          },
        } as GeolocationPosition);
      }),
    };
    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: mockGeolocation,
    });

    const fetchedUrls: string[] = [];
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('history', dom.window.history);
    vi.stubGlobal('URL', dom.window.URL);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
    vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.includes('bigdatacloud.net')) {
          return new Response(
            JSON.stringify({
              city: 'Denver',
              principalSubdivisionCode: 'US-CO',
              countryCode: 'US',
            }),
            { status: 200 }
          );
        }
        if (url.includes('.tle')) return new Response('', { status: 200 });
        if (url.includes('windborne')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ ac: [] }), { status: 200 });
      })
    );

    vi.doMock('../../src/components/map/TacticalMap', () => ({ TacticalMap: () => null }));
    vi.doMock('../../src/components/skydome/PolarSkyDome', () => ({ PolarSkyDome: () => null }));

    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../../src/App');

    const container = dom.window.document.getElementById('root')!;
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(App));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      const state = useSkyStore.getState();
      // Legacy DC hash ignored -> live Denver GPS resolved, non-observer preference (units=metric) preserved
      expect(state.observer.source).toBe('gps');
      expect(state.observer.lat).toBeCloseTo(39.7392, 4);
      expect(state.observer.lon).toBeCloseTo(-104.9903, 4);
      expect(state.observer.label).toBe('Denver, CO');
      expect(state.units).toBe('metric');

      // URL hash must NOT freeze lat/lon into the address bar for live GPS location
      expect(dom.window.location.hash).not.toContain('lat=');
      expect(dom.window.location.hash).not.toContain('lon=');
      expect(dom.window.location.hash).not.toContain('38.8512');

      // Zero requests were ever issued for Washington DC coordinates
      const dcRequests = fetchedUrls.filter((u) => u.includes('38.8512') || u.includes('-77.0402'));
      expect(dcRequests).toEqual([]);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
    }
  }, 15_000);

  it('App boot resolves live IP geolocation automatically when browser GPS is denied and never loads DC', async () => {
    const jsdomMod = (await import('jsdom')) as {
      JSDOM: new (
        html: string,
        opts?: Record<string, unknown>
      ) => { window: Window & typeof globalThis };
    };

    const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://krunked-fpv.github.io/krunked_skymap/',
    });

    const w = dom.window as unknown as Record<string, unknown>;
    if (typeof w.requestAnimationFrame !== 'function') w.requestAnimationFrame = () => 1;
    if (typeof w.cancelAnimationFrame !== 'function') w.cancelAnimationFrame = () => {};
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    if (!w.ResizeObserver) {
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) => {
          err({ code: 1, message: 'User denied Geolocation' } as GeolocationPositionError);
        },
      },
    });

    const fetchedUrls: string[] = [];
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('history', dom.window.history);
    vi.stubGlobal('URL', dom.window.URL);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
    vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.includes('geojs.io')) {
          return new Response(
            JSON.stringify({
              latitude: '45.5152',
              longitude: '-122.6784',
              city: 'Portland',
              region: 'Oregon',
              country_code: 'US',
            }),
            { status: 200 }
          );
        }
        if (url.includes('.tle')) return new Response('', { status: 200 });
        if (url.includes('windborne')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ ac: [] }), { status: 200 });
      })
    );

    vi.doMock('../../src/components/map/TacticalMap', () => ({ TacticalMap: () => null }));
    vi.doMock('../../src/components/skydome/PolarSkyDome', () => ({ PolarSkyDome: () => null }));

    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../../src/App');

    const container = dom.window.document.getElementById('root')!;
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(App));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      const state = useSkyStore.getState();
      expect(state.observer.source).toBe('ip');
      expect(state.observer.lat).toBeCloseTo(45.5152, 4);
      expect(state.observer.lon).toBeCloseTo(-122.6784, 4);
      expect(state.observer.label).toBe('Portland, Oregon');
      expect(dom.window.location.hash).not.toContain('lat=');
      expect(dom.window.location.hash).not.toContain('lon=');
      expect(fetchedUrls.some((u) => u.includes('38.8512') || u.includes('-77.0402'))).toBe(false);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
    }
  }, 15_000);

  it('App boot honors explicit shared URL permalinks and allows 1-click return to live current location', async () => {
    const jsdomMod = (await import('jsdom')) as {
      JSDOM: new (
        html: string,
        opts?: Record<string, unknown>
      ) => { window: Window & typeof globalThis };
    };

    const sharedPermalink =
      'https://krunked-fpv.github.io/krunked_skymap/#pin=1&lat=35.5494&lon=139.7798&alt=11&label=Tokyo+Haneda';
    const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: sharedPermalink,
    });

    const w = dom.window as unknown as Record<string, unknown>;
    if (typeof w.requestAnimationFrame !== 'function') w.requestAnimationFrame = () => 1;
    if (typeof w.cancelAnimationFrame !== 'function') w.cancelAnimationFrame = () => {};
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    if (!w.ResizeObserver) {
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    const getCurrentPosition = vi.fn((ok: PositionCallback) => {
      ok({
        coords: {
          latitude: 47.6062,
          longitude: -122.3321,
          altitude: 50,
          accuracy: 10,
        },
      } as GeolocationPosition);
    });
    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition },
    });

    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('history', dom.window.history);
    vi.stubGlobal('URL', dom.window.URL);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
    vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('bigdatacloud.net')) {
          return new Response(
            JSON.stringify({
              city: 'Seattle',
              principalSubdivisionCode: 'US-WA',
              countryCode: 'US',
            }),
            { status: 200 }
          );
        }
        if (url.includes('.tle')) return new Response('', { status: 200 });
        if (url.includes('windborne')) return new Response('[]', { status: 200 });
        return new Response(JSON.stringify({ ac: [] }), { status: 200 });
      })
    );

    vi.doMock('../../src/components/map/TacticalMap', () => ({ TacticalMap: () => null }));
    vi.doMock('../../src/components/skydome/PolarSkyDome', () => ({ PolarSkyDome: () => null }));

    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../../src/App');

    const container = dom.window.document.getElementById('root')!;
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(App));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 80));
      });

      // Explicit permalink respected without overwriting on boot
      expect(useSkyStore.getState().observer.source).toBe('url');
      expect(useSkyStore.getState().observer.label).toBe('Tokyo Haneda');
      expect(getCurrentPosition).not.toHaveBeenCalled();

      // Clicking 1-click My Location crosshair button returns to live GPS location and strips lat/lon from hash
      const locateBtn = container.querySelector(
        '[data-testid="topbar-locate-btn"]'
      ) as HTMLButtonElement | null;
      expect(locateBtn).not.toBeNull();
      await act(async () => {
        locateBtn!.click();
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      expect(getCurrentPosition).toHaveBeenCalledTimes(1);
      expect(useSkyStore.getState().observer.source).toBe('gps');
      expect(useSkyStore.getState().observer.label).toBe('Seattle, WA');
      expect(dom.window.location.hash).not.toContain('lat=');
      expect(dom.window.location.hash).not.toContain('pin=');
    } finally {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
    }
  }, 15_000);

  it('App boot displays Location Required overlay without DC fallback when both GPS and IP geolocation fail', async () => {
    const jsdomMod = (await import('jsdom')) as {
      JSDOM: new (
        html: string,
        opts?: Record<string, unknown>
      ) => { window: Window & typeof globalThis };
    };

    const dom = new jsdomMod.JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'https://krunked-fpv.github.io/krunked_skymap/',
    });

    const w = dom.window as unknown as Record<string, unknown>;
    if (typeof w.requestAnimationFrame !== 'function') w.requestAnimationFrame = () => 1;
    if (typeof w.cancelAnimationFrame !== 'function') w.cancelAnimationFrame = () => {};
    if (!w.matchMedia) {
      w.matchMedia = () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      });
    }
    if (!w.ResizeObserver) {
      w.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }

    Object.defineProperty(dom.window.navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) => {
          err({ code: 1, message: 'Location access denied' } as GeolocationPositionError);
        },
      },
    });

    const fetchedUrls: string[] = [];
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', dom.window.navigator);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('history', dom.window.history);
    vi.stubGlobal('URL', dom.window.URL);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
    vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
    vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.includes('.tle')) return new Response('', { status: 200 });
        return new Response('unavailable', { status: 503 });
      })
    );

    vi.doMock('../../src/components/map/TacticalMap', () => ({ TacticalMap: () => null }));
    vi.doMock('../../src/components/skydome/PolarSkyDome', () => ({ PolarSkyDome: () => null }));

    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { default: App } = await import('../../src/App');

    const container = dom.window.document.getElementById('root')!;
    let root: ReturnType<typeof createRoot> | null = null;

    try {
      await act(async () => {
        root = createRoot(container);
        root.render(React.createElement(App));
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 120));
      });

      const state = useSkyStore.getState();
      expect(state.observer.source).toBe('pending');
      expect(state.locationStatus).toBe('unavailable');
      expect(container.querySelector('[data-testid="location-unavailable-overlay"]')).not.toBeNull();
      expect(container.textContent).not.toContain('DC / Potomac Corridor');

      // Must NOT fire ADS-B / airspace requests while location is pending/unavailable
      const localFeedCalls = fetchedUrls.filter(
        (u) => u.includes('adsb') || u.includes('arcgis') || u.includes('sondehub')
      );
      expect(localFeedCalls).toEqual([]);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      dom.window.close();
    }
  }, 15_000);
});
