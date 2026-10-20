'use strict';
// bills36 service worker.
// It keeps the app shell (page, styles, script, fonts, icons) so the app opens instantly and
// still opens with no connection. Expense data always comes from the server and is never cached here.

const VERSION = 'bills36-v1';
const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg',
  '/fonts/bricolage-grotesque-latin-700-normal.woff2',
  '/fonts/bricolage-grotesque-latin-800-normal.woff2',
  '/fonts/dm-sans-latin-400-normal.woff2',
  '/fonts/dm-sans-latin-500-normal.woff2',
  '/fonts/dm-sans-latin-700-normal.woff2',
  '/fonts/ibm-plex-mono-latin-400-normal.woff2',
  '/fonts/ibm-plex-mono-latin-500-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // data goes straight to the network

  // Fonts and icons never change under the same name: cache first.
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => store(req, res)))
    );
    return;
  }

  // Everything else: try the network so updates arrive, fall back to the saved copy offline.
  event.respondWith(
    fetch(req)
      .then((res) => store(req, res))
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error()))
      )
  );
});

function store(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then((cache) => cache.put(req, copy));
  }
  return res;
}
