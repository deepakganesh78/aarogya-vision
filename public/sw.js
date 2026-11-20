// Offline app shell for the ASHA worker app (/asha; "/" is the doctor's live 3D view). API calls (health data)
// are never cached here; unsent cases live encrypted in IndexedDB instead.
const CACHE = 'av-shell-v12';
// The optional on-phone Gemma helper. Its MediaPipe JS/WASM (~27 MB) is cached on first use, not precached,
// so only workers who opt in download it. Bump GENAI_CACHE when upgrading @mediapipe/tasks-genai.
// The model itself lives in MODEL_CACHE, written by /js/gemma-offline.js, never by this worker.
const GENAI_CACHE = 'av-genai-0.10.30';
const MODEL_CACHE = 'av-gemma-model-v1';
const KEEP = new Set([CACHE, GENAI_CACHE, MODEL_CACHE]);
const SHELL = [
  '/asha',
  '/index.html',
  '/css/app.css',
  '/js/worker-app.js',
  '/js/gemma-offline.js',
  '/js/i18n.js',
  '/js/secure-store.js',
  '/js/media.js',
  '/js/live-speech.js',
  '/js/pcm-worklet.js',
  '/js/dom.js',
  '/js/icons.js',
  '/shared/dangerSigns.js',
  '/shared/triage.js',
  '/shared/skinPatterns.js',
  '/shared/gemmaPrompt.js',
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
const isGenai = (pathname) => pathname.startsWith('/vendor/genai/');

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "The doctor replied" notification: focus the open ASHA app on that visit, or open it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const caseId = event.notification.data?.caseId || null;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const client = list.find((c) => new URL(c.url).pathname === '/asha');
      if (client) {
        client.postMessage({ type: 'open-case', caseId });
        return client.focus();
      }
      return self.clients.openWindow(`/asha${caseId ? `#case=${encodeURIComponent(caseId)}` : ''}`);
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const isShellNavigation = request.mode === 'navigate' && (url.pathname === '/asha' || url.pathname === '/index.html');

  // Self-hosted fonts and the Gemma helper's JS/WASM never change name-for-content, so serve them cache-first.
  if (isFont(url.pathname) || isGenai(url.pathname)) {
    const cacheName = isGenai(url.pathname) ? GENAI_CACHE : CACHE;
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(cacheName).then((cache) => cache.put(request, copy));
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
