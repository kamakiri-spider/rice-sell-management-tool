// オフラインでも使えるようにアプリ本体だけをキャッシュします（受注データは扱いません）
const CACHE = 'rice-orders-v6';
const ASSETS = [
  './', './index.html', './css/style.css', './js/app.js', './js/data.js', './js/vault.js',
  './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// ネット優先・失敗したらキャッシュ（更新を取り込みつつ圏外でも動く）
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(async (res) => {
        // 公開ページが止まって 404 などになっても、保存済みの正常なアプリ本体を使い続ける
        if (!res.ok) return (await caches.match(e.request, { ignoreSearch: true })) || res;
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
