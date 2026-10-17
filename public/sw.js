// Service worker: keeps the app itself on the phone so it opens instantly, with or without signal.
//
// The server fills in the two placeholders below when it serves this file: VERSION changes
// whenever any app file changes, and SHELL lists those files. A new VERSION makes the phone
// download the new files in the background and switch to them on the next launch.
const VERSION = '__VERSION__';
const SHELL = [/*__SHELL__*/];

const SHELL_CACHE = `plate-shell-${VERSION}`;
const PHOTO_CACHE = 'plate-exercise-photos';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // 'reload' skips the browser's own cache, so a new version never stores stale files.
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith('plate-shell-') && name !== SHELL_CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function fromShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  return (await cache.match(request, { ignoreSearch: true })) || fetch(request);
}

async function exercisePhoto(request) {
  const cache = await caches.open(PHOTO_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Your data always comes straight from the server; the app keeps its own offline copy of it.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/exercises/img/')) {
    event.respondWith(exercisePhoto(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(fromShell(new Request('/')));
  } else {
    event.respondWith(fromShell(request));
  }
});
