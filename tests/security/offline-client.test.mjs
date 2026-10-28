import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scope = 'abcdefghijklmnopQRSTUV';
const now = Date.now();
const track = { id: 'audio_file_1234567890', title: 'Track', ver: 'version1', size: 10 };

async function browserModule(entry, overrides = {}) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022' });
  const store = new Map();
  const module = { exports: {} };
  const state = { now, sessionMessages: [], workerMessages: [], stored: false, fetches: 0, fetch: undefined, storeGate: undefined };
  class Clock extends Date { static now() { return state.now; } }
  const localStorage = {
    getItem(key) { return store.get(key) ?? null; }, setItem(key, value) { store.set(key, String(value)); }, removeItem(key) { store.delete(key); },
  };
  let workerWrites = Promise.resolve();
  const worker = { postMessage(data, ports) {
    state.workerMessages.push(data);
    if (!ports) return;
    const reply = async () => {
      if (data.type === 'SYNC_SESSION') ports[0].postMessage({ session: { cacheScope: scope } });
      else if (data.type === 'STORE_TRACK') { if (state.storeGate) await state.storeGate; state.stored = true; ports[0].postMessage({ saved: true }); }
      else if (data.type === 'DELETE_TRACK' || data.type === 'CLEAR_PRIVATE_AUDIO') { state.stored = false; ports[0].postMessage({ deleted: true, cleared: true }); }
    };
    if (['STORE_TRACK', 'DELETE_TRACK', 'CLEAR_PRIVATE_AUDIO'].includes(data.type)) {
      const pending = workerWrites.then(reply);
      workerWrites = pending.catch(() => {});
    } else void reply();
  } };
  const context = {
    module, exports: module.exports, Date: Clock, localStorage, window: { caches: true },
    navigator: { serviceWorker: { controller: worker, ready: Promise.resolve({ active: worker }), async getRegistration() { return { active: worker }; } }, storage: { async persist() { return false; } } },
    caches: { async keys() { return []; }, async delete() { return true; } },
    location: { origin: 'https://player.example' },
    fetch: async (...args) => { state.fetches++; if (state.fetch) return state.fetch(...args); return new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } }); },
    Response, Request, Headers, Blob, DOMException, URL, AbortController, ReadableStream, MessageChannel,
    setTimeout, clearTimeout, console, ...overrides,
  };
  vm.runInNewContext(result.outputFiles[0].text, context, { filename: entry });
  return { api: module.exports, state, store };
}
function onlineSession() { return Response.json({ authenticated: true, expiresAt: Math.floor(now / 1000) + 3600, cacheScope: scope, serverTime: Math.floor(now / 1000), offlineUntil: Math.floor(now / 1000) + 30 * 86400 }); }

function cachedMetadata() {
  const entries = new Map();
  return {
    set(kind, value, albumId, cacheScope = scope) {
      const album = albumId === undefined ? '' : '/' + encodeURIComponent(albumId);
      entries.set(`https://player.example/__private__/${kind}${album}/${encodeURIComponent(cacheScope)}`, value);
    },
    caches: { async open(name) {
      assert.equal(name, 'drive-private-state-v3');
      return { async match(input) { const key = typeof input === 'string' ? input : input.url; return entries.has(key) ? Response.json(entries.get(key)) : undefined; } };
    } },
  };
}

test('a successful online response establishes a separate 30-day allowance without extending the Cookie', async () => {
  const { api, state } = await browserModule('src/utils/session.ts');
  const session = await api.readSession(onlineSession());
  assert.equal(session.expiresAt, Math.floor(now / 1000) + 3600);
  state.now += 2 * 86400 * 1000;
  const offline = api.loadOfflineSession();
  assert.equal(offline.cacheScope, scope);
  assert.equal(offline.offlineUntil, Math.floor(now / 1000) * 1000 + 30 * 86400 * 1000);
  state.now += 29 * 86400 * 1000;
  assert.equal(api.loadOfflineSession(), null);
});

test('client navigation and failed validation never renew the allowance', async () => {
  const { api, state } = await browserModule('src/utils/session.ts');
  const session = await api.readSession(onlineSession());
  state.now += 29 * 86400 * 1000;
  state.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(api.getSession());
  assert.equal(api.loadOfflineSession().offlineUntil, session.offlineUntil);
  state.now += 2 * 86400 * 1000;
  assert.equal(api.loadOfflineSession(), null);
});

test('a backwards or corrupted device clock requires online verification', async () => {
  const { api, state, store } = await browserModule('src/utils/session.ts');
  await api.readSession(onlineSession());
  state.now += 86400 * 1000; assert.ok(api.loadOfflineSession());
  state.now -= 3600 * 1000; assert.equal(api.loadOfflineSession(), null);
  state.now = now; store.set('drive-player.last-clock.v3', 'broken');
  assert.equal(api.loadOfflineSession(), null);
});

test('a confirmed 401 revokes local allowance but an aborted stale response cannot restore it', async () => {
  const { api, state } = await browserModule('src/utils/session.ts');
  await api.readSession(onlineSession());
  state.fetch = async () => new Response(null, { status: 401 });
  assert.equal(await api.getSession(), null);
  assert.equal(api.loadOfflineSession(), null);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(api.readSession(onlineSession(), controller.signal), error => error.name === 'AbortError');
  assert.equal(api.loadOfflineSession(), null);
});

test('an in-flight session response cannot revive a locally logged-out browser', async () => {
  const { api, state } = await browserModule('src/utils/session.ts');
  let finish;
  state.fetch = () => new Promise(resolve => { finish = resolve; });
  const checking = api.getSession(); api.clearLocalSession(); finish(onlineSession());
  await assert.rejects(checking, error => error.name === 'AbortError');
  assert.equal(api.loadOfflineSession(), null);
});

test('blocked localStorage keeps a verified online session usable in memory after the minute check', async () => {
  const blockedStorage = {
    getItem() { throw new DOMException('Denied', 'SecurityError'); },
    setItem() { throw new DOMException('Denied', 'SecurityError'); },
    removeItem() { throw new DOMException('Denied', 'SecurityError'); },
  };
  const { api, state } = await browserModule('src/utils/session.ts', { localStorage: blockedStorage });
  assert.equal(api.loadOfflineSession(), null);
  await api.readSession(onlineSession());
  state.now += 61_000;
  assert.equal(api.loadOfflineSession().cacheScope, scope);
  assert.equal(api.isLocallyLoggedOut(), false);
  state.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(api.getSession());
  assert.equal(api.loadOfflineSession().cacheScope, scope);
  state.now += 31 * 86400 * 1000;
  assert.equal(api.loadOfflineSession(), null);
  api.clearLocalSession();
  assert.equal(api.isLocallyLoggedOut(), true);
  assert.equal(api.loadOfflineSession(), null);
  const freshPage = await browserModule('src/utils/session.ts', { localStorage: blockedStorage });
  assert.equal(freshPage.api.loadOfflineSession(), null);
});

test('failed persistence never substitutes a previous scope for the fresh online session', async () => {
  const previousScope = 'PreviousScopeabcdefghijklmnop';
  const previous = JSON.stringify({ authenticated: true, expiresAt: Math.floor(now / 1000) + 3600, cacheScope: previousScope, verifiedAt: now, offlineUntil: now + 86400 * 1000 });
  const staleStorage = {
    getItem(key) { return key === 'drive-player.offline-session.v3' ? previous : key === 'drive-player.logged-out.v3' ? 'true' : String(now); },
    setItem() { throw new DOMException('Full', 'QuotaExceededError'); },
    removeItem() { throw new DOMException('Denied', 'SecurityError'); },
  };
  const { api, state } = await browserModule('src/utils/session.ts', { localStorage: staleStorage });
  await api.readSession(onlineSession()); state.now += 61_000;
  assert.equal(api.isLocallyLoggedOut(), false);
  assert.equal(api.loadOfflineSession().cacheScope, scope);
});

test('clock-write quota failure keeps online state usable, but another-tab deletion still revokes it', async () => {
  let denyWrites = false;
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { if (denyWrites) throw new DOMException('Full', 'QuotaExceededError'); values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const { api, state } = await browserModule('src/utils/session.ts', { localStorage: storage });
  await api.readSession(onlineSession());
  values.delete('drive-player.offline-session.v3');
  assert.equal(api.loadOfflineSession(), null);
  await api.readSession(onlineSession());
  denyWrites = true; state.now += 61_000;
  assert.equal(api.loadOfflineSession().cacheScope, scope);
  state.now += 61_000; assert.equal(api.loadOfflineSession().cacheScope, scope);
  api.clearLocalSession(); assert.equal(api.loadOfflineSession(), null);
});

test('only a completed full response is sent to the worker as an explicit download', async () => {
  const { api, state } = await browserModule('src/utils/cache.ts');
  const progress = [];
  await api.downloadTrack(track, scope, { onProgress: value => progress.push(value.loaded) });
  assert.equal(state.stored, true);
  assert.equal(progress.at(-1), 10);
  const save = state.workerMessages.find(message => message.type === 'STORE_TRACK');
  assert.equal(save.blob.size, 10); assert.equal(save.url, '/api/stream/audio_file_1234567890?v=version1');
});

test('partial and range responses never become completed downloads', async () => {
  for (const kind of ['short', 'range']) {
    const { api, state } = await browserModule('src/utils/cache.ts');
    state.fetch = async () => new Response('123', { status: kind === 'range' ? 206 : 200, headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } });
    await assert.rejects(api.downloadTrack(track, scope));
    assert.equal(state.stored, false);
    assert.equal(state.workerMessages.some(message => message.type === 'STORE_TRACK'), false);
  }
});

test('cancelling a body read leaves no cache entry and returns AbortError', async () => {
  const { api, state } = await browserModule('src/utils/cache.ts');
  const controller = new AbortController();
  await assert.rejects(api.downloadTrack(track, scope, { signal: controller.signal, onProgress: value => { if (value.loaded) controller.abort(); } }), error => error.name === 'AbortError');
  assert.equal(state.stored, false);
});

test('logout during the worker write is followed by deletion, never a saved completion', async () => {
  const { api, state } = await browserModule('src/utils/cache.ts');
  let release;
  state.storeGate = new Promise(resolve => { release = resolve; });
  const saving = api.downloadTrack(track, scope);
  const rejected = assert.rejects(saving, error => error.name === 'AbortError');
  while (!state.workerMessages.some(message => message.type === 'STORE_TRACK')) await new Promise(resolve => setTimeout(resolve, 1));
  const clearing = api.clearPrivateAudioCache(); release(); await clearing; await rejected;
  assert.equal(state.stored, false);
  assert.ok(state.workerMessages.some(message => message.type === 'DELETE_TRACK'));
});

test('a present serviceWorker with a permanently pending ready promise has a finite readiness timeout', async () => {
  const { api, state } = await browserModule('src/utils/cache.ts', {
    navigator: { serviceWorker: { controller: null, ready: new Promise(() => {}) } },
    // The production deadline is 8 seconds; advance only that deadline in this VM.
    setTimeout: (callback, delay, ...args) => setTimeout(callback, delay === 8_000 ? 5 : delay, ...args),
  });
  await assert.rejects(api.downloadTrack(track, scope), /端末保存の準備ができません/);
  assert.equal(state.fetches, 0);
});

test('cancelling while serviceWorker.ready is pending returns AbortError immediately', async () => {
  const { api, state } = await browserModule('src/utils/cache.ts', {
    navigator: { serviceWorker: { controller: null, ready: new Promise(() => {}) } },
  });
  const controller = new AbortController();
  const saving = api.downloadTrack(track, scope, { signal: controller.signal });
  controller.abort();
  await assert.rejects(saving, error => error.name === 'AbortError');
  assert.equal(state.fetches, 0);
});

test('cancelling while SYNC_SESSION has not replied returns AbortError without starting a download', async () => {
  const sent = [];
  const silentWorker = { postMessage(data) { sent.push(data.type); } };
  const { api, state } = await browserModule('src/utils/cache.ts', {
    navigator: { serviceWorker: { controller: silentWorker, ready: Promise.resolve({ active: silentWorker }) } },
  });
  const controller = new AbortController();
  const saving = api.downloadTrack(track, scope, { signal: controller.signal });
  assert.deepEqual(sent, ['SYNC_SESSION']);
  controller.abort();
  await assert.rejects(saving, error => error.name === 'AbortError');
  assert.equal(state.fetches, 0);
  assert.equal(state.workerMessages.some(message => message.type === 'STORE_TRACK'), false);
});

test('legacy unassigned catalog falls back only to the persisted default album', async () => {
  const saved = cachedMetadata();
  const snapshot = { albums: [{ id: 'album_A', name: '3rd album' }, { id: 'album_B', name: 'Another album' }], defaultAlbumId: 'album_A' };
  saved.set('library', snapshot);
  saved.set('catalog', [track]);
  const { api } = await browserModule('src/utils/cache.ts', { caches: saved.caches });
  const library = await api.loadLibrary(scope);
  assert.equal(library.defaultAlbumId, 'album_A'); assert.equal(library.albums.length, 2);
  const old = await api.loadCatalog(scope);
  assert.equal(old[0].id, track.id); assert.equal(old[0].albumId, undefined);
  const migrated = await api.loadCatalog(scope, 'album_A');
  assert.equal(migrated[0].id, track.id); assert.equal(migrated[0].albumId, 'album_A');
  assert.equal((await api.loadCatalog(scope, 'album_B')).length, 0);
  assert.equal((await api.loadCatalog(scope, 'unfetched_album')).length, 0);
  assert.equal((await api.loadCatalog('another-scope-1234567890', 'album_A')).length, 0);
});

test('offline album catalogs are independent and an explicitly empty album never revives old songs', async () => {
  const saved = cachedMetadata();
  const other = { ...track, id: 'second_audio_id', title: 'Second', albumId: 'album_B' };
  saved.set('library', { albums: [{ id: 'album_A', name: 'A' }, { id: 'album_B', name: 'B' }], defaultAlbumId: 'album_A' });
  saved.set('catalog', [track]);
  saved.set('catalog', [], 'album_A');
  saved.set('catalog', [other], 'album_B');
  const { api } = await browserModule('src/utils/cache.ts', { caches: saved.caches });
  assert.equal((await api.loadCatalog(scope, 'album_A')).length, 0);
  assert.equal((await api.loadCatalog(scope, 'album_B'))[0].id, other.id);
  assert.equal((await api.loadCatalog(scope))[0].id, track.id);
});

test('legacy catalog with identified albums exposes only the matching folder and unassigned default songs', async () => {
  const saved = cachedMetadata();
  saved.set('library', { albums: [{ id: 'album_A', name: 'A' }, { id: 'album_B', name: 'B' }], defaultAlbumId: 'album_A' });
  const a = { ...track, id: 'a', albumId: 'album_A' };
  const b = { ...track, id: 'b', albumId: 'album_B' };
  const legacy = { ...track, id: 'legacy' };
  saved.set('catalog', [a, b, legacy]);
  const { api } = await browserModule('src/utils/cache.ts', { caches: saved.caches });
  assert.deepEqual(Array.from(await api.loadCatalog(scope, 'album_A'), item => item.id), ['a', 'legacy']);
  assert.deepEqual(Array.from(await api.loadCatalog(scope, 'album_B'), item => item.id), ['b']);
  assert.equal((await api.loadCatalog(scope, 'album_C')).length, 0);
});

test('without a library snapshot old data remains available only through the legacy API', async () => {
  const saved = cachedMetadata(); saved.set('catalog', [track]);
  const { api } = await browserModule('src/utils/cache.ts', { caches: saved.caches });
  assert.equal((await api.loadLibrary(scope)).albums.length, 0);
  assert.equal((await api.loadCatalog(scope)).length, 1);
  assert.equal((await api.loadCatalog(scope, 'album_A')).length, 0);
});

test('catalog presence distinguishes explicit empty, missing, and legacy fallback snapshots', async () => {
  const saved = cachedMetadata();
  saved.set('library', { albums: [{ id: 'album_A', name: 'A' }, { id: 'album_B', name: 'B' }], defaultAlbumId: 'album_A' });
  saved.set('catalog', [track]);
  saved.set('catalog', [], 'album_B');
  const { api } = await browserModule('src/utils/cache.ts', { caches: saved.caches });
  assert.equal(await api.hasCatalog(scope), true);
  assert.equal(await api.hasCatalog(scope, 'album_A'), false);
  assert.equal((await api.loadCatalog(scope, 'album_A')).length, 1);
  assert.equal(await api.hasCatalog(scope, 'album_B'), true);
  assert.equal((await api.loadCatalog(scope, 'album_B')).length, 0);
  assert.equal(await api.hasCatalog(scope, 'unfetched_album'), false);
});
