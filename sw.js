// Service worker: rende l'app installabile e utilizzabile offline.
// Strategia network-first per i file dell'app: online prende sempre l'ultima versione,
// offline usa la copia in cache. Le chiamate alle API (Gemini, Groq, GitHub) non passano dalla cache.
const CACHE = 'english-tutor-v14';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/store.js',
  'js/db.js',
  'js/srs.js',
  'js/ai.js',
  'js/importer.js',
  'js/sync.js',
  'js/i18n.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // cache: 'no-cache' chiede sempre al server se c'è una versione nuova
  // (GitHub Pages altrimenti lascia usare la copia del browser per 10 minuti).
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
  );
});
