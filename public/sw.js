// Offline app shell for the ASHA worker app. API calls (health data) are never cached here;
// unsent cases live encrypted in IndexedDB instead.
const CACHE = 'av-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/worker-app.js',
  '/js/i18n.js',
  '/js/secure-store.js',
  '/js/media.js',
  '/js/dom.js',
  '/js/icons.js',
  '/shared/dangerSigns.js',
  '/shared/triage.js',
  '/vendor/material.js',
  '/vendor/theme.css',
  '/vendor/fonts.css',
  '/vendor/icons.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];
const SHELL_PATHS = new Set(SHELL);
const isFont = (pathname) => pathname.startsWith('/vendor/fonts/');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isShellNavigation = request.mode === 'navigate' && (url.pathname === '/' || url.pathname === '/index.html');

  // Self-hosted fonts never change name-for-content, so serve them cache-first.
  if (isFont(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }
  if (!isShellNavigation && !SHELL_PATHS.has(url.pathname)) return;

  // Network first so updates arrive quickly; fall back to the cached shell when offline.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(isShellNavigation ? '/index.html' : request, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(isShellNavigation ? '/index.html' : request)) || Response.error())
  );
});
