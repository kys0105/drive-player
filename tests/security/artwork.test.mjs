import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { assertPrivate, clearDriveMock, loadFunction, request, sessionCookie, setDriveMock } from './helpers.mjs';

const rootId = 'artwork_root_fixture', albumId = 'artwork_album_fixture', audioId = 'artwork_audio_fixture', coverId = 'artwork_image_fixture';
// Original 20 x 20 solid-colour images, generated solely as regression fixtures.
const images = {
  png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVQ4jWMQ9y8nGzGMai4fDbDy0URSPpoxygeuMAAAb45ZYEzLKXIAAAAASUVORK5CYII=', 'base64'),
  jpg: Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAUABQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCXAKFOAAAAAAP/2Q==', 'base64'),
  webp: Buffer.from('UklGRkYAAABXRUJQVlA4IDoAAAAwAwCdASoUABQAPm0ylUekIqIhKAgAgA2JZQB2AACBxLwAAP7yIl//hyp9O3sf/+A3XxaxOeM8gAAA', 'base64'),
};
const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const password = 'artwork-regression-passphrase', salt = Buffer.from('only-for-tests!!');
const env = Object.fromEntries(['APP_PASSWORD_HASH', 'SESSION_SECRET', 'FOLDER_ID', 'DEFAULT_ALBUM_ID', 'GOOGLE_SERVICE_ACCOUNT_BASE64'].map(key => [key, process.env[key]]));
const nativeFetch = globalThis.fetch, handlers = {};
const digest = bytes => createHash('md5').update(bytes).digest('hex');
let cookie, nodes, bodies, mediaCalls, driveCalls, listOverride, metadataOverride, responseOverride, mediaRequest;
function put(id, name, type, parent, body) {
  const bytes = body === undefined ? undefined : Buffer.from(body);
  const file = { id, name, mimeType: type, parents: [parent], trashed: false, ...(bytes ? { size: String(bytes.length), md5Checksum: digest(bytes) } : {}) };
  nodes.set(id, file); if (bytes) bodies.set(id, bytes); return file;
}
function authorized(path, init = {}) { const headers = new Headers(init.headers); headers.set('Cookie', cookie); return request(path, { ...init, headers }); }
function path(version = nodes.get(coverId)?.md5Checksum) { return `/api/artwork/${audioId}?v=${encodeURIComponent(version ?? '')}`; }
async function listing() { const response = await handlers.list(authorized(`/api/list?albumId=${albumId}`)); assert.equal(response.status, 200); return (await response.json()).tracks; }

before(async () => {
  const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
  process.env.SESSION_SECRET = 'artwork-fixture-session-secret-at-least-32-bytes';
  process.env.FOLDER_ID = rootId;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({ client_email: 'fixture@example.invalid', private_key: 'fixture-only' });
  for (const name of ['artwork', 'list', 'login', 'logout']) handlers[name] = await loadFunction(name, { directory: 'api', webExport: true });
  const response = await handlers.login(request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }));
  assert.equal(response.status, 200); cookie = sessionCookie(response);
});
beforeEach(() => {
  delete process.env.DEFAULT_ALBUM_ID;
  nodes = new Map(); bodies = new Map(); mediaCalls = 0; driveCalls = 0; mediaRequest = null;
  listOverride = null; metadataOverride = null; responseOverride = null;
  put(rootId, '00_試聴用', 'application/vnd.google-apps.folder', 'outside_music_parent');
  put(albumId, '3rd album', 'application/vnd.google-apps.folder', rootId);
  put(audioId, 'café_demo.mp3', 'audio/mpeg', albumId, 'fixture audio');
  put(coverId, 'café_demo.png', 'image/png', albumId, images.png);
  setDriveMock(() => {
    driveCalls++;
    return {
      files: {
        async get({ fileId }) {
          const original = nodes.get(fileId);
          const file = metadataOverride?.(fileId, original) ?? original;
          if (!file) throw Object.assign(new Error('private upstream details'), { code: 404 });
          return { data: structuredClone(file) };
        },
        async list(args) {
          const parent = /^'([A-Za-z0-9_-]+)' in parents and trashed=false$/.exec(args.q)?.[1];
          assert.ok(parent);
          const files = [...nodes.values()].filter(file => file.parents.includes(parent) && file.trashed === false);
          return { data: { files: structuredClone(listOverride ? listOverride(files) : files) } };
        },
      },
      context: { _options: { auth: { async getAccessToken() { return { token: 'artwork-fixture-token' }; } } } },
    };
  });
  globalThis.fetch = async (input, init) => {
    mediaCalls++;
    const url = new URL(String(input)), id = url.pathname.split('/').pop();
    mediaRequest = { url, ...init };
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.searchParams.get('alt'), 'media');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer artwork-fixture-token');
    assert.equal(new Headers(init.headers).get('Accept-Encoding'), 'identity');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return responseOverride ? responseOverride(id) : new Response(bodies.get(id), { headers: { 'Content-Type': nodes.get(id)?.mimeType, 'Content-Length': String(bodies.get(id)?.length ?? 0) } });
  };
});
afterEach(() => { globalThis.fetch = nativeFetch; clearDriveMock(); });
after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('artwork authentication, origin, method and version validation precede Drive access', async () => {
  assert.equal((await handlers.artwork(request(path()))).status, 401);
  assert.equal((await handlers.artwork(authorized(path(), { origin: 'https://attacker.example' }))).status, 403);
  const wrongMethod = await handlers.artwork(authorized(path(), { method: 'POST' }));
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('Allow'), 'GET, HEAD');
  for (const invalid of ['/api/artwork', '/api/artwork?audioId=a&audioId=b', '/api/artwork/bad/id?v=x', `/api/artwork/${audioId}`, `${path()}&v=two`]) {
    assert.equal((await handlers.artwork(authorized(invalid))).status, 400);
  }
  assert.equal(driveCalls, 0); assert.equal(mediaCalls, 0);
});

test('list exposes only private cover identity and preserves the audio version', async () => {
  const audioVersion = nodes.get(audioId).md5Checksum;
  nodes.get(audioId).thumbnailLink = 'https://private.invalid/thumbnail';
  const [track] = await listing();
  assert.deepEqual(track.cover, { id: coverId, ver: digest(images.png), format: 'png' });
  assert.equal(track.ver, audioVersion); assert.equal(track.artwork, undefined);
  assert.equal(JSON.stringify(track).includes('private.invalid'), false);
  bodies.set(coverId, images.webp); nodes.get(coverId).md5Checksum = digest(images.webp);
  assert.equal((await listing())[0].ver, audioVersion);
});

test('real PNG, JPEG and WebP return their verified MIME, no-store headers, GET and HEAD', async () => {
  for (const format of ['png', 'jpg', 'webp']) {
    put(coverId, `café_demo.${format}`, mime[format], albumId, images[format]);
    for (const endpoint of [path(), `/api/artwork?audioId=${audioId}&v=${digest(images[format])}`, `/.netlify/functions/artwork/${audioId}?v=${digest(images[format])}`]) {
      const response = await handlers.artwork(authorized(endpoint));
      assert.equal(response.status, 200, format); assertPrivate(assert, response);
      assert.equal(response.headers.get('Content-Type'), mime[format]);
      assert.equal(response.headers.get('Content-Length'), String(images[format].length));
      assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), images[format]);
    }
    const head = await handlers.artwork(authorized(path(), { method: 'HEAD' }));
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get('Content-Length'), String(images[format].length));
    assert.notEqual(mediaRequest.method, 'HEAD', 'HEAD must validate the actual bounded image body too');
  }
});

test('association is exact original basename in NFC, case sensitive, with format priorities', async () => {
  nodes.get(coverId).name = 'cafe\u0301_demo.png';
  put('jpeg_cover', 'café_demo.JPEG', 'image/jpeg', albumId, images.jpg);
  put('webp_cover', 'café_demo.webp', 'image/webp', albumId, images.webp);
  assert.deepEqual((await listing())[0].cover, { id: 'webp_cover', ver: digest(images.webp), format: 'webp' });
  nodes.delete('webp_cover'); assert.equal((await listing())[0].cover.id, 'jpeg_cover');
  nodes.delete('jpeg_cover'); assert.equal((await listing())[0].cover.id, coverId);
  nodes.get(coverId).name = 'Café_demo.png'; assert.equal((await listing())[0].cover, undefined);
  nodes.get(coverId).name = 'café.png'; assert.equal((await listing())[0].cover, undefined);
});

test('lossless and extended alpha WebP headers are supported while animated containers are refused', async () => {
  for (const base64 of [
    'UklGRh4AAABXRUJQVlA4TBEAAAAvE8AEAAfQp170rv+BiOh/AAA=',
    'UklGRmoAAABXRUJQVlA4WAoAAAAQAAAAEwAAEwAAQUxQSAoAAAABB9C7iAhERP8DVlA4IDoAAAAwAwCdASoUABQAPm0ylUekIqIhKAgAgA2JZQB2AACBxLwAAP7yIl//hyp9O3sf/+A3XxaxOeM8gAAA',
  ]) {
    const bytes = Buffer.from(base64, 'base64');
    put(coverId, 'café_demo.webp', 'image/webp', albumId, bytes);
    assert.equal((await handlers.artwork(authorized(path()))).status, 200);
  }
  const animated = Buffer.from(bodies.get(coverId)); animated[20] |= 2;
  put(coverId, 'café_demo.webp', 'image/webp', albumId, animated);
  assert.equal((await handlers.artwork(authorized(path()))).status, 415);
});

test('octet-stream uploads require a supported extension and matching actual image signature', async () => {
  nodes.get(coverId).mimeType = 'application/octet-stream';
  assert.equal((await handlers.artwork(authorized(path()))).status, 200);
  put(coverId, 'café_demo.webp', 'application/octet-stream', albumId, images.png);
  assert.equal((await handlers.artwork(authorized(path()))).status, 415);
});

test('same-priority duplicates and duplicate audio names are ambiguous without falling back', async () => {
  put('duplicate_cover', 'café_demo.PNG', 'image/png', albumId, images.png);
  let track = (await listing())[0]; assert.equal(track.cover, undefined); assert.equal(track.coverIssue, 'ambiguous');
  assert.equal((await handlers.artwork(authorized(path()))).status, 409);
  nodes.delete('duplicate_cover');
  put('jpg_one', 'café_demo.jpg', 'image/jpeg', albumId, images.jpg);
  put('jpg_two', 'café_demo.jpeg', 'image/jpeg', albumId, images.jpg);
  track = (await listing())[0]; assert.equal(track.cover, undefined); assert.equal(track.coverIssue, 'ambiguous');
  nodes.delete('jpg_one'); nodes.delete('jpg_two');
  put('duplicate_audio', 'café_demo.MP3', 'audio/mpeg', albumId, 'other audio');
  assert.ok((await listing()).every(item => !item.cover && item.coverIssue === 'ambiguous'));
  assert.equal(mediaCalls, 0);
});

test('root audio stays supported; other albums, deeper folders and outside folders cannot supply covers', async () => {
  nodes.get(audioId).parents = [rootId]; nodes.get(coverId).parents = [rootId];
  assert.equal((await handlers.artwork(authorized(path()))).status, 200);
  nodes.get(audioId).parents = [albumId];
  assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  for (const parent of ['outside_folder', 'nested_folder']) {
    put(parent, parent, 'application/vnd.google-apps.folder', parent === 'nested_folder' ? albumId : 'outside');
    nodes.get(audioId).parents = [parent]; nodes.get(coverId).parents = [parent];
    assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  }
  assert.equal(mediaCalls, 1);
});

test('the endpoint accepts an authorized audio identity, never an arbitrary image or document identity', async () => {
  assert.equal((await handlers.artwork(authorized(`/api/artwork/${coverId}?v=${nodes.get(coverId).md5Checksum}`))).status, 404);
  put('private_document', 'private.png', 'image/png', albumId, images.png);
  nodes.delete(coverId);
  assert.equal((await handlers.artwork(authorized(path(digest(images.png))))).status, 404);
  assert.equal(mediaCalls, 0);
});

test('moving an authorized album outside root and shortcut or trashed audio deny before media reads', async () => {
  nodes.get(albumId).parents = ['outside'];
  assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  nodes.get(albumId).parents = [rootId];
  nodes.get(audioId).mimeType = 'application/vnd.google-apps.shortcut';
  assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  nodes.get(audioId).mimeType = 'audio/mpeg'; nodes.get(audioId).trashed = true;
  assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  assert.equal(mediaCalls, 0);
});

test('same-name files cannot replace an audio renamed between metadata and child listing', async () => {
  listOverride = files => files.map(file => file.id === audioId ? { ...file, name: 'other.mp3' } : file)
    .concat({ ...nodes.get(audioId), id: 'new_same_name_audio' });
  assert.equal((await handlers.artwork(authorized(path()))).status, 409);
  assert.equal(mediaCalls, 0);
});

test('a cover moved, renamed, trashed or replaced by a shortcut after listing is rejected', async () => {
  for (const changes of [{ parents: ['outside'] }, { name: 'other.png' }, { trashed: true }, { mimeType: 'application/vnd.google-apps.shortcut' }, { id: 'other_id' }]) {
    metadataOverride = (id, original) => id === coverId ? { ...original, ...changes } : original;
    assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  }
  assert.equal(mediaCalls, 0);
});

test('stale query versions and metadata versions fail with 409 before reading bytes', async () => {
  assert.equal((await handlers.artwork(authorized(path('old-version')))).status, 409);
  metadataOverride = (id, file) => id === coverId ? { ...file, md5Checksum: 'a'.repeat(32) } : file;
  assert.equal((await handlers.artwork(authorized(path()))).status, 409);
  assert.equal(mediaCalls, 0);
});

test('byte checksum protects the advertised cover version even when image headers still look valid', async () => {
  const changed = Buffer.from(images.png); changed[42] ^= 1;
  responseOverride = () => new Response(changed, { headers: { 'Content-Type': 'image/png' } });
  assert.equal((await handlers.artwork(authorized(path()))).status, 409);
});

test('modifiedTime fallback is checked again after content reads', async () => {
  delete nodes.get(coverId).md5Checksum; nodes.get(coverId).modifiedTime = '2026-10-28T00:00:00Z';
  assert.equal((await handlers.artwork(authorized(path(nodes.get(coverId).modifiedTime)))).status, 200);
  let count = 0;
  metadataOverride = (id, file) => id === coverId && ++count > 1 ? { ...file, modifiedTime: '2026-10-28T00:00:01Z' } : file;
  assert.equal((await handlers.artwork(authorized(path(nodes.get(coverId).modifiedTime)))).status, 409);
});

test('SVG, HTML, wrong signatures and malformed or truncated image containers are never returned', async () => {
  for (const payload of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from('<html>private</html>'), images.jpg, images.png.subarray(0, 28), images.png.subarray(0, -1)]) {
    put(coverId, 'café_demo.png', 'image/png', albumId, payload);
    const response = await handlers.artwork(authorized(path()));
    assert.equal(response.status, 415); assertPrivate(assert, response);
  }
  put(coverId, 'café_demo.svg', 'image/svg+xml', albumId, images.png);
  assert.equal((await listing())[0].cover, undefined);
  assert.equal((await handlers.artwork(authorized(path()))).status, 404);
  put(coverId, 'café_demo.png', 'image/png', albumId, images.png);
  responseOverride = () => new Response(images.png, { headers: { 'Content-Type': 'text/html' } });
  assert.equal((await handlers.artwork(authorized(path()))).status, 415);
});

test('image signatures compare exact bytes without ASCII high-bit masking', async () => {
  for (const [format, index] of [['webp', 0], ['webp', 8], ['webp', 12], ['png', 12]]) {
    const bytes = Buffer.from(images[format]); bytes[index] |= 0x80;
    put(coverId, `café_demo.${format}`, mime[format], albumId, bytes);
    assert.equal((await handlers.artwork(authorized(path()))).status, 415);
  }
});

test('metadata, announced and streamed size limits reject and cancel upstream reads', async () => {
  nodes.get(coverId).size = String(4 * 1024 * 1024 + 1);
  assert.equal((await handlers.artwork(authorized(path()))).status, 413); assert.equal(mediaCalls, 0);
  nodes.get(coverId).size = '1';
  let cancelled = false;
  responseOverride = () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'image/png', 'Content-Length': String(4 * 1024 * 1024 + 1) } });
  assert.equal((await handlers.artwork(authorized(path()))).status, 413); assert.equal(cancelled, true);
  cancelled = false;
  responseOverride = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'image/png' } });
  assert.equal((await handlers.artwork(authorized(path()))).status, 413); assert.equal(cancelled, true);
});

test('image dimensions limit every supported container before returning it', async () => {
  const largePng = Buffer.from(images.png); largePng.writeUInt32BE(5000, 16);
  const largeJpeg = Buffer.from(images.jpg); const sof = largeJpeg.indexOf(Buffer.from([0xff, 0xc0])); largeJpeg.writeUInt16BE(5000, sof + 7);
  const largeWebp = Buffer.from(images.webp); largeWebp.writeUInt16LE(5000, 26);
  for (const [format, bytes] of [['png', largePng], ['jpg', largeJpeg], ['webp', largeWebp]]) {
    put(coverId, `café_demo.${format}`, mime[format], albumId, bytes);
    assert.equal((await handlers.artwork(authorized(path()))).status, 413, format);
  }
  const tooManyPixels = Buffer.from(images.png); tooManyPixels.writeUInt32BE(4096, 16); tooManyPixels.writeUInt32BE(4096, 20);
  put(coverId, 'café_demo.png', 'image/png', albumId, tooManyPixels);
  assert.equal((await handlers.artwork(authorized(path()))).status, 413);
});

test('upstream errors are private and request cancellation is passed to the bounded fetch', async () => {
  const controller = new AbortController(); controller.abort();
  responseOverride = () => { assert.equal(mediaRequest.signal.aborted, true); throw new Error('private upstream details'); };
  let response = await handlers.artwork(authorized(path(), { signal: controller.signal }));
  assert.equal(response.status, 502); assertPrivate(assert, response); assert.doesNotMatch(await response.text(), /private upstream/);
  responseOverride = () => new Response('private upstream error', { status: 403 });
  response = await handlers.artwork(authorized(path())); assert.equal(response.status, 502);
});
