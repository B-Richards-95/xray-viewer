/* Service worker: cache-first app shell, so the viewer opens with no network at all.
 * Bump CACHE whenever any shell file changes — the version string is what evicts the old copy. */
var CACHE = "xray-ipad-v3";

var SHELL = [
  "./",
  "./index.html",
  "./viewer-core.js",
  "./relief-worker.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

// three.js is only needed by the relief tab, so a failure here must not sink the install.
var CDN = ["https://cdnjs.cloudflare.com/ajax/libs/three.js/0.170.0/three.module.min.js"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL).then(function () {
        return Promise.allSettled(
          CDN.map(function (url) { return cache.add(new Request(url, { mode: "cors" })); })
        );
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.map(function (n) { return n === CACHE ? null : caches.delete(n); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  var ours = url.origin === self.location.origin || CDN.indexOf(request.url) !== -1;
  if (!ours) return;

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        // Only a real, complete response is worth keeping; an opaque or error one would
        // pin a broken copy in the cache until the next version bump.
        if (response && response.status === 200 && response.type !== "opaque") {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        // Offline and not cached: a navigation still gets the shell, anything else fails.
        if (request.mode === "navigate") return caches.match("./index.html");
        throw new Error("offline and not cached: " + request.url);
      });
    })
  );
});
