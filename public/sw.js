const CACHE_VERSION = 'krunked-skymap-v2';

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

  // Strictly bypass all cross-origin requests (ADS-B, SondeHub, CelesTrak, ArcGIS, Open-Meteo, Esri tiles)
  if (url.origin !== self.location.origin) {
    return true;
  }

  // Strictly bypass Vite dev/preview live ADS-B proxy routes
  if (url.pathname.includes('/api-proxy/')) {
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
    const networkResponse = await fetch(request);
    if (
      networkResponse &&
      networkResponse.status === 200 &&
      networkResponse.type === 'basic'
    ) {
      try {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, networkResponse.clone());
      } catch {
        // Ignore Cache Storage quota or write errors so live response still returns
      }
    }
    return networkResponse;
  } catch {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    if (request.mode === 'navigate' || request.destination === 'document') {
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
          PRECACHE_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
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
