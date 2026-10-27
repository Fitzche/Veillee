// Cache de l'application : elle se lance même sans réseau (le jeu, lui, a besoin d'Internet ou du Wi-Fi).
// Stratégie « réseau d'abord, sans cache HTTP » : chaque ouverture récupère la dernière version publiée.
const V = 'veillee-1.1.1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'css/style.css', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/app.js', 'js/engine.js', 'js/modes.js', 'js/botc.js', 'js/lg.js', 'js/net.js', 'js/util.js', 'js/rules.js', 'js/simcore.js', 'js/version.js',
  'js/roles/index.js', 'js/roles/custom.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const own = url.origin === location.origin;
  if (!own && !/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.host)) return;
  e.respondWith(fetch(own ? new Request(req, { cache: 'no-cache' }) : req).then((res) => {
    if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(V).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
});
