// Keep Tiles isolated from the portfolio site's root service worker. The root
// worker caches HTML across the whole origin, which can pair an old Tiles page
// with assets from a newer deployment. Tiles pages always go to the network;
// their content-hashed assets can continue to use the browser's HTTP cache.
self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;

  event.respondWith(fetch(request, { cache: 'no-store' }));
});
