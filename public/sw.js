/* Explicit downloads only. A 30-day allowance starts at an online Cookie check. */
const AUDIO_PREFIX = 'audio-private-v3:';
const META_CACHE = 'drive-private-state-v3';
const SHELL_CACHE = 'drive-shell-v3';
const LEASE_URL = new URL('/__private__/lease', self.location.origin).href;
const OFFLINE_MS = 30 * 24 * 60 * 60 * 1000;
let generation = 0;
let writes = Promise.resolve();
let sessionCheck;
let lastOnlineScope;
const revokedScopes = new Set();

function mutate(operation) {
  const pending = writes.then(operation);
  writes = pending.catch(() => {});
  return pending;
}
function failure(status) { return new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
function audioCache(scope) { return `${AUDIO_PREFIX}${encodeURIComponent(scope)}`; }
function stateUrl(kind, scope) { return new URL(`/__private__/${kind}/${encodeURIComponent(scope)}`, self.location.origin).href; }
async function readJson(url) {
  try { const cache = await caches.open(META_CACHE); return await (await cache.match(url))?.json(); } catch { return null; }
}
async function putJson(url, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(url, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } }));
}
async function broadcast(message) {
  for (const client of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) client.postMessage(message);
}
function validScope(scope) { return typeof scope === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(scope); }
async function lease() {
  const value = await readJson(LEASE_URL);
  const now = Date.now();
  if (!value || !validScope(value.cacheScope) || !Number.isFinite(value.verifiedAt) ||
      !Number.isFinite(value.offlineUntil) || !Number.isFinite(value.lastSeenAt) ||
      value.offlineUntil > value.verifiedAt + OFFLINE_MS || now >= value.offlineUntil ||
      now < value.verifiedAt - 1000 || now < value.lastSeenAt - 1000) return null;
  if (now > value.lastSeenAt + 1000) {
    const expected = generation;
    try { await mutate(async () => {
      const latest = await readJson(LEASE_URL);
      if (generation === expected && latest?.cacheScope === value.cacheScope) {
        await putJson(LEASE_URL, { ...latest, lastSeenAt: Math.max(now, latest.lastSeenAt) });
      }
    }); } catch { return null; }
  }
  return value;
}
async function clearPrivate(scope) {
  generation++;
  if (validScope(scope ?? lastOnlineScope)) revokedScopes.add(scope ?? lastOnlineScope);
  const clearing = mutate(async () => {
    const priorLease = await readJson(LEASE_URL);
    if (!scope && validScope(priorLease?.cacheScope)) revokedScopes.add(priorLease.cacheScope);
    const keys = await caches.keys();
    await Promise.all(keys.filter(name => name === 'audio-v1' || name.startsWith('audio-private-v2:') ||
      (name.startsWith(AUDIO_PREFIX) && (!scope || name === audioCache(scope)))) .map(name => caches.delete(name)));
    const meta = await caches.open(META_CACHE);
    for (const request of await meta.keys()) {
      const path = new URL(request.url).pathname;
      if (path === '/__private__/lease') {
        const current = await readJson(LEASE_URL);
        if (!scope || current?.cacheScope === scope) await meta.delete(request);
      } else if (!scope || path.endsWith(`/${encodeURIComponent(scope)}`)) await meta.delete(request);
    }
    if (!scope || priorLease?.cacheScope === scope) await putJson(LEASE_URL, { blocked: true, cacheScope: priorLease?.cacheScope ?? scope ?? lastOnlineScope });
  });
  let cleared = true;
  try { await clearing; } catch { cleared = false; }
  await broadcast({ type: 'AUTH_REVOKED', cacheScope: scope }).catch(() => {});
  return cleared;
}
async function recordSession(value, expected) {
  const now = Date.now();
  const verifiedAt = typeof value?.serverTime === 'number' ? value.serverTime * 1000 : now;
  const offlineUntil = Math.min(typeof value?.offlineUntil === 'number' ? value.offlineUntil * 1000 : verifiedAt + OFFLINE_MS, verifiedAt + OFFLINE_MS);
  if (value?.authenticated !== true || !validScope(value.cacheScope) || !Number.isFinite(value.expiresAt) ||
      value.expiresAt * 1000 <= now || !Number.isFinite(verifiedAt) || !Number.isFinite(offlineUntil) ||
      offlineUntil <= now || verifiedAt > now + 5 * 60 * 1000 || generation !== expected) return;
  if (revokedScopes.has(value.cacheScope)) return;
  // Useful only for preventing a revoked Cookie from reviving this worker. This
  // never grants offline playback when persistent storage is unavailable.
  lastOnlineScope = value.cacheScope;
  await mutate(async () => {
    if (generation !== expected) return;
    const previous = await readJson(LEASE_URL);
    if (previous?.blocked && previous.cacheScope === value.cacheScope) return;
    if (previous && previous.cacheScope !== value.cacheScope) {
      await caches.delete(audioCache(previous.cacheScope));
      const meta = await caches.open(META_CACHE);
      await meta.delete(stateUrl('catalog', previous.cacheScope));
      await meta.delete(stateUrl('saved', previous.cacheScope));
    }
    await putJson(LEASE_URL, { ...value, verifiedAt, offlineUntil, lastSeenAt: now });
  });
}
async function checkSession() {
  if (sessionCheck) return sessionCheck;
  const expected = generation;
  sessionCheck = (async () => {
    const response = await fetch(new URL('/api/session', self.location.origin), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (generation !== expected) return null;
    if (response.status === 401) { await clearPrivate(); return null; }
    if (response.status !== 200) throw new Error('Session check unavailable');
    await recordSession(await response.json(), expected);
    return lease();
  })().finally(() => { sessionCheck = undefined; });
  return sessionCheck;
}
function audioUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || !/^\/api\/stream\/[A-Za-z0-9_-]+$/.test(url.pathname) || !url.searchParams.get('v')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
async function requireLease(scope) {
  const current = await lease();
  if (!current || current.cacheScope !== scope) throw new Error('保存する前にオンラインでログインを確認してください。');
  return current;
}
async function savedTracks(scope) { return (await readJson(stateUrl('saved', scope))) ?? []; }
async function storeTrack(data) {
  const expected = generation;
  const canonical = audioUrl(data.url);
  await requireLease(data.cacheScope);
  if (!canonical || !(data.blob instanceof Blob) || !data.blob.size || !data.track ||
      typeof data.track.id !== 'string' || typeof data.track.title !== 'string' ||
      new URL(canonical).pathname !== `/api/stream/${encodeURIComponent(data.track.id)}` ||
      new URL(canonical).searchParams.get('v') !== data.track.ver ||
      (Number.isFinite(data.track.size) && data.track.size !== data.blob.size)) throw new Error('音源を完全に保存できませんでした。');
  await mutate(async () => {
    if (generation !== expected) throw new Error('保存は取り消されました。');
    // Do not call requireLease here: lease itself serializes its clock write.
    const current = await readJson(LEASE_URL);
    if (current?.cacheScope !== data.cacheScope || Date.now() >= current.offlineUntil) throw new Error('保存の利用期限が切れました。');
    const cache = await caches.open(audioCache(data.cacheScope));
    await cache.put(canonical, new Response(data.blob, { status: 200, headers: {
      'Content-Type': 'audio/mpeg', 'Content-Length': String(data.blob.size),
      'Cache-Control': 'private, no-store', 'X-Drive-Saved': '1',
    } }));
    try {
      const entries = (await savedTracks(data.cacheScope)).filter(track => track.id !== data.track.id);
      entries.push({ ...data.track, savedUrl: canonical });
      await putJson(stateUrl('saved', data.cacheScope), entries);
    } catch (error) { await cache.delete(canonical); throw error; }
  });
}
async function deleteTrack(data) {
  await mutate(async () => {
    const canonical = audioUrl(data.url);
    if (!canonical || !validScope(data.cacheScope)) return;
    const cache = await caches.open(audioCache(data.cacheScope));
    await cache.delete(canonical);
    await putJson(stateUrl('saved', data.cacheScope), (await savedTracks(data.cacheScope)).filter(track => track.savedUrl !== canonical));
  });
}
async function shellUrls(urls = []) {
  let cache;
  try { cache = await caches.open(SHELL_CACHE); } catch { return false; }
  const targets = ['/', '/manifest.webmanifest', '/icons/app-icon.svg', ...urls];
  const results = await Promise.allSettled(targets.map(async value => {
    const url = new URL(value, self.location.origin);
    if (url.origin !== self.location.origin || (url.pathname !== '/' && !/\.(?:js|css|woff2?|svg|png|jpe?g|webp|webmanifest)$/.test(url.pathname)) || /^\/api\//.test(url.pathname)) return;
    if (/\/@(?:vite|react-refresh)|\/src\//.test(url.pathname)) return;
    const response = await fetch(url.href, { credentials: 'same-origin', cache: 'reload' });
    if (response.status === 200 && response.type !== 'opaque') await cache.put(url.href, response);
  }));
  return results.every(result => result.status === 'fulfilled');
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await mutate(async () => {
    for (const key of await caches.keys()) {
      if (key === 'audio-v1' || key.startsWith('audio-private-v2:')) await caches.delete(key);
    }
  }).catch(() => {});
  await self.clients.claim();
  await shellUrls();
})()));
self.addEventListener('message', event => {
  const data = event.data;
  if (!data || !event.source || new URL(event.source.url).origin !== self.location.origin) return;
  const reply = value => event.ports?.[0]?.postMessage(value);
  let task;
  if (data.type === 'CLEAR_PRIVATE_AUDIO') task = clearPrivate(data.cacheScope).then(cleared => {
    if (!cleared) throw new Error('保存領域にアクセスできず、保存データの削除を確認できません。');
    return { cleared: true };
  });
  else if (data.type === 'SYNC_SESSION') task = checkSession().then(value => ({ session: value }));
  else if (data.type === 'STORE_TRACK') task = storeTrack(data).then(() => ({ saved: true }));
  else if (data.type === 'DELETE_TRACK') task = deleteTrack(data).then(() => ({ deleted: true }));
  else if (data.type === 'SAVE_CATALOG') task = requireLease(data.cacheScope).then(() => mutate(async () => {
    const current = await readJson(LEASE_URL);
    if (current?.cacheScope !== data.cacheScope) throw new Error('Session changed');
    await putJson(stateUrl('catalog', data.cacheScope), data.tracks);
  })).then(() => ({ saved: true }));
  else if (data.type === 'CACHE_SHELL') task = shellUrls(data.urls).then(ready => ({ ready }));
  else return;
  event.waitUntil(Promise.resolve(task).then(reply, error => reply({ error: error?.name === 'QuotaExceededError'
    ? '保存容量が不足しています。不要な保存曲を削除してください。'
    : ['SecurityError', 'NotAllowedError'].includes(error?.name)
      ? 'ブラウザの保存領域を利用できません。オンライン再生は利用できます。'
      : String(error?.message ?? error) })));
});

async function cachedAudio(request, cached) {
  const blob = await cached.blob();
  const length = blob.size;
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  const range = request.headers.get('range');
  if (!range) { headers.set('Content-Length', String(length)); return new Response(request.method === 'HEAD' ? null : blob, { status: 200, headers }); }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start, end;
  if (match && (match[1] || match[2])) {
    if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, length - suffix); end = length - 1; if (!suffix) start = length; }
    else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), length - 1) : length - 1; }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= length || end < start) {
    headers.set('Content-Range', `bytes */${length}`); headers.set('Content-Length', '0');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${length}`); headers.set('Content-Length', String(end - start + 1));
  return new Response(request.method === 'HEAD' ? null : blob.slice(start, end + 1), { status: 206, headers });
}
async function serveAudio(request) {
  const expected = generation;
  let current;
  try { current = await lease(); } catch { current = null; }
  const blocked = async () => {
    const state = await readJson(LEASE_URL);
    return revokedScopes.has(lastOnlineScope) || Boolean(state?.blocked && (!lastOnlineScope || state.cacheScope === lastOnlineScope));
  };
  if (await blocked()) return failure(401);
  // A newly installed worker can establish its first allowance online, once.
  if (!current) {
    try { current = await checkSession(); } catch { /* The origin still authenticates an online stream. */ }
  }
  if (expected !== generation || await blocked()) return failure(401);
  const canonical = audioUrl(request.url);
  if (current && canonical && !request.headers.has('X-Drive-Download')) {
    try {
      const cache = await caches.open(audioCache(current.cacheScope));
      const cached = await cache.match(canonical);
      if (cached?.status === 200 && cached.headers.get('X-Drive-Saved') === '1') {
        const response = await cachedAudio(request, cached);
        return expected === generation ? response : failure(401);
      }
    } catch { /* A browser storage error must not break authenticated streaming. */ }
  }
  try {
    const response = await fetch(new Request(request, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    if (expected !== generation) return failure(401);
    if (response.status === 401) await clearPrivate();
    return response;
  } catch { return failure(503); }
}
async function authResponse(request) {
  const expected = generation;
  const response = await fetch(request);
  if (expected !== generation) return response;
  if (response.status === 401) await clearPrivate();
  else if (response.status === 200) {
    try { await recordSession(await response.clone().json(), expected); } catch { /* Keep the valid online response. Saving remains unavailable. */ }
  }
  return response;
}
async function navigation(request) {
  let cache;
  try { cache = await caches.open(SHELL_CACHE); } catch { /* Online navigation still works. */ }
  try {
    const response = await fetch(request);
    if (response.status === 200 && cache) { try { await cache.put(new URL('/', self.location.origin), response.clone()); } catch { /* Storage is optional online. */ } }
    return response;
  } catch {
    try { return (await cache?.match(new URL('/', self.location.origin))) ?? failure(503); } catch { return failure(503); }
  }
}
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/api\/stream\//.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)) event.respondWith(serveAudio(request));
  else if ((url.pathname === '/api/session' && request.method === 'GET') || (url.pathname === '/api/login' && request.method === 'POST')) event.respondWith(authResponse(request));
  else if (request.mode === 'navigate') event.respondWith(navigation(request));
  else if (request.method === 'GET' && /\.(?:js|css|woff2?|svg|png|jpe?g|webp|webmanifest)$/.test(url.pathname) && !/^\/api\//.test(url.pathname) && !/\/@(?:vite|react-refresh)|\/src\//.test(url.pathname)) {
    event.respondWith((async () => {
      let cache;
      try {
        cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
      } catch { /* Continue to the network when browser storage is blocked. */ }
      const response = await fetch(request);
      if (response.status === 200 && response.type !== 'opaque' && cache) {
        try { await cache.put(request, response.clone()); } catch { /* Never replace a valid online response with a quota failure. */ }
      }
      return response;
    })());
  }
});
