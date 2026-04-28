const CACHE = 'trl-v2';

// Only cache local assets — no external CDN URLs.
// External URLs (Leaflet, etc.) are cached lazily on first use via the fetch handler.
const PRECACHE = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/icon-512x512.png',
  '/site.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests
  if (e.request.method !== 'GET') return;

  const url = e.request.url;

  // Network-only: analytics, zip lookup, Supabase auth endpoints, CDN edge scripts
  if (
    url.includes('zippopotam.us') ||
    url.includes('googletagmanager') ||
    url.includes('convertkit') ||
    url.includes('cdn-cgi')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first: Supabase API — try live data, fall back to cache
  if (url.includes('supabase.co')) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          try {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          } catch (_) {}
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || Response.error()))
    );
    return;
  }

  // Network-first for HTML navigation requests — ensures fresh page on deploy
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          try {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          } catch (_) {}
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
    );
    return;
  }

  // Cache-first: static assets and CDN resources (Leaflet, Google Fonts, etc.)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        try {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        } catch (_) {}
        return res;
      }).catch(() => Response.error());
    })
  );
});
