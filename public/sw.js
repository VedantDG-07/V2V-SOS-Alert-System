const CACHE_NAME = 'v2v-sos-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/map.html',
  '/history.html',
  '/services.html',
  '/settings.html',
  '/login.html',
  '/register.html',
  '/style.css',
  '/app.js',
  '/firebase-config.js',
  '/env-config.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Fail silently if some assets missing
      });
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  event.waitUntil(self.clients.claim());
});

// Fetch - network first, cache fallback
self.addEventListener('fetch', (event) => {
  // Skip non-GET and Firebase/external requests
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.hostname.includes('firebase') || url.hostname.includes('google') || url.hostname.includes('gstatic')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
