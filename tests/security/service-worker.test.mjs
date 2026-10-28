import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://player.example';
const url = `${origin}/api/stream/audio_file_1234567890?v=version1`;
const scopeA = 'session-scope-AAAAAAAAAAAAAAAA';
const scopeB = 'session-scope-BBBBBBBBBBBBBBBB';
const track = { id: 'audio_file_1234567890', title: 'Example', ver: 'version1', size: 10 };
const artUrl = `${origin}/api/artwork/${track.id}?v=cover1`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2gN8AAAAASUVORK5CYII=', 'base64');

async function createWorker(scope = scopeA) {
  const listeners = new Map();
  const storage = new Map();
  const messages = [];
  const state = { scope, now: Date.now(), offline: false, authenticated: true, sessionCalls: 0, mediaCalls: 0,
    beforePut: undefined, cacheFailure: undefined, artworkCalls: 0, artworkBytes: png, artworkMime: 'image/png', artworkGate: undefined, artworkResponse: undefined, artworkFetched: undefined };
  function storageFailure(operation) {
    if (state.cacheFailure !== operation) return;
    const error = new Error('Browser storage unavailable');
    error.name = operation === 'put' ? 'QuotaExceededError' : 'SecurityError';
    throw error;
  }
  const keyOf = value => typeof value === 'string' ? new URL(value, origin).href : (value.url ?? value.href);
  const caches = {
    async keys() { storageFailure('keys'); return [...storage.keys()]; },
    async delete(name) { return storage.delete(name); },
    async open(name) {
      storageFailure('open');
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(request) { storageFailure('match'); return entries.get(keyOf(request))?.clone(); },
        async put(request, response) {
          storageFailure('put');
          if (state.beforePut) await state.beforePut(name, request, response);
          // Cache API resolves only after the entire response body has been consumed.
          const copy = response.clone();
          const bytes = await copy.arrayBuffer();
          entries.set(keyOf(request), new Response(bytes, { status: copy.status, headers: copy.headers }));
        },
        async delete(request) { return entries.delete(keyOf(request)); },
        async keys() { return [...entries.keys()].map(value => new Request(value)); },
      };
    },
  };
  const workerFetch = async input => {
    const target = new URL(keyOf(input), origin);
    if (state.offline) throw new TypeError('Network unavailable');
    if (target.pathname === '/api/session') {
      state.sessionCalls++;
      if (!state.authenticated) return Response.json({ authenticated: false }, { status: 401 });
      const seconds = Math.floor(state.now / 1000);
      return Response.json({ authenticated: true, expiresAt: seconds + 3600, cacheScope: state.scope, serverTime: seconds, offlineUntil: seconds + 30 * 86400 });
    }
    if (target.pathname.startsWith('/api/stream/')) {
      state.mediaCalls++;
      return new Response('0123456789', { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': '10' } });
    }
    if (target.pathname.startsWith('/api/artwork/')) {
      state.artworkCalls++;
      state.artworkFetched?.(input);
      if (state.artworkGate) await state.artworkGate;
      if (!state.authenticated) return new Response(null, { status: 401 });
      if (state.artworkResponse) return state.artworkResponse(input);
      return new Response(input.method === 'HEAD' ? null : state.artworkBytes, { headers: { 'Content-Type': state.artworkMime, 'Content-Length': String(state.artworkBytes.byteLength) } });
    }
    return new Response(target.pathname === '/' ? '<html>app shell</html>' : 'static-resource');
  };
  const self = {
    location: new URL(origin), addEventListener(type, handler) { listeners.set(type, handler); }, skipWaiting() {},
    clients: { async claim() {}, async matchAll() { return [{ postMessage(value) { messages.push(value); } }]; } },
  };
  class Clock extends Date { static now() { return state.now; } }
  vm.runInNewContext(source, { self, caches, fetch: workerFetch, Request, Response, Headers, URL, Blob, AbortController, DOMException, Date: Clock, console, setTimeout, clearTimeout }, { filename: 'public/sw.js' });
  async function dispatch(type, properties = {}) {
    const pending = [];
    let response;
    listeners.get(type)?.({ ...properties, waitUntil(promise) { pending.push(Promise.resolve(promise)); }, respondWith(value) { response = Promise.resolve(value); } });
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  async function message(data) {
    let result;
    await dispatch('message', { data, source: { url: origin + '/' }, ports: [{ postMessage(value) { result = value; } }] });
    return result;
  }
  return {
    state, storage, messages, caches, dispatch, message,
    fetch: init => dispatch('fetch', { request: new Request(url, init) }),
    artwork: (init, target = artUrl) => dispatch('fetch', { request: new Request(target, init) }),
    sync: () => message({ type: 'SYNC_SESSION' }),
    save: () => message({ type: 'STORE_TRACK', cacheScope: state.scope, url, track, blob: new Blob(['0123456789'], { type: 'audio/mpeg' }) }),
  };
}

test('ordinary playback never auto-downloads or labels a track saved', async () => {
  const worker = await createWorker();
  assert.equal(await (await worker.fetch()).text(), '0123456789');
  assert.equal(await (await worker.fetch()).text(), '0123456789');
  assert.equal(worker.state.sessionCalls, 1);
  assert.equal(worker.state.mediaCalls, 2);
  assert.equal((await worker.caches.keys()).filter(name => name.startsWith('audio-private-v3:')).length, 1);
  const audio = await worker.caches.open(`audio-private-v3:${scopeA}`);
  assert.equal((await audio.keys()).length, 0);
});

test('only an explicit complete download becomes saved and starts offline without session requests', async () => {
  const worker = await createWorker();
  await worker.sync();
  assert.equal((await worker.save()).saved, true);
  worker.state.offline = true;
  const first = await worker.fetch();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Drive-Saved'), '1');
  assert.equal(await first.text(), '0123456789');
  assert.equal(worker.state.sessionCalls, 1);
  assert.equal(worker.state.mediaCalls, 0);
});

test('offline complete, open-ended and suffix ranges plus HEAD work from the full saved file', async () => {
  const worker = await createWorker();
  await worker.sync(); await worker.save(); worker.state.offline = true;
  for (const [range, expected, contentRange] of [['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=7-', '789', 'bytes 7-9/10'], ['bytes=-2', '89', 'bytes 8-9/10']]) {
    const response = await worker.fetch({ headers: { Range: range } });
    assert.equal(response.status, 206); assert.equal(await response.text(), expected); assert.equal(response.headers.get('Content-Range'), contentRange);
  }
  for (const range of ['bytes=100-', 'bytes=4-2', 'bytes=0-1,4-5', 'bytes=-0']) {
    const response = await worker.fetch({ headers: { Range: range } });
    assert.equal(response.status, 416); assert.equal(response.headers.get('Content-Range'), 'bytes */10');
  }
  const head = await worker.fetch({ method: 'HEAD', headers: { Range: 'bytes=2-4' } });
  assert.equal(head.status, 206); assert.equal(head.headers.get('Content-Length'), '3'); assert.equal(await head.text(), '');
  assert.equal(worker.state.mediaCalls, 0);
});

test('30-day deadline is not extended by playback, navigation or failed online checks', async () => {
  const worker = await createWorker();
  await worker.sync(); await worker.save(); worker.state.offline = true;
  worker.state.now += 29 * 86400 * 1000;
  assert.equal((await worker.fetch()).status, 200);
  await worker.sync();
  worker.state.now += 2 * 86400 * 1000;
  // Lack of network is unavailable (503), not a false server-side revocation.
  assert.equal((await worker.fetch()).status, 503);
});

test('rolling the device clock back cannot revive or extend an offline allowance', async () => {
  const worker = await createWorker();
  await worker.sync(); await worker.save(); worker.state.offline = true;
  worker.state.now += 86400 * 1000; assert.equal((await worker.fetch()).status, 200);
  worker.state.now -= 3600 * 1000; assert.equal((await worker.fetch()).status, 503);
});

test('online 401 clears saved audio and catalog, and broadcasts revocation', async () => {
  const worker = await createWorker();
  await worker.sync(); await worker.save();
  await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, tracks: [track] });
  worker.state.authenticated = false;
  await worker.sync();
  assert.equal((await worker.fetch()).status, 401);
  assert.equal((await worker.caches.keys()).some(name => name.startsWith('audio-private-v3:')), false);
  assert.ok(worker.messages.some(message => message.type === 'AUTH_REVOKED'));
});

test('logout waits for pending complete writes and prevents late restoration using the old Cookie', { timeout: 10000 }, async () => {
  const worker = await createWorker(); await worker.sync();
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  worker.state.beforePut = async name => { if (name.startsWith('audio-private-v3:')) { started(); await wait; } };
  const saving = worker.save(); await ready;
  const clearing = worker.message({ type: 'CLEAR_PRIVATE_AUDIO', cacheScope: scopeA });
  release(); await Promise.all([saving, clearing]);
  worker.state.beforePut = undefined;
  assert.equal((await worker.caches.keys()).some(name => name.startsWith('audio-private-v3:')), false);
  assert.equal((await worker.fetch()).status, 401);
  assert.ok((await worker.save()).error);
});

test('another browser and independently signed session keep their own downloads', async () => {
  const [a, b] = await Promise.all([createWorker(), createWorker(scopeB)]);
  await Promise.all([a.sync(), b.sync()]); await Promise.all([a.save(), b.save()]);
  await a.message({ type: 'CLEAR_PRIVATE_AUDIO' }); b.state.offline = true;
  assert.equal((await a.fetch()).status, 401);
  assert.equal(await (await b.fetch()).text(), '0123456789');
});

test('different session scopes cannot read the previous session saved data', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  worker.state.scope = scopeB; await worker.sync(); worker.state.offline = true;
  assert.equal((await worker.fetch()).status, 503);
  assert.equal((await worker.caches.keys()).includes(`audio-private-v3:${scopeA}`), false);
});

test('partial bytes and failed cache writes never become completed saves', async () => {
  const worker = await createWorker(); await worker.sync();
  const partial = await worker.message({ type: 'STORE_TRACK', cacheScope: scopeA, url, track, blob: new Blob(['123']) });
  assert.ok(partial.error);
  worker.state.beforePut = async name => { if (name.startsWith('audio-private-v3:')) { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } };
  assert.match((await worker.save()).error, /容量/);
  worker.state.offline = true;
  assert.equal((await worker.fetch()).status, 503);
});

test('cross-origin requests, fake clients and arbitrary URLs cannot populate private cache', async () => {
  const worker = await createWorker(); await worker.sync();
  assert.equal(await worker.dispatch('fetch', { request: new Request('https://attacker.example/api/stream/id?v=1') }), undefined);
  assert.equal(await worker.dispatch('message', { data: { type: 'CLEAR_PRIVATE_AUDIO' }, source: { url: 'https://attacker.example/' } }), undefined);
  assert.ok((await worker.message({ type: 'STORE_TRACK', cacheScope: scopeA, url: 'https://attacker.example/audio?v=1', track, blob: new Blob(['0123456789']) })).error);
});

test('cached shell and static resources allow offline navigation without caching private APIs', async () => {
  const worker = await createWorker();
  await worker.message({ type: 'CACHE_SHELL', urls: [origin + '/assets/main-v1.js', origin + '/api/list'] });
  worker.state.offline = true;
  const request = { url: origin + '/', mode: 'navigate', method: 'GET' };
  assert.equal(await (await worker.dispatch('fetch', { request })).text(), '<html>app shell</html>');
  const shell = await worker.caches.open('drive-shell-v3');
  assert.equal(await shell.match(origin + '/api/list'), undefined);
  const script = await worker.dispatch('fetch', { request: new Request(origin + '/assets/main-v1.js') });
  assert.equal(await script.text(), 'static-resource');
});

test('blocked CacheStorage open/match and quota failures never replace valid online responses', async () => {
  for (const mode of ['open', 'match', 'put']) {
    const worker = await createWorker();
    worker.state.cacheFailure = mode;
    await worker.dispatch('activate');
    const session = await worker.dispatch('fetch', { request: new Request(origin + '/api/session') });
    assert.equal(session.status, 200, mode);
    assert.equal((await session.json()).authenticated, true, mode);
    const audio = await worker.fetch();
    assert.equal(audio.status, 200, mode); assert.equal(await audio.text(), '0123456789', mode);
    const navigation = await worker.dispatch('fetch', { request: { url: origin + '/', mode: 'navigate', method: 'GET' } });
    assert.equal(navigation.status, 200, mode); assert.equal(await navigation.text(), '<html>app shell</html>', mode);
    const asset = await worker.dispatch('fetch', { request: new Request(origin + '/assets/main-v2.js') });
    assert.equal(asset.status, 200, mode); assert.equal(await asset.text(), 'static-resource', mode);
    const sync = await worker.sync();
    if (mode === 'match') assert.equal(sync.session, null); else assert.ok(sync.error, mode);
    assert.ok((await worker.save()).error, mode);
    worker.state.offline = true;
    assert.equal((await worker.fetch()).status, 503, mode);
  }
});

test('quota failure in the lease clock and shell write still allows authenticated online playback', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  worker.state.cacheFailure = 'put'; worker.state.now += 2000;
  const response = await worker.fetch();
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789');
  assert.equal(worker.state.mediaCalls, 1);
  const navigation = await worker.dispatch('fetch', { request: { url: origin + '/', mode: 'navigate', method: 'GET' } });
  assert.equal(navigation.status, 200);
});

test('revocation works in memory even if storage becomes inaccessible and never revives the old Cookie', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  worker.state.cacheFailure = 'open';
  const result = await worker.message({ type: 'CLEAR_PRIVATE_AUDIO' });
  assert.ok(result.error);
  assert.ok(worker.messages.some(message => message.type === 'AUTH_REVOKED'));
  assert.equal((await worker.fetch()).status, 401);
  const before = worker.state.mediaCalls;
  await worker.sync();
  assert.equal((await worker.fetch()).status, 401);
  assert.equal(worker.state.mediaCalls, before);
});

test('legacy saved metadata gains album and lyrics without downloading, duplicating or rewriting audio', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, tracks: [track] });
  const media = await worker.caches.open(`audio-private-v3:${scopeA}`);
  const beforeKeys = (await media.keys()).map(request => request.url);
  let audioPuts = 0;
  worker.state.beforePut = async name => { if (name.startsWith('audio-private-v3:')) audioPuts++; };
  const fresh = { ...track, albumId: 'album_A', fileName: 'Example_demo.mp3', lyrics: { id: 'lyrics_file_1234567890', ver: 'lyrics_v1', format: 'lrc' } };
  assert.equal((await worker.message({ type: 'MIGRATE_SAVED_TRACKS', cacheScope: scopeA, tracks: [fresh] })).migrated, true);
  const meta = await worker.caches.open('drive-private-state-v3');
  const savedUrl = `${origin}/__private__/saved/${scopeA}`;
  const saved = await (await meta.match(savedUrl)).json();
  assert.equal(saved[0].albumId, 'album_A');
  assert.equal(saved[0].lyrics.id, fresh.lyrics.id);
  assert.equal(saved[0].savedUrl, url);
  const legacyCatalog = await (await meta.match(`${origin}/__private__/catalog/${scopeA}`)).json();
  assert.equal(legacyCatalog[0].albumId, 'album_A');
  const updatedLyrics = { ...fresh, lyrics: { ...fresh.lyrics, ver: 'lyrics_v2' } };
  await worker.message({ type: 'MIGRATE_SAVED_TRACKS', cacheScope: scopeA, tracks: [updatedLyrics] });
  assert.equal((await (await meta.match(savedUrl)).json())[0].lyrics.ver, 'lyrics_v2');
  assert.deepEqual((await media.keys()).map(request => request.url), beforeKeys);
  assert.equal(audioPuts, 0);
  worker.state.offline = true;
  assert.equal(await (await worker.fetch()).text(), '0123456789');
  assert.equal(worker.state.mediaCalls, 0);
});

test('an updated audio version cannot relabel an older completed saved file', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  await worker.message({ type: 'MIGRATE_SAVED_TRACKS', cacheScope: scopeA, tracks: [{ ...track, ver: 'version2', albumId: 'album_A', lyrics: { id: 'new-lyrics', ver: 'v2', format: 'txt' } }] });
  const meta = await worker.caches.open('drive-private-state-v3');
  const saved = await (await meta.match(`${origin}/__private__/saved/${scopeA}`)).json();
  assert.equal(saved[0].ver, 'version1'); assert.equal(saved[0].albumId, undefined); assert.equal(saved[0].lyrics, undefined);
  const media = await worker.caches.open(`audio-private-v3:${scopeA}`);
  assert.equal((await media.keys()).length, 1);
});

test('separate album catalogs and a single scope audio store remain available offline', async () => {
  const worker = await createWorker(); await worker.sync();
  const a = { ...track, albumId: 'album_A' };
  const b = { ...track, id: 'second_audio_file_1234567890', title: 'Second', ver: 'versionB', albumId: 'album_B' };
  const urlB = `${origin}/api/stream/${b.id}?v=${b.ver}`;
  const snapshot = { albums: [{ id: 'album_A', name: '3rd album' }, { id: 'album_B', name: 'Another album' }], defaultAlbumId: 'album_A' };
  assert.equal((await worker.message({ type: 'SAVE_LIBRARY', cacheScope: scopeA, snapshot })).saved, true);
  for (const item of [a, b]) {
    assert.equal((await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, albumId: item.albumId, tracks: [item] })).saved, true);
    assert.equal((await worker.message({ type: 'STORE_TRACK', cacheScope: scopeA, url: `${origin}/api/stream/${item.id}?v=${item.ver}`, track: item, blob: new Blob(['0123456789'], { type: 'audio/mpeg' }) })).saved, true);
  }
  const meta = await worker.caches.open('drive-private-state-v3');
  assert.deepEqual(await (await meta.match(`${origin}/__private__/library/${scopeA}`)).json(), snapshot);
  assert.equal((await (await meta.match(`${origin}/__private__/catalog/album_A/${scopeA}`)).json())[0].id, a.id);
  assert.equal((await (await meta.match(`${origin}/__private__/catalog/album_B/${scopeA}`)).json())[0].id, b.id);
  worker.state.offline = true;
  assert.equal((await worker.fetch()).status, 200);
  const second = await worker.dispatch('fetch', { request: new Request(urlB, { headers: { Range: 'bytes=2-4' } }) });
  assert.equal(second.status, 206); assert.equal(await second.text(), '234');
  assert.equal(worker.state.sessionCalls, 1); assert.equal(worker.state.mediaCalls, 0);
  await worker.message({ type: 'DELETE_TRACK', cacheScope: scopeA, url });
  const firstMissing = await worker.fetch(); assert.equal(firstMissing.status, 503);
  assert.equal((await worker.dispatch('fetch', { request: new Request(urlB) })).status, 200);
});

test('logout and scope changes remove all album catalogs and the library snapshot', async () => {
  for (const action of ['logout', 'scope-change']) {
    const worker = await createWorker(); await worker.sync();
    await worker.message({ type: 'SAVE_LIBRARY', cacheScope: scopeA, snapshot: { albums: [{ id: 'album_A', name: 'A' }, { id: 'album_B', name: 'B' }], defaultAlbumId: 'album_A' } });
    for (const albumId of ['album_A', 'album_B']) await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, albumId, tracks: [{ ...track, albumId }] });
    await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, tracks: [track] });
    if (action === 'logout') await worker.message({ type: 'CLEAR_PRIVATE_AUDIO' });
    else { worker.state.scope = scopeB; await worker.sync(); }
    const meta = await worker.caches.open('drive-private-state-v3');
    assert.equal((await meta.keys()).some(request => new URL(request.url).pathname.endsWith('/' + scopeA)), false, action);
  }
});

test('metadata waiting for a lease cannot be resurrected after logout', { timeout: 10000 }, async () => {
  for (const type of ['SAVE_CATALOG', 'SAVE_LIBRARY', 'MIGRATE_SAVED_TRACKS']) {
    const worker = await createWorker(); await worker.sync(); await worker.save();
    worker.state.now += 2000;
    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    worker.state.beforePut = async (name, request) => {
      if (name === 'drive-private-state-v3' && String(request).endsWith('/lease')) { started(); await wait; }
    };
    const pending = worker.message({ type, cacheScope: scopeA, albumId: 'album_A', tracks: [{ ...track, albumId: 'album_A' }], snapshot: { albums: [{ id: 'album_A', name: 'A' }], defaultAlbumId: 'album_A' } });
    await ready;
    const clearing = worker.message({ type: 'CLEAR_PRIVATE_AUDIO' });
    release();
    const [result] = await Promise.all([pending, clearing]);
    assert.ok(result.error, type);
    const meta = await worker.caches.open('drive-private-state-v3');
    assert.equal((await meta.keys()).some(request => /\/(?:catalog|library|saved)\//.test(new URL(request.url).pathname)), false, type);
  }
});

test('a catalog cannot be filed under a different album or without the active scope', async () => {
  const worker = await createWorker(); await worker.sync();
  assert.ok((await worker.message({ type: 'SAVE_CATALOG', cacheScope: scopeA, albumId: 'album_B', tracks: [{ ...track, albumId: 'album_A' }] })).error);
  assert.ok((await worker.message({ type: 'SAVE_LIBRARY', cacheScope: scopeB, snapshot: { albums: [{ id: 'album_A', name: 'A' }], defaultAlbumId: 'album_A' } })).error);
  assert.ok((await worker.message({ type: 'SAVE_LIBRARY', cacheScope: scopeA, snapshot: { albums: [{ id: 'album_A', name: 'A' }], defaultAlbumId: 'missing' } })).error);
});

test('artwork is cached privately on view and serves offline GET and HEAD within the allowance', async () => {
  const worker = await createWorker(); await worker.sync();
  const viewed = await worker.artwork();
  assert.equal(viewed.status, 200); assert.equal(viewed.headers.get('Content-Type'), 'image/png');
  assert.match(viewed.headers.get('Cache-Control'), /private.*no-store/);
  assert.equal(viewed.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(Buffer.from(await viewed.arrayBuffer()), png);
  worker.state.offline = true;
  const cached = await worker.artwork();
  assert.equal(cached.status, 200); assert.equal(cached.headers.get('X-Drive-Artwork-Cache'), 'stored');
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), png);
  const head = await worker.artwork({ method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), String(png.length)); assert.equal(await head.text(), '');
  assert.equal(worker.state.artworkCalls, 1); assert.equal(worker.state.sessionCalls, 1);
  const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
  assert.equal((await images.keys()).length, 1);
  assert.equal((await worker.caches.keys()).includes('drive-shell-v3'), false);
});

test('concurrent row/player/backdrop artwork requests share one bounded fetch', async () => {
  const worker = await createWorker(); await worker.sync();
  let release;
  worker.state.artworkGate = new Promise(resolve => { release = resolve; });
  const requests = [worker.artwork(), worker.artwork(), worker.artwork()];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(worker.state.artworkCalls, 1);
  release();
  for (const response of await Promise.all(requests)) { assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, png.length); }
});

test('cover versions are independent of saved audio, and older image versions are bounded', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.save();
  const audio = await worker.caches.open(`audio-private-v3:${scopeA}`);
  const initial = (await audio.keys()).map(request => request.url);
  for (const version of ['cover1', 'cover2', 'cover3']) {
    worker.state.now += 2;
    worker.state.artworkBytes = Buffer.concat([png, Buffer.from(version)]);
    assert.equal((await worker.artwork(undefined, `${origin}/api/artwork/${track.id}?v=${version}`)).status, 200);
  }
  const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
  const keys = (await images.keys()).map(request => new URL(request.url).searchParams.get('v'));
  assert.equal(keys.length, 2); assert.equal(keys.includes('cover1'), false);
  assert.equal(keys.includes('cover3'), true);
  assert.deepEqual((await audio.keys()).map(request => request.url), initial);
  assert.equal(await (await audio.match(url)).text(), '0123456789');
  assert.equal(worker.state.mediaCalls, 0);
});

test('artwork allowance expires and cannot be extended by offline views', async () => {
  const worker = await createWorker(); await worker.sync(); await worker.artwork();
  worker.state.offline = true; worker.state.now += 29 * 86400 * 1000;
  assert.equal((await worker.artwork()).status, 200);
  worker.state.now += 2 * 86400 * 1000;
  assert.equal((await worker.artwork()).status, 503);
  assert.equal(worker.state.artworkCalls, 1);
});

test('artwork logout, revocation and scope change never expose another scope cache', async () => {
  for (const action of ['logout', '401', 'new-scope']) {
    const worker = await createWorker(); await worker.sync(); await worker.artwork();
    if (action === 'logout') await worker.message({ type: 'CLEAR_PRIVATE_AUDIO' });
    else if (action === '401') { worker.state.authenticated = false; await worker.sync(); }
    else { worker.state.scope = scopeB; await worker.sync(); }
    assert.equal((await worker.caches.keys()).includes(`artwork-private-v1:${scopeA}`), false, action);
    worker.state.offline = true;
    assert.notEqual((await worker.artwork()).status, 200, action);
  }
});

test('logout prevents late artwork network responses and pending puts from restoring private images', { timeout: 10000 }, async () => {
  for (const stage of ['network', 'put']) {
    const worker = await createWorker(); await worker.sync();
    let started, release;
    const ready = new Promise(resolve => { started = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    if (stage === 'network') { worker.state.artworkFetched = started; worker.state.artworkGate = hold; }
    else worker.state.beforePut = async name => { if (name.startsWith('artwork-private-v1:')) { started(); await hold; } };
    const image = worker.artwork(); await ready;
    const clearing = worker.message({ type: 'CLEAR_PRIVATE_AUDIO' });
    release(); await Promise.all([image, clearing]);
    assert.equal((await worker.caches.keys()).includes(`artwork-private-v1:${scopeA}`), false, stage);
    assert.equal((await worker.artwork()).status, 401, stage);
  }
});

test('deleteTrack removes all image versions for that song without deleting other songs', async () => {
  const worker = await createWorker(); await worker.sync();
  await worker.artwork();
  worker.state.now += 2;
  await worker.artwork(undefined, `${origin}/api/artwork/${track.id}?v=cover2`);
  const other = `${origin}/api/artwork/other_audio_file_1234567890?v=otherCover`;
  await worker.artwork(undefined, other);
  await worker.message({ type: 'DELETE_TRACK', cacheScope: scopeA, url });
  const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
  assert.deepEqual((await images.keys()).map(request => request.url), [other]);
  await worker.artwork();
  assert.ok(await images.match(artUrl));
});

test('an image request begun before deleteTrack cannot restore its deleted image cache', async () => {
  const worker = await createWorker(); await worker.sync();
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  worker.state.artworkFetched = started;
  worker.state.artworkGate = new Promise(resolve => { release = resolve; });
  const image = worker.artwork(); await ready;
  await worker.message({ type: 'DELETE_TRACK', cacheScope: scopeA, url });
  release(); await image;
  const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
  assert.equal((await images.keys()).length, 0);
});

test('unsafe, over-limit and incomplete images never enter private or shell caches', async () => {
  for (const invalid of ['svg', 'mime-magic-mismatch', 'advertised-limit', 'stream-limit', 'incomplete']) {
    const worker = await createWorker(); await worker.sync();
    worker.state.artworkResponse = () => {
      if (invalid === 'svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } });
      if (invalid === 'mime-magic-mismatch') return new Response('<html>not a PNG</html>', { headers: { 'Content-Type': 'image/png' } });
      if (invalid === 'advertised-limit') return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(4 * 1024 * 1024 + 1) } });
      if (invalid === 'stream-limit') return new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } });
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length + 10) } });
    };
    assert.equal((await worker.artwork()).status, 502, invalid);
    const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
    assert.equal((await images.keys()).length, 0, invalid);
    await worker.message({ type: 'CACHE_SHELL', urls: [artUrl, `${origin}/api/artwork/fake.png?v=1`] });
    const shell = await worker.caches.open('drive-shell-v3');
    assert.equal(await shell.match(artUrl), undefined, invalid);
  }
});

test('storage refusal keeps online images visible while explicit saves report their cache outcome', async () => {
  for (const mode of ['open', 'put']) {
    const worker = await createWorker(); await worker.sync(); worker.state.cacheFailure = mode;
    const displayed = await worker.artwork();
    assert.equal(displayed.status, 200, mode); assert.equal((await displayed.arrayBuffer()).byteLength, png.length);
    const saved = await worker.artwork({ headers: { 'X-Drive-Artwork-Save': '1', 'X-Drive-Cache-Scope': scopeA } });
    assert.equal(saved.status, 200, mode);
    assert.equal(saved.headers.get('X-Drive-Artwork-Cache'), mode === 'put' ? 'quota' : 'unavailable');
  }
});

test('explicit artwork save confirms commit, rejects a different scope, and network HEAD creates no cache entry', async () => {
  const worker = await createWorker(); await worker.sync();
  const head = await worker.artwork({ method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const images = await worker.caches.open(`artwork-private-v1:${scopeA}`);
  assert.equal((await images.keys()).length, 0);
  assert.equal((await worker.artwork({ headers: { 'X-Drive-Artwork-Save': '1', 'X-Drive-Cache-Scope': scopeB } })).status, 409);
  const saved = await worker.artwork({ headers: { 'X-Drive-Artwork-Save': '1', 'X-Drive-Cache-Scope': scopeA } });
  assert.equal(saved.status, 200); assert.equal(saved.headers.get('X-Drive-Artwork-Cache'), 'stored');
  assert.ok(await images.match(artUrl));
});
