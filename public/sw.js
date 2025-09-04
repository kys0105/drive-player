// public/sw.js
const CACHE_NAME = 'audio-v1';

self.addEventListener('install', (event) => {
  // 旧キャッシュ掃除（必要に応じて）
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    })()
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// stream エンドポイントのみ cache-first。
// Range リクエストはキャッシュしない（206 を断片保存しないため）。
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (!url.pathname.startsWith('/.netlify/functions/stream/')) return;

  const isRange = req.headers.has('range');
  if (isRange) {
    // 部分取得は常にネットワークへ
    event.respondWith(fetch(req));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;

      const res = await fetch(req);
      // 200/OK で v= が付いてるリクエストだけ保存
      if (res && res.ok && url.searchParams.get('v')) {
        cache.put(req, res.clone());
      }
      return res;
    })()
  );
});
