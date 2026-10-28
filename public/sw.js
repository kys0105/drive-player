/* Explicit audio downloads and scoped artwork. A 30-day allowance starts online. */
const AUDIO_PREFIX = 'audio-private-v3:';
const ARTWORK_PREFIX = 'artwork-private-v1:';
const MAX_ARTWORK_BYTES = 4 * 1024 * 1024;
const META_CACHE = 'drive-private-state-v3';
const SHELL_CACHE = 'drive-shell-v3';
const LEASE_URL = new URL('/__private__/lease', self.location.origin).href;
const OFFLINE_MS = 30 * 24 * 60 * 60 * 1000;
let generation = 0;
let writes = Promise.resolve();
let sessionCheck;
let lastOnlineScope;
const revokedScopes = new Set();
const pendingArtwork = new Map();
const artworkControllers = new Set();
const artworkEpochs = new Map();

function mutate(operation) {
  const pending = writes.then(operation);
  writes = pending.catch(() => {});
  return pending;
}
function failure(status) { return new Response(null, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
function audioCache(scope) { return `${AUDIO_PREFIX}${encodeURIComponent(scope)}`; }
function artworkCache(scope) { return `${ARTWORK_PREFIX}${encodeURIComponent(scope)}`; }
function stateUrl(kind, scope, albumId) {
  const album = albumId === undefined ? '' : `/${encodeURIComponent(albumId)}`;
  return new URL(`/__private__/${kind}${album}/${encodeURIComponent(scope)}`, self.location.origin).href;
}
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
  artworkEpochs.clear();
  for (const controller of artworkControllers) controller.abort();
  if (validScope(scope ?? lastOnlineScope)) revokedScopes.add(scope ?? lastOnlineScope);
  const clearing = mutate(async () => {
    const priorLease = await readJson(LEASE_URL);
    if (!scope && validScope(priorLease?.cacheScope)) revokedScopes.add(priorLease.cacheScope);
    const keys = await caches.keys();
    await Promise.all(keys.filter(name => name === 'audio-v1' || name.startsWith('audio-private-v2:') ||
      (name.startsWith(AUDIO_PREFIX) && (!scope || name === audioCache(scope))) ||
      (name.startsWith(ARTWORK_PREFIX) && (!scope || name === artworkCache(scope)))) .map(name => caches.delete(name)));
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
      await caches.delete(artworkCache(previous.cacheScope));
      const meta = await caches.open(META_CACHE);
      for (const request of await meta.keys()) {
        if (new URL(request.url).pathname.endsWith(`/${encodeURIComponent(previous.cacheScope)}`)) await meta.delete(request);
      }
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
async function savedTracks(scope) {
  const value = await readJson(stateUrl('saved', scope));
  return Array.isArray(value) ? value : [];
}

function validAlbumId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

function checkedTracks(value, albumId) {
  if (!Array.isArray(value) || value.some(track => !track || typeof track.id !== 'string' || !track.id || typeof track.title !== 'string')) throw new Error('曲一覧の保存データが正しくありません。');
  if (albumId !== undefined && !validAlbumId(albumId)) throw new Error('フォルダが正しくありません。');
  return value.map(track => {
    if (albumId === undefined) return track;
    if (track.albumId !== undefined && track.albumId !== albumId) throw new Error('別のフォルダの曲一覧は保存できません。');
    return { ...track, albumId };
  });
}

function checkedLibrary(value) {
  if (!value || !Array.isArray(value.albums) || value.albums.some(album => !album || !validAlbumId(album.id) || typeof album.name !== 'string')) throw new Error('フォルダ一覧の保存データが正しくありません。');
  const ids = new Set(value.albums.map(album => album.id));
  if (ids.size !== value.albums.length || (value.defaultAlbumId !== null && !ids.has(value.defaultAlbumId))) throw new Error('既定のフォルダが正しくありません。');
  return { albums: value.albums.map(album => ({ id: album.id, name: album.name, ...(album.legacy === true ? { legacy: true } : {}) })), defaultAlbumId: value.defaultAlbumId };
}

async function saveMetadata(data, kind) {
  const expected = generation;
  const value = kind === 'library' ? checkedLibrary(data.snapshot) : checkedTracks(data.tracks, data.albumId);
  await requireLease(data.cacheScope);
  await mutate(async () => {
    const current = await readJson(LEASE_URL);
    if (generation !== expected || current?.blocked || current?.cacheScope !== data.cacheScope || !Number.isFinite(current.offlineUntil) || Date.now() >= current.offlineUntil) throw new Error('ログインが変更されたため保存を中止しました。');
    await putJson(stateUrl(kind, data.cacheScope, kind === 'catalog' ? data.albumId : undefined), value);
  });
}

async function migrateSavedMetadata(data) {
  const expected = generation;
  const tracks = checkedTracks(data.tracks);
  const candidates = new Map(tracks.filter(track => validAlbumId(track.albumId) && typeof track.ver === 'string' && track.ver).map(track => [track.id, track]));
  await requireLease(data.cacheScope);
  await mutate(async () => {
    const current = await readJson(LEASE_URL);
    if (generation !== expected || current?.blocked || current?.cacheScope !== data.cacheScope || !Number.isFinite(current.offlineUntil) || Date.now() >= current.offlineUntil) throw new Error('ログインが変更されたため移行を中止しました。');
    const enrich = entry => {
      const track = candidates.get(entry?.id);
      if (!track) return entry;
      let version = entry.ver;
      if (typeof version !== 'string' && entry.savedUrl) {
        try { version = new URL(entry.savedUrl, self.location.origin).searchParams.get('v'); } catch { return entry; }
      }
      if (version !== track.ver) return entry;
      // Preserve the body key even if artwork, filename, album or lyrics changed.
      return { ...entry, ...track, lyrics: track.lyrics, lyricsIssue: track.lyricsIssue, ...(entry.savedUrl ? { savedUrl: entry.savedUrl } : {}) };
    };
    const previousSaved = await savedTracks(data.cacheScope);
    const updatedSaved = previousSaved.map(enrich);
    if (JSON.stringify(previousSaved) !== JSON.stringify(updatedSaved)) await putJson(stateUrl('saved', data.cacheScope), updatedSaved);
    const previousCatalog = await readJson(stateUrl('catalog', data.cacheScope));
    if (Array.isArray(previousCatalog)) {
      const updatedCatalog = previousCatalog.map(enrich);
      if (JSON.stringify(previousCatalog) !== JSON.stringify(updatedCatalog)) await putJson(stateUrl('catalog', data.cacheScope), updatedCatalog);
    }
  });
}
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
  const canonical = audioUrl(data.url);
  if (!canonical || !validScope(data.cacheScope)) return;
  const path = new URL(canonical).pathname.replace('/api/stream/', '/api/artwork/');
  const imageKey = `${data.cacheScope}\0${path}`;
  artworkEpochs.set(imageKey, (artworkEpochs.get(imageKey) ?? 0) + 1);
  await mutate(async () => {
    const cache = await caches.open(audioCache(data.cacheScope));
    await cache.delete(canonical);
    await putJson(stateUrl('saved', data.cacheScope), (await savedTracks(data.cacheScope)).filter(track => track.savedUrl !== canonical));
    if ((await caches.keys()).includes(artworkCache(data.cacheScope))) {
      const images = await caches.open(artworkCache(data.cacheScope));
      for (const request of await images.keys()) if (new URL(request.url).pathname === path) await images.delete(request);
    }
  });
}

function artworkUrl(value) {
  try {
    const url = new URL(value, self.location.origin);
    const version = url.searchParams.get('v');
    if (url.origin !== self.location.origin || !/^\/api\/artwork\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) || !version || version.length > 2048) return null;
    url.hash = ''; url.search = ''; url.searchParams.set('v', version);
    return url.href;
  } catch { return null; }
}

function artworkMime(response) {
  const type = (response.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  return ['image/webp', 'image/jpeg', 'image/png'].includes(type) ? type : null;
}

function imageHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

function imageMagic(bytes, mime) {
  if (mime === 'image/png') return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && [82, 73, 70, 70].every((byte, index) => bytes[index] === byte) && [87, 69, 66, 80].every((byte, index) => bytes[index + 8] === byte);
}

async function readArtwork(response, signal, expected) {
  const mime = artworkMime(response);
  const advertised = Number(response.headers.get('Content-Length'));
  if (!mime || advertised > MAX_ARTWORK_BYTES || !response.body) throw new Error('Invalid artwork');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted || generation !== expected) throw new DOMException('Aborted', 'AbortError');
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_ARTWORK_BYTES) throw new Error('Invalid artwork');
      chunks.push(part.value);
    }
    if (!length || (advertised > 0 && advertised !== length)) throw new Error('Invalid artwork');
    const blob = new Blob(chunks, { type: mime });
    if (!imageMagic(new Uint8Array(await blob.slice(0, 12).arrayBuffer()), mime)) throw new Error('Invalid artwork');
    const headers = imageHeaders(response);
    headers.set('Content-Type', mime); headers.set('Content-Length', String(length));
    return { blob, headers };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function trimArtwork(cache, path) {
  const versions = [];
  for (const request of await cache.keys()) {
    if (new URL(request.url).pathname !== path) continue;
    const response = await cache.match(request);
    versions.push({ request, time: Number(response?.headers.get('X-Drive-Artwork-Requested-At')) || 0 });
  }
  versions.sort((a, b) => b.time - a.time);
  for (const entry of versions.slice(2)) await cache.delete(entry.request);
}

function artworkFailure(error) {
  if (error?.name === 'QuotaExceededError') return 'quota';
  if (error?.name === 'AbortError') return 'cancelled';
  return 'unavailable';
}

function networkArtwork(request, canonical, current, expected) {
  const scope = current?.cacheScope ?? '';
  const imageKey = `${scope}\0${new URL(request.url).pathname}`;
  const imageEpoch = artworkEpochs.get(imageKey) ?? 0;
  const key = `${expected}\0${imageEpoch}\0${scope}\0${canonical ?? request.url}`;
  if (pendingArtwork.has(key)) return pendingArtwork.get(key);
  const controller = new AbortController();
  const abort = () => controller.abort();
  // Auto-view requests share one network read. Explicit save requests also honor
  // cancellation; logout always aborts every outstanding private image request.
  const explicit = request.headers.get('X-Drive-Artwork-Save') === '1';
  if (explicit) request.signal.addEventListener('abort', abort, { once: true });
  if (explicit && request.signal.aborted) controller.abort();
  artworkControllers.add(controller);
  const requestedAt = Date.now();
  const pending = (async () => {
    try {
      const headers = new Headers(request.headers);
      headers.delete('X-Drive-Artwork-Save'); headers.delete('X-Drive-Cache-Scope');
      const response = await fetch(new Request(request, { headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal }));
      if (expected !== generation || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (response.status === 401) { await clearPrivate(); return { response, finished: Promise.resolve('cancelled') }; }
      if (response.status !== 200) return { response, finished: Promise.resolve('unavailable') };
      const image = await readArtwork(response, controller.signal, expected);
      const displayed = new Response(image.blob, { status: 200, headers: image.headers });
      const finished = current && canonical ? mutate(async () => {
        const permit = await readJson(LEASE_URL);
        if (expected !== generation || imageEpoch !== (artworkEpochs.get(imageKey) ?? 0) || controller.signal.aborted || permit?.blocked || permit?.cacheScope !== scope || !Number.isFinite(permit.offlineUntil) || Date.now() >= permit.offlineUntil) throw new DOMException('Aborted', 'AbortError');
        const cache = await caches.open(artworkCache(scope));
        const savedHeaders = new Headers(image.headers);
        savedHeaders.set('X-Drive-Artwork-Cache', 'stored');
        savedHeaders.set('X-Drive-Artwork-Requested-At', String(requestedAt));
        await cache.put(canonical, new Response(image.blob, { status: 200, headers: savedHeaders }));
        await trimArtwork(cache, new URL(canonical).pathname);
        if (expected !== generation || controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        if (!(await cache.match(canonical))) throw new Error('A newer artwork version is already stored');
        return 'stored';
      }).catch(artworkFailure) : Promise.resolve('unavailable');
      return { response: displayed, finished };
    } catch (error) {
      return { response: failure(error?.name === 'AbortError' ? 409 : error?.message === 'Invalid artwork' ? 502 : 503), finished: Promise.resolve(artworkFailure(error)) };
    }
  })();
  pendingArtwork.set(key, pending);
  void pending.then(result => result.finished).catch(() => {}).finally(() => {
    if (pendingArtwork.get(key) === pending) pendingArtwork.delete(key);
    artworkControllers.delete(controller);
    request.signal.removeEventListener('abort', abort);
  });
  return pending;
}

async function serveArtwork(request) {
  const expected = generation;
  let current;
  try { current = await lease(); } catch { /* Online display remains possible. */ }
  const blocked = async () => {
    const state = await readJson(LEASE_URL);
    return revokedScopes.has(lastOnlineScope) || Boolean(state?.blocked && (!lastOnlineScope || state.cacheScope === lastOnlineScope));
  };
  if (await blocked()) return { response: failure(401) };
  if (!current) { try { current = await checkSession(); } catch { /* Origin still authenticates online images. */ } }
  if (expected !== generation || await blocked()) return { response: failure(409) };
  const explicit = request.headers.get('X-Drive-Artwork-Save') === '1';
  if (explicit && current && request.headers.get('X-Drive-Cache-Scope') !== current.cacheScope) return { response: failure(409) };
  const canonical = artworkUrl(request.url);
  if (current && canonical) {
    try {
      const cache = await caches.open(artworkCache(current.cacheScope));
      const cached = await cache.match(canonical);
      if (cached?.status === 200 && cached.headers.get('X-Drive-Artwork-Cache') === 'stored' && artworkMime(cached) && Number(cached.headers.get('Content-Length')) <= MAX_ARTWORK_BYTES) {
        return { response: expected !== generation ? failure(409) : request.method === 'HEAD' ? new Response(null, { status: 200, headers: imageHeaders(cached) }) : cached };
      }
    } catch { /* Storage denial must not break online image display. */ }
  }
  if (request.method === 'HEAD') {
    try {
      const response = await fetch(new Request(request, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
      if (response.status === 401) await clearPrivate();
      if (response.status === 200 && (!artworkMime(response) || Number(response.headers.get('Content-Length')) > MAX_ARTWORK_BYTES)) return { response: failure(502) };
      return { response: expected !== generation && response.status !== 401 ? failure(409) : new Response(null, { status: response.status, headers: imageHeaders(response) }) };
    } catch { return { response: failure(503) }; }
  }
  const result = await networkArtwork(request, canonical, current, expected);
  if (expected !== generation) return { response: failure(409), finished: result.finished };
  if (explicit && result.response.status === 200) {
    const outcome = await result.finished;
    if (expected !== generation) return { response: failure(409), finished: result.finished };
    const headers = imageHeaders(result.response);
    headers.set('X-Drive-Artwork-Cache', outcome);
    return { response: new Response(result.response.clone().body, { status: 200, headers }), finished: result.finished };
  }
  return { response: result.response.clone(), finished: result.finished };
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
  else if (data.type === 'SAVE_CATALOG') task = saveMetadata(data, 'catalog').then(() => ({ saved: true }));
  else if (data.type === 'SAVE_LIBRARY') task = saveMetadata(data, 'library').then(() => ({ saved: true }));
  else if (data.type === 'MIGRATE_SAVED_TRACKS') task = migrateSavedMetadata(data).then(() => ({ migrated: true }));
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
  else if (/^\/api\/artwork\//.test(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
    const result = serveArtwork(request);
    event.respondWith(result.then(value => value.response));
    event.waitUntil(result.then(value => value.finished));
  }
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
