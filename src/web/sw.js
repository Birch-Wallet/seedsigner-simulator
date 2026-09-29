/*
 * Offline cache for the SeedSigner simulator.
 *
 * The page already claims you can pull the plug once it has loaded; this makes
 * that true across a restart, and takes the 26MB Pyodide download off every
 * visit after the first.
 *
 * Two rules, because the payload splits cleanly in two:
 *   - Pyodide, zxing-wasm and the other languages' fonts are large and
 *     immutable: each sits in a directory named by a hash of what is in it.
 *     Cache-first, fetched once and kept until VERSION changes.
 *   - The pages and our own scripts change every deploy. Network-first, so a
 *     deploy is visible on the next load rather than whenever the cache expires.
 *
 * Nothing cross-origin and nothing but GET is touched. Same-origin cached
 * responses keep their headers, so COOP/COEP survive and the page stays
 * crossOriginIsolated, without which the sim silently dies, since the worker
 * blocks inside SeedSigner's controller loop and SharedArrayBuffer is the only
 * channel that can reach it.
 */
// Not bumped when the list below only grows, and that is deliberate. The cache
// is named after VERSION and activate deletes every other one, so a bump would
// throw away the immutable half too if activate did not carry it across. A
// changed file here is enough to install this worker again, and install adds
// the new entries to the cache that is already there. Bump it when something
// cached must be thrown away, not when something new is added.
// v11: the page was stripped down to stock SeedSigner alone.
const VERSION = "sim-v12";
const CACHE = "seedsignersim-" + VERSION;

// Small enough to fetch up front so a first-run offline load still works.
const SHELL = [
  "./",
  "./index.html",
  "./worker.js",
  "./camera.js",
  "./seedsigner-device.js",
  "./jsQR.js",
  "./mp4-muxer.js",
  "./recorder.js",
  "./browser_camera.py",
  "./browser_display.py",
  "./browser_threads.py",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

// Genuinely immutable things only: paths that carry a hash of what is in them,
// so changing the bytes changes the URL. The firmware zips are not among them:
// each is rebuilt whenever the Python side changes, and cache-first with no
// revalidation would keep a returning visitor on the old firmware forever while
// handing them fresh JS around it.
const IMMUTABLE = /\/(pyodide-[0-9a-f]{8}\/|zxing-[0-9a-f]{8}\/|fonts-[0-9a-f]{8}\/)/;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One at a time: addAll rejects the whole install if a single URL 404s,
    // and a stale entry in this list should not cost us the service worker.
    await Promise.all(SHELL.map((url) =>
      cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const mine = await caches.open(CACHE);
    for (const name of await caches.keys()) {
      if (!name.startsWith("seedsignersim-") || name === CACHE) continue;
      const old = await caches.open(name);
      // The immutable half moves across rather than being re-fetched. It is
      // twenty-six megabytes of Pyodide that is versioned in its own path and
      // cannot go stale, and making a version bump cost that download is
      // precisely what made a version bump the thing nobody was willing to do
      // -- which is how a visitor ends up holding a script from three deploys
      // ago with no way to shake it loose. Bumping has to be cheap, or the one
      // lever this worker has for throwing something away is a lever nobody
      // pulls.
      for (const req of await old.keys()) {
        if (!IMMUTABLE.test(new URL(req.url).pathname)) continue;
        if (await mine.match(req)) continue;
        const hit = await old.match(req);
        if (hit) await mine.put(req, hit);
      }
      await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (IMMUTABLE.test(url.pathname)) {
    event.respondWith((async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
