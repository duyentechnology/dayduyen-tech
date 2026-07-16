// Service worker for dayduyen.tech
// ---------------------------------------------------------------------------
// Goal: stop card recalls/replays from re-billing Supabase Storage egress.
// Storage media files have immutable, unique URLs, so we serve images
// cache-first from the device. Database reads/writes, auth, and realtime are
// NEVER cached (they must stay live). Video/audio ride the browser's own HTTP
// cache (now long-lived via the upload cacheControl). Any cache error falls
// back to a normal network fetch, so this can never break a request.

const APP_CACHE = 'dayduyen-app-v2';
const MEDIA_CACHE = 'dayduyen-media-v1';
const MEDIA_MAX_ENTRIES = 150; // rough cap; browser also evicts under pressure

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(
        names.filter(n => n !== APP_CACHE && n !== MEDIA_CACHE).map(n => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// A Supabase Storage image request (immutable URL → safe to cache-first).
function isStorageImage(req) {
  return req.method === 'GET'
    && req.url.includes('/storage/v1/object/')
    && (req.destination === 'image' || /\.(png|jpe?g|webp|gif|avif|svg)(?:$|[?#])/i.test(req.url));
}

async function cacheFirstImage(req) {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    // Force a CORS fetch so we get a verifiable 200 we can safely store.
    // Public Supabase buckets send Access-Control-Allow-Origin: *.
    let res;
    try {
      res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    } catch (corsErr) {
      return fetch(req); // bucket w/o CORS or offline → original request, uncached
    }
    if (res && res.status === 200) {
      try {
        await cache.put(req, res.clone());
        await trimCache(MEDIA_CACHE, MEDIA_MAX_ENTRIES);
      } catch (e) {}
    }
    return res;
  } catch (err) {
    return fetch(req); // ultimate fallback — never break the image load
  }
}

async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    const over = keys.length - max;
    for (let i = 0; i < over; i++) await cache.delete(keys[i]); // FIFO eviction
  } catch (e) {}
}

self.addEventListener('fetch', e => {
  const req = e.request;

  // Cache-first only for Storage images. Everything else Supabase (DB REST,
  // auth, realtime, video/audio Range requests) is left to the browser.
  if (isStorageImage(req)) {
    e.respondWith(cacheFirstImage(req));
    return;
  }
  if (req.url.includes('supabase')) return;

  // App shell: network, fall back to cache (unchanged behavior).
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});
