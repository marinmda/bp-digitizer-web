/* Offline-first. The app is fully usable with no network at all -- readings
   live in IndexedDB, so the only thing the cache has to hold is the shell. */
'use strict';
const VERSION = '__BUILD_VERSION__';
const CACHE = 'bp-shell-' + VERSION;
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/db.js', '/bp.js', '/i18n.js',
               '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png',
               '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    // Locales are fetched on demand; pre-cache only the ones likely needed.
    await c.addAll(['/i18n/en.json']).catch(() => {});
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('bp-shell-') && k !== CACHE)
                          .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;      // never cache the server
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') return cache.match('/index.html');
      throw err;
    }
  })());
});

/* Reminders arrive as push when the optional server is configured. With no
   server the app still works; it simply cannot prompt you. */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || 'BP Digitizer', {
    body: d.body || '', tag: d.tag || 'reminder', renotify: true,
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: d,
    actions: [{ action: 'measure', title: d.action_measure || 'Measure' },
              { action: 'snooze', title: d.action_snooze || 'Snooze 15 min' }],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.action === 'measure' ? '/?add=1' : '/';
  e.waitUntil((async () => {
    if (e.action === 'snooze') {
      await fetch('/api/reminders/snooze', { method: 'POST' }).catch(() => {});
      return;
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) if (new URL(c.url).origin === self.location.origin) return c.focus();
    return self.clients.openWindow(target);
  })());
});
