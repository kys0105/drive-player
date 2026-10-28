import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runtimeKey = 'drive-player.library-test-react';
const fixtureKey = 'drive-player.library-test-cache';
const compiled = await build({
  absWorkingDir: root, entryPoints: ['src/hooks/useLibrary.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022',
  plugins: [{ name: 'library-test-environment', setup(context) {
    context.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'library-test' }));
    context.onResolve({ filter: /\/utils\/cache$/ }, () => ({ path: 'cache', namespace: 'library-test' }));
    context.onLoad({ filter: /.*/, namespace: 'library-test' }, args => ({ contents: args.path === 'react'
      ? `const runtime=globalThis[Symbol.for('${runtimeKey}')]; export const useState=value=>runtime.state(value); export const useEffect=(callback,deps)=>runtime.effect(callback,deps); export const useCallback=callback=>callback;`
      : `const fixture=globalThis[Symbol.for('${fixtureKey}')]; export const loadLibrary=async()=>fixture.library; export const loadCatalog=async(_scope,id)=>fixture.catalogs.get(id)??[]; export const hasCatalog=async(_scope,id)=>fixture.catalogs.has(id); export const listSavedTracks=async()=>fixture.saved; export const saveLibrary=(...args)=>fixture.saveLibrary(...args); export const saveCatalog=(...args)=>fixture.saveCatalog(...args); export const migrateSavedTracks=async()=>{};`, loader: 'js' }));
  } }],
});

async function renderLibrary({ catalogs = new Map(), saved = [], online = false, remoteCatalogs = new Map(), initialWorkerReady = true, preferences = new Map() } = {}) {
  const slots = []; const effects = [];
  let cursor = 0, queued = false, output;
  const storage = new Map(preferences);
  const module = { exports: {} };
  const fixture = {
    library: { albums: [{ id: 'album_A', name: '3rd album' }, { id: 'album_B', name: 'Other' }], defaultAlbumId: 'album_A' },
    catalogs, saved, workerReady: initialWorkerReady, librarySaves: [], catalogSaves: [], albumRequests: 0, catalogRequests: 0,
    async saveLibrary(snapshot) {
      this.librarySaves.push(snapshot);
      if (!this.workerReady) throw new Error('Previous worker does not support SAVE_LIBRARY');
      this.library = snapshot;
    },
    async saveCatalog(tracks, _scope, id) {
      this.catalogSaves.push({ id, tracks });
      if (!this.workerReady) throw new Error('Previous worker does not support album catalogs');
      this.catalogs.set(id, tracks);
    },
  };
  let remoteLibrary = fixture.library;
  const workerListeners = new Map();
  const serviceWorker = {
    addEventListener(type, listener) {
      if (!workerListeners.has(type)) workerListeners.set(type, new Set());
      workerListeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { workerListeners.get(type)?.delete(listener); },
  };
  const expired = () => { throw new Error('An offline cached lookup must not revoke authentication'); };
  const render = () => {
    queued = false; cursor = 0;
    output = module.exports.useLibrary('test-scope-1234567890', online, expired);
    for (const run of effects.splice(0)) run();
  };
  const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };
  const runtime = {
    state(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; schedule(); }
      }];
    },
    effect(callback, dependencies) {
      const index = cursor++; const previous = slots[index];
      if (previous && dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) return;
      const slot = { dependencies, cleanup: previous?.cleanup };
      slots[index] = slot;
      effects.push(() => { slot.cleanup?.(); slot.cleanup = callback(); });
    },
  };
  const context = { module, exports: module.exports, AbortController,
    navigator: { serviceWorker },
    fetch: async (input, options) => {
      if (options?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = new URL(input, 'https://player.example');
      if (url.pathname === '/api/albums') { fixture.albumRequests++; return Response.json(remoteLibrary); }
      if (url.pathname === '/api/list') { fixture.catalogRequests++; return Response.json({ tracks: remoteCatalogs.get(url.searchParams.get('albumId')) ?? [] }); }
      throw new Error('Unexpected API request: ' + url.pathname);
    },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    [Symbol.for(runtimeKey)]: runtime, [Symbol.for(fixtureKey)]: fixture,
  };
  vm.runInNewContext(compiled.outputFiles[0].text, context, { filename: 'useLibrary.test-bundle.cjs' });
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
  render(); await flush();
  return {
    fixture, storage, get current() { return output; },
    async select(id) { output.selectAlbum(id); await flush(); },
    async controllerChange(snapshot) {
      fixture.workerReady = true;
      if (snapshot) remoteLibrary = snapshot;
      for (const listener of workerListeners.get('controllerchange') ?? []) listener({ type: 'controllerchange' });
      await flush();
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
    listenerCount() { return [...workerListeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); },
  };
}

const orderedTitles = ['紐', 'anchor', 'noah', 'ほしを継ぐもの', '4 Lib Isl', 'flowers3', 'milkomeda', 'ghost', '砂', '螺旋とは', 'Impulse'];
const orderKey = albumId => `drive-player.order.test-scope-1234567890.${albumId}`;
const legacyOrderKey = 'drive-player.order.test-scope-1234567890';
function songs(titles, albumId = 'album_A') {
  return titles.map(title => ({ id: `song-${orderedTitles.indexOf(title)}`, title, ver: 'v1', albumId }));
}
function titlesOf(hook) { return Array.from(hook.current.tracks, track => track.title); }

test('a new online library follows the shared album order and includes Impulse only when present', async () => {
  const received = songs([...orderedTitles].reverse());
  const hook = await renderLibrary({ online: true, remoteCatalogs: new Map([['album_A', received]]) });
  try {
    assert.deepEqual(titlesOf(hook), orderedTitles);
    assert.equal(hook.current.tracks.length, received.length);
    assert.equal(hook.current.tracks.at(-1).title, 'Impulse');
    assert.equal(hook.storage.get(orderKey('album_A')), undefined, 'default ordering must not become a frozen manual preference');
    assert.deepEqual(received.map(track => track.title), [...orderedTitles].reverse(), 'sorting must not mutate the received catalog');
  } finally { hook.dispose(); }
});

test('a cached offline album uses the shared order without creating a missing Impulse track', async () => {
  const available = orderedTitles.filter(title => title !== 'Impulse');
  const hook = await renderLibrary({ catalogs: new Map([['album_A', songs([...available].reverse())]]) });
  try {
    assert.deepEqual(titlesOf(hook), available);
    assert.equal(hook.current.tracks.length, 10);
    assert.equal(hook.current.tracks.some(track => track.title === 'Impulse'), false);
    assert.equal(hook.fixture.albumRequests, 0);
    assert.equal(hook.fixture.catalogRequests, 0);
  } finally { hook.dispose(); }
});

test('manual song IDs stay first while newly available songs follow the shared default order', async () => {
  const manual = JSON.stringify(['song-7', 'song-2']);
  const hook = await renderLibrary({
    online: true,
    remoteCatalogs: new Map([['album_A', songs([...orderedTitles].reverse())]]),
    preferences: new Map([[orderKey('album_A'), manual]]),
  });
  try {
    assert.deepEqual(titlesOf(hook), ['ghost', 'noah', ...orderedTitles.filter(title => title !== 'ghost' && title !== 'noah')]);
    assert.equal(hook.storage.get(orderKey('album_A')), manual, 'a new default must not overwrite an existing manual order');
  } finally { hook.dispose(); }
});

test('corrupt, invalid and stale manual preferences fall back to the shared order', async () => {
  for (const stored of ['{broken-json', '{"ids":[]}', '[null,42]', '["removed-song"]']) {
    const hook = await renderLibrary({
      catalogs: new Map([['album_A', songs(['ghost', 'noah', '紐'])]]),
      preferences: new Map([[orderKey('album_A'), stored]]),
    });
    try { assert.deepEqual(titlesOf(hook), ['紐', 'noah', 'ghost'], stored); }
    finally { hook.dispose(); }
  }
});

test('a manual album preference never changes another album or another authentication scope', async () => {
  const hook = await renderLibrary({
    catalogs: new Map([
      ['album_A', songs(['noah', 'ghost', '紐'])],
      ['album_B', songs(['noah', 'ghost', '紐'], 'album_B')],
    ]),
    preferences: new Map([
      [orderKey('album_A'), JSON.stringify(['song-7', 'song-0'])],
      ['drive-player.order.some-other-scope.album_B', JSON.stringify(['song-2', 'song-7', 'song-0'])],
    ]),
  });
  try {
    assert.deepEqual(titlesOf(hook), ['ghost', '紐', 'noah']);
    await hook.select('album_B');
    assert.deepEqual(titlesOf(hook), ['紐', 'noah', 'ghost']);
    await hook.select('album_A');
    assert.deepEqual(titlesOf(hook), ['ghost', '紐', 'noah']);
    assert.equal(hook.storage.get(orderKey('album_B')), undefined);
  } finally { hook.dispose(); }
});

test('legacy manual order migrates only to the default album and leaves other albums on the shared default', async () => {
  const legacy = JSON.stringify(['song-7', 'song-2']);
  const hook = await renderLibrary({
    catalogs: new Map([
      ['album_A', songs(['noah', 'ghost', '紐'])],
      ['album_B', songs(['noah', 'ghost', '紐'], 'album_B')],
    ]),
    preferences: new Map([[legacyOrderKey, legacy]]),
  });
  try {
    assert.deepEqual(titlesOf(hook), ['ghost', 'noah', '紐']);
    assert.equal(hook.storage.get(orderKey('album_A')), legacy);
    await hook.select('album_B');
    assert.deepEqual(titlesOf(hook), ['紐', 'noah', 'ghost']);
    assert.equal(hook.storage.get(orderKey('album_B')), undefined);
    assert.equal(hook.storage.get(legacyOrderKey), legacy);
  } finally { hook.dispose(); }
});

test('a default album with no catalog recovers legacy saved metadata without leaking another album', async () => {
  const legacy = { id: 'legacy-song', title: 'Old saved', ver: 'v1' };
  const a = { id: 'a', title: 'Saved A', ver: 'v1', albumId: 'album_A' };
  const b = { id: 'b', title: 'Saved B', ver: 'v1', albumId: 'album_B' };
  const hook = await renderLibrary({ saved: [legacy, a, b] });
  try {
    assert.equal(hook.current.albumId, 'album_A');
    assert.deepEqual(Array.from(hook.current.tracks, track => track.id), ['legacy-song', 'a']);
    assert.equal(hook.current.tracks[0].albumId, 'album_A');
    await hook.select('album_B');
    assert.deepEqual(Array.from(hook.current.tracks, track => track.id), ['b']);
    assert.equal(hook.current.loading, false);
  } finally { hook.dispose(); }
});

test('an explicitly empty default catalog never revives legacy catalog or saved songs', async () => {
  const legacy = { id: 'legacy-song', title: 'Old saved', ver: 'v1' };
  const hook = await renderLibrary({ catalogs: new Map([['album_A', []], [undefined, [legacy]]]), saved: [legacy, { ...legacy, id: 'a', albumId: 'album_A' }] });
  try {
    assert.equal(hook.current.albumId, 'album_A');
    assert.equal(hook.current.tracks.length, 0);
    assert.equal(hook.current.loading, false);
  } finally { hook.dispose(); }
});

test('an unfetched non-default album cannot claim legacy unassigned saved songs', async () => {
  const hook = await renderLibrary({ saved: [{ id: 'legacy', title: 'Legacy', ver: 'v1' }] });
  try {
    await hook.select('album_B');
    assert.equal(hook.current.tracks.length, 0);
    assert.match(hook.current.error, /まだ端末に保存されていません/);
  } finally { hook.dispose(); }
});

test('controllerchange retries online library and catalog persistence after an older worker rejected them', async () => {
  const remoteCatalogs = new Map([['album_A', [{ id: 'online-song', title: 'Online track', ver: 'v1', albumId: 'album_A' }]]]);
  const hook = await renderLibrary({ online: true, initialWorkerReady: false, remoteCatalogs });
  try {
    assert.equal(hook.listenerCount(), 1);
    assert.equal(hook.fixture.albumRequests, 1);
    assert.equal(hook.fixture.librarySaves.length, 1);
    assert.equal(hook.fixture.catalogs.has('album_A'), false);
    assert.equal(hook.current.tracks[0].id, 'online-song');
    await hook.controllerChange({ albums: [{ id: 'album_A', name: 'Updated 3rd album' }, { id: 'album_B', name: 'Other' }], defaultAlbumId: 'album_A' });
    assert.equal(hook.fixture.albumRequests, 2);
    assert.equal(hook.fixture.librarySaves.length, 2);
    assert.equal(hook.fixture.library.albums[0].name, 'Updated 3rd album');
    assert.equal(hook.current.album.name, 'Updated 3rd album');
    assert.equal(hook.fixture.catalogRequests, 2);
    assert.equal(hook.fixture.catalogs.get('album_A')[0].id, 'online-song');
  } finally { hook.dispose(); }
  assert.equal(hook.listenerCount(), 0);
});
