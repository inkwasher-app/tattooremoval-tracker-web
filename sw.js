/**
 * Offline shell for Tattoo Removal Tracker (web).
 * Caches the app shell (page, styles, scripts, icon) so the site
 * opens offline; the library itself lives in IndexedDB and the API
 * is always network-first — this worker never caches API traffic.
 */
const CACHE = "trt-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./assets/css/app.css",
  "./assets/js/app.js",
  "./assets/js/api.js",
  "./assets/js/config.js",
  "./assets/js/db.js",
  "./assets/js/downloads.js",
  "./assets/js/labels.js",
  "./assets/js/sync.js",
  "./assets/vendor/jszip.min.js",
  "./assets/icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // API + Google: network only
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ??
        fetch(event.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return res;
        }),
    ),
  );
});
