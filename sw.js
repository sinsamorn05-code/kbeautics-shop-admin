// K-BEAUTICS Admin — lets phones install the admin web as an app. Always loads live data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
