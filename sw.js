// Offline support: the last version loaded online keeps working without a connection.
// Bump VERSION when files are added or removed.
const VERSION = "flightlist-v1";
const FILES = ["./", "index.html", "styles.css", "core.js", "app.js", "checklists.js",
               "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  // Network first so edits show up right away; the cache is the offline fallback.
  e.respondWith(caches.open(VERSION).then((cache) =>
    fetch(e.request)
      .then((res) => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      })
      .catch(() => cache.match(e.request, { ignoreSearch: true }))));
});
