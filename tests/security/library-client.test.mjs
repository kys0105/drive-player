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

async function renderLibrary({ catalogs = new Map(), saved = [], online = false, remoteCatalogs = new Map(), initialWorkerReady = true } = {}) {
  const slots = []; const effects = [];
  let cursor = 0, queued = false, output;
  const storage = new Map();
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
    fixture, get current() { return output; },
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
