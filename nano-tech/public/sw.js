// Keeps both apps opening offline. Same-origin pages only: Ecwid and Slack calls are never touched.
const V = 'nano-v5', FILES = ['index.html', 'tracker.html', 'app.webmanifest', 'tracker.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(V).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;   // never store job data in the cache
  e.respondWith(fetch(r).then(res => { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); return res; })   // online: always the latest version
    .catch(() => caches.match(r, {ignoreSearch: true})));                                                                  // offline: the saved copy
});
