const CACHE_VERSION = 'krunked-skymap-v6';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

function shouldBypassCache(request, url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return true;
  }

  // Strictly bypass all cross-origin requests (ADS-B, WindBorne, SondeHub, CelesTrak, ArcGIS, Open-Meteo, Esri tiles)
  if (url.origin !== self.location.origin) {
    return true;
  }

  // Strictly bypass Vite dev/preview live ADS-B and WindBorne proxy routes
  if (url.pathname.includes('/api-proxy/')) {
    return true;
  }

  // Strictly bypass same-origin JSON data requests (e.g. windborne-balloons.json) except ./manifest.json
  if (url.pathname.endsWith('.json') && !url.pathname.endsWith('/manifest.json')) {
    return true;
  }

  // Strictly bypass Vite HMR / module dev server paths
  const scopePath = new URL('./', self.location.href).pathname;
  const relPath = url.pathname.startsWith(scopePath)
    ? `/${url.pathname.slice(scopePath.length)}`
    : url.pathname;

  if (
    relPath.startsWith('/@') ||
    relPath.startsWith('/src/') ||
    relPath.startsWith('/node_modules/') ||
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/src/') ||
    url.pathname.startsWith('/node_modules/') ||
    url.searchParams.has('t')
  ) {
    return true;
  }

  return false;
}

async function networkFirst(request) {
  try {
    const fetchTarget =
      typeof request === 'string'
        ? request
        : request && typeof request.url === 'string'
          ? request.url
          : request;
    const networkResponse = await fetch(fetchTarget, {
      cache: 'no-store',
      credentials: 'same-origin',
    });

    const isRedirectedNavigation =
      Boolean(networkResponse && networkResponse.redirected) &&
      Boolean(request && (request.mode === 'navigate' || request.destination === 'document'));

    const responseToReturn = isRedirectedNavigation
      ? new Response(networkResponse.body, {
          status: networkResponse.status,
          statusText: networkResponse.statusText,
          headers: networkResponse.headers,
        })
      : networkResponse;

    if (
      networkResponse &&
      networkResponse.status === 200 &&
      networkResponse.type === 'basic'
    ) {
      try {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, responseToReturn.clone());
      } catch {
        // Ignore Cache Storage quota or write errors so live response still returns
      }
    }
    return responseToReturn;
  } catch {
    const cachedResponse =
      (await caches.match(request)) ||
      (request && typeof request.url === 'string'
        ? await caches.match(request.url, { ignoreSearch: true })
        : undefined);
    if (cachedResponse) {
      return cachedResponse;
    }

    if (request && (request.mode === 'navigate' || request.destination === 'document')) {
      const fallbackShell =
        (await caches.match('./index.html')) ||
        (await caches.match('./')) ||
        (await caches.match('./index.html', { ignoreSearch: true }));
      if (fallbackShell) {
        return fallbackShell;
      }
    }

    return Response.error();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'no-store' })))
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event && event.data;
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.type === 'SKIP_WAITING' && typeof self.skipWaiting === 'function') {
    self.skipWaiting();
  } else if (data.type === 'PURGE_CACHES') {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {})
    );
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
    return;
  }

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  if (shouldBypassCache(event.request, url)) {
    return;
  }

  event.respondWith(networkFirst(event.request));
});
