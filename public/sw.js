// Audio caches belong to one server-issued session. No offline authentication.
const PRIVATE_CACHE_PREFIX = 'audio-private-v2:';
const LEGACY_CACHE_NAME = 'audio-v1';
let generation = 0;
let writes = Promise.resolve();
const revokedScopes = new Set();

function mutateCache(operation) {
  const pending = writes.then(operation);
  writes = pending.catch(() => {});
  return pending;
}

function failure(status) {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

function isRevoked(requestGeneration, scope) {
  return requestGeneration !== generation || revokedScopes.has(scope);
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await mutateCache(() => caches.delete(LEGACY_CACHE_NAME));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CLEAR_PRIVATE_AUDIO') return;
  // Invalidate requests synchronously, then delete after outstanding puts finish.
  generation += 1;
  if (typeof event.data.cacheScope === 'string') revokedScopes.add(event.data.cacheScope);
  const clearing = mutateCache(async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key === LEGACY_CACHE_NAME || key.startsWith(PRIVATE_CACHE_PREFIX))
        .map((key) => caches.delete(key))
    );
  });
  event.waitUntil(clearing.then(() => event.ports?.[0]?.postMessage({ cleared: true })));
});

async function serveAudio(request, url) {
  const requestGeneration = generation;
  let session;
  try {
    const response = await fetch(new URL('/.netlify/functions/session', self.location.origin), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: request.signal,
    });
    if (response.status === 401) return { response: failure(401) };
    if (response.status !== 200) return { response: failure(503) };
    session = await response.json();
    if (
      session?.authenticated !== true ||
      typeof session.cacheScope !== 'string' ||
      !session.cacheScope ||
      typeof session.expiresAt !== 'number' ||
      !Number.isFinite(session.expiresAt)
    )
      return { response: failure(503) };
    if (session.expiresAt * 1000 <= Date.now()) return { response: failure(401) };
  } catch {
    return { response: failure(503) };
  }
  if (isRevoked(requestGeneration, session.cacheScope)) return { response: failure(401) };

  // Range and HEAD need the origin's headers and must never create cached fragments.
  const canCache =
    request.method === 'GET' && !request.headers.has('range') && Boolean(url.searchParams.get('v'));
  let cache;
  if (canCache) {
    try {
      cache = await caches.open(`${PRIVATE_CACHE_PREFIX}${encodeURIComponent(session.cacheScope)}`);
      const cached = await cache.match(request);
      if (isRevoked(requestGeneration, session.cacheScope)) return { response: failure(401) };
      if (cached?.status === 200) return { response: cached };
    } catch {
      // Storage can be unavailable; authenticated streaming can still use the network.
    }
  }

  let response;
  try {
    response = await fetch(
      new Request(request, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    );
  } catch {
    return { response: failure(503) };
  }
  if (isRevoked(requestGeneration, session.cacheScope)) return { response: failure(401) };

  let finished;
  if (cache && response.status === 200) {
    const copy = response.clone();
    finished = mutateCache(async () => {
      if (!isRevoked(requestGeneration, session.cacheScope)) await cache.put(request, copy);
    }).catch(() => {});
  }
  return { response, finished };
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith('/.netlify/functions/stream/') ||
    (request.method !== 'GET' && request.method !== 'HEAD')
  )
    return;

  const result = serveAudio(request, url);
  event.respondWith(result.then((value) => value.response));
  // Hold the worker alive for full-response writes without delaying audio playback.
  event.waitUntil(result.then((value) => value.finished));
});
