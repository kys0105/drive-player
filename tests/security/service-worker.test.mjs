import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const workerSource = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
const origin = 'https://player.example';
const streamUrl = `${origin}/.netlify/functions/stream/audio_file_1234567890?v=version1`;
const scopeA = 'session-scope-AAAAAAAAAAAAAAAA';
const scopeB = 'session-scope-BBBBBBBBBBBBBBBB';

async function createWorker(cacheScope = scopeA) {
  const listeners = new Map();
  const storage = new Map();
  const messages = [];
  const state = {
    authenticated: true,
    offline: false,
    cacheScope,
    sessionCalls: 0,
    mediaCalls: 0,
    beforePut: undefined,
  };
  function keyOf(request) {
    return typeof request === 'string' ? new URL(request, origin).href : request.url;
  }
  const cacheStorage = {
    async keys() {
      return [...storage.keys()];
    },
    async delete(name) {
      return storage.delete(name);
    },
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(request) {
          return entries.get(keyOf(request))?.clone();
        },
        async put(request, response) {
          if (state.beforePut) await state.beforePut();
          entries.set(keyOf(request), response.clone());
        },
        async delete(request) {
          return entries.delete(keyOf(request));
        },
        async keys() {
          return [...entries.keys()].map((url) => new Request(url));
        },
      };
    },
  };
  const workerFetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href), origin);
    if (url.pathname.endsWith('/session')) {
      state.sessionCalls++;
      if (state.offline) throw new TypeError('Network unavailable');
      if (!state.authenticated) return Response.json({ authenticated: false }, { status: 401 });
      return Response.json({
        authenticated: true,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        cacheScope: state.cacheScope,
      });
    }
    assert.equal(url.origin, origin);
    assert.match(url.pathname, /^\/\.netlify\/functions\/stream\//);
    state.mediaCalls++;
    const isRange = typeof input !== 'string' && input.headers.has('Range');
    return new Response(`audio-for-${state.cacheScope}`, {
      status: isRange ? 206 : 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };
  const self = {
    location: new URL(origin),
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    skipWaiting() {},
    clients: {
      async claim() {},
      async matchAll() {
        return [
          {
            postMessage(message) {
              messages.push(message);
            },
          },
        ];
      },
    },
  };
  vm.runInNewContext(
    workerSource,
    {
      self,
      caches: cacheStorage,
      fetch: workerFetch,
      Request,
      Response,
      Headers,
      URL,
      console,
      setTimeout,
      clearTimeout,
    },
    { filename: 'public/sw.js' }
  );

  async function dispatch(type, properties = {}) {
    const pending = [];
    let responsePromise;
    const event = {
      ...properties,
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
      respondWith(promise) {
        responsePromise = Promise.resolve(promise);
      },
    };
    listeners.get(type)?.(event);
    const response = responsePromise ? await responsePromise : undefined;
    await Promise.all(pending);
    return response;
  }
  return {
    state,
    storage,
    messages,
    caches: cacheStorage,
    fetch: (init) => dispatch('fetch', { request: new Request(streamUrl, init) }),
    message: (data, port) => dispatch('message', { data, ports: port ? [port] : [] }),
    dispatch,
  };
}

test('a cached audio response is never returned after server-side authentication expires', async () => {
  const worker = await createWorker();
  const first = await worker.fetch();
  assert.equal(await first.text(), `audio-for-${scopeA}`);
  assert.equal(worker.state.mediaCalls, 1);
  worker.state.authenticated = false;
  const afterExpiry = await worker.fetch();
  assert.equal(afterExpiry.status, 401);
  assert.notEqual(await afterExpiry.text(), `audio-for-${scopeA}`);
  assert.equal(worker.state.sessionCalls, 2);
  assert.equal(worker.state.mediaCalls, 1);
});

test('a network failure during session validation cannot expose cached private audio', async () => {
  const worker = await createWorker();
  await worker.fetch();
  worker.state.offline = true;
  const offline = await worker.fetch();
  assert.equal(offline.status, 503);
  assert.equal(worker.state.mediaCalls, 1);
});

test('cached audio is isolated between independently signed session scopes', async () => {
  const worker = await createWorker();
  assert.equal(await (await worker.fetch()).text(), `audio-for-${scopeA}`);
  worker.state.cacheScope = scopeB;
  assert.equal(await (await worker.fetch()).text(), `audio-for-${scopeB}`);
  assert.equal(worker.state.mediaCalls, 2);
  assert.equal(await (await worker.fetch()).text(), `audio-for-${scopeB}`);
  assert.equal(worker.state.mediaCalls, 2);
  assert.equal(worker.state.sessionCalls, 3);
});

test('one browser logout leaves another browser private cache and playback intact', async () => {
  const [browserA, browserB] = await Promise.all([createWorker(scopeA), createWorker(scopeB)]);
  const [firstA, firstB] = await Promise.all([browserA.fetch(), browserB.fetch()]);
  assert.equal(await firstA.text(), `audio-for-${scopeA}`);
  assert.equal(await firstB.text(), `audio-for-${scopeB}`);
  const browserBCacheNames = await browserB.caches.keys();
  assert.equal(browserBCacheNames.length, 1);

  browserA.state.authenticated = false;
  await browserA.message({ type: 'CLEAR_PRIVATE_AUDIO', cacheScope: scopeA });
  assert.equal((await browserA.caches.keys()).length, 0);
  const [afterLogoutA, continuedB] = await Promise.all([browserA.fetch(), browserB.fetch()]);
  assert.equal(afterLogoutA.status, 401);
  assert.equal(continuedB.status, 200);
  assert.equal(await continuedB.text(), `audio-for-${scopeB}`);
  assert.deepEqual(await browserB.caches.keys(), browserBCacheNames);
  assert.equal(browserB.state.sessionCalls, 2);
  assert.equal(browserB.state.mediaCalls, 1);
});

test('range responses and HEAD responses pass through authenticated network requests without being cached', async () => {
  const worker = await createWorker();
  for (let i = 0; i < 2; i++) {
    const range = await worker.fetch({ headers: { Range: 'bytes=0-1' } });
    assert.equal(range.status, 206);
    await worker.fetch({ method: 'HEAD' });
  }
  assert.equal(worker.state.mediaCalls, 4);
  assert.equal(worker.state.sessionCalls, 4);
  assert.equal(
    [...worker.storage.values()].reduce((sum, entries) => sum + entries.size, 0),
    0
  );
});

test('logout clears legacy and private caches and rejects requests with the revoked scope', async () => {
  const worker = await createWorker();
  const oldCache = await worker.caches.open('audio-v1');
  await oldCache.put(streamUrl, new Response('previously-public-audio'));
  await worker.fetch();
  let acknowledgement;
  await worker.message(
    { type: 'CLEAR_PRIVATE_AUDIO', cacheScope: scopeA },
    {
      postMessage(message) {
        acknowledgement = message;
      },
    }
  );
  assert.equal(acknowledgement?.cleared, true);
  assert.equal(
    (await worker.caches.keys()).filter(
      (name) => name === 'audio-v1' || name.startsWith('audio-private-v2:')
    ).length,
    0
  );
  const response = await worker.fetch();
  assert.equal(response.status, 401);
  assert.equal(worker.state.mediaCalls, 1);
});

test(
  'logout waits for an in-flight cache write and prevents it from restoring private audio',
  { timeout: 10_000 },
  async () => {
    const worker = await createWorker();
    let signalWrite;
    let allowWrite;
    const writeStarted = new Promise((resolve) => {
      signalWrite = resolve;
    });
    const writeReleased = new Promise((resolve) => {
      allowWrite = resolve;
    });
    worker.state.beforePut = async () => {
      signalWrite();
      await writeReleased;
    };
    const playback = worker.fetch();
    await writeStarted;
    const clearing = worker.message({ type: 'CLEAR_PRIVATE_AUDIO', cacheScope: scopeA });
    allowWrite();
    await Promise.all([playback, clearing]);
    assert.equal(
      (await worker.caches.keys()).filter((name) => name.startsWith('audio-private-v2:')).length,
      0
    );
    const afterLogout = await worker.fetch();
    assert.equal(afterLogout.status, 401);
  }
);

test('activation removes the old public audio cache', async () => {
  const worker = await createWorker();
  const oldCache = await worker.caches.open('audio-v1');
  await oldCache.put(streamUrl, new Response('legacy-audio'));
  await worker.dispatch('activate');
  assert.equal((await worker.caches.keys()).includes('audio-v1'), false);
});

test('cross-origin stream lookalikes are not intercepted', async () => {
  const worker = await createWorker();
  const response = await worker.dispatch('fetch', {
    request: new Request(
      'https://attacker.example/.netlify/functions/stream/audio_file_1234567890?v=version1'
    ),
  });
  assert.equal(response, undefined);
  assert.equal(worker.state.sessionCalls, 0);
});
