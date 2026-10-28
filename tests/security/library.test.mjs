import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { assertPrivate, clearDriveMock, loadFunction, request, sessionCookie, setDriveMock } from './helpers.mjs';

const rootId = 'library_root_fixture', albumId = 'album_three_fixture', audioId = 'audio_noah_fixture';
const password = 'library-regression-passphrase', salt = Buffer.from('only-for-tests!!');
const originalEnv = Object.fromEntries(['APP_PASSWORD_HASH', 'SESSION_SECRET', 'FOLDER_ID', 'DEFAULT_ALBUM_ID', 'GOOGLE_SERVICE_ACCOUNT_BASE64'].map(key => [key, process.env[key]]));
const nativeFetch = globalThis.fetch;
const handlers = {};
let cookie, nodes, bodies, metadataCalls, driveCalls, mediaCalls, listOverride, responseType;
const digest = bytes => createHash('md5').update(bytes).digest('hex');
function put(id, name, mimeType, parent, body) {
  const bytes = body === undefined ? undefined : Buffer.from(body);
  const file = { id, name, mimeType, parents: [parent], trashed: false, ...(bytes ? { size: String(bytes.length), md5Checksum: digest(bytes) } : {}) };
  nodes.set(id, file); if (bytes) bodies.set(id, bytes); return file;
}
function authorized(path, init = {}) { const headers = new Headers(init.headers); headers.set('Cookie', cookie); return request(path, { ...init, headers }); }
async function json(name, path) { const response = await handlers[name](authorized(path)); assert.equal(response.status, 200); assertPrivate(assert, response); assert.equal(response.headers.get('Vercel-CDN-Cache-Control'), 'no-store'); return response.json(); }

before(async () => {
  const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
  process.env.SESSION_SECRET = 'library-fixture-session-secret-at-least-32-bytes';
  process.env.FOLDER_ID = rootId;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({ client_email: 'fixture@example.invalid', private_key: 'fixture-only' });
  for (const name of ['albums', 'list', 'lyrics', 'stream', 'login']) handlers[name] = await loadFunction(name, { directory: 'api', webExport: true });
  const response = await handlers.login(request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }));
  assert.equal(response.status, 200); cookie = sessionCookie(response);
});
beforeEach(() => {
  delete process.env.DEFAULT_ALBUM_ID;
  nodes = new Map(); bodies = new Map(); metadataCalls = []; driveCalls = 0; mediaCalls = 0; listOverride = null; responseType = null;
  put(rootId, '00_試聴用', 'application/vnd.google-apps.folder', 'outside_music_parent');
  put(albumId, '3rd album', 'application/vnd.google-apps.folder', rootId);
  put('album_two_fixture', '2nd album', 'application/vnd.google-apps.folder', rootId);
  put('album_ten_fixture', '10th album', 'application/vnd.google-apps.folder', rootId);
  put(audioId, 'noah_demo.mp3', 'audio/mpeg', albumId, 'test audio bytes');
  put('lyrics_noah_fixture', 'noah_demo.lrc', 'text/plain', albumId, '[00:00.00]一行目\n\n[00:05.00]二行目\n');
  setDriveMock(() => {
    driveCalls++;
    return {
      files: {
        async get({ fileId }) { metadataCalls.push(fileId); const file = nodes.get(fileId); if (!file) throw Object.assign(new Error('private upstream details'), { code: 404 }); return { data: structuredClone(file) }; },
        async list(args) {
          const parent = /^'([A-Za-z0-9_-]+)' in parents and trashed=false$/.exec(args.q)?.[1];
          assert.ok(parent, 'query must be restricted to one validated parent');
          const files = [...nodes.values()].filter(file => file.parents.includes(parent) && file.trashed === false);
          return { data: listOverride ? listOverride(args, files) : { files: structuredClone(files) } };
        },
      },
      context: { _options: { auth: { async getAccessToken() { return { token: 'fixture-media-token' }; } } } },
    };
  });
  globalThis.fetch = async (input, init) => {
    mediaCalls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-media-token');
    assert.equal(init.redirect, 'error');
    const id = url.pathname.split('/').pop();
    const body = bodies.get(id) ?? Buffer.from('audio');
    const range = new Headers(init.headers).get('Range');
    const headers = { 'Content-Type': responseType ?? nodes.get(id)?.mimeType ?? 'application/octet-stream', 'Content-Length': String(body.length), ...(range ? { 'Content-Range': `bytes 0-${body.length - 1}/${body.length}` } : {}) };
    return new Response(init.method === 'HEAD' ? null : body, { status: range ? 206 : 200, headers });
  };
});
afterEach(() => { globalThis.fetch = nativeFetch; clearDriveMock(); });
after(() => { for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

test('library APIs reject anonymous/cross-site/unsupported methods before Drive access', async () => {
  for (const [name, path] of [['albums', '/api/albums'], ['list', `/api/list?albumId=${albumId}`], ['lyrics', `/api/lyrics/${audioId}`]]) {
    assert.equal((await handlers[name](request(path))).status, 401);
    assert.equal((await handlers[name](authorized(path, { origin: 'https://attacker.example' }))).status, 403);
    assert.equal((await handlers[name](authorized(path, { method: 'POST' }))).status, 405);
  }
  assert.equal(driveCalls, 0); assert.equal(mediaCalls, 0);
});

test('albums are naturally ordered immediate folders; legacy root wins while it contains audio', async () => {
  let value = await json('albums', '/api/albums');
  assert.deepEqual(value.albums.map(album => album.name), ['2nd album', '3rd album', '10th album']);
  assert.equal(value.defaultAlbumId, albumId);
  put('legacy_audio_fixture', 'legacy.mp3', 'audio/mpeg', rootId, 'old same bytes');
  process.env.DEFAULT_ALBUM_ID = 'album_ten_fixture';
  value = await json('albums', '/api/albums');
  assert.deepEqual(value.albums[0], { id: rootId, name: '試聴用', legacy: true });
  assert.equal(value.defaultAlbumId, rootId);
  const legacy = await json('list', '/api/list'); assert.equal(legacy.album.id, rootId); assert.equal(legacy.tracks[0].id, 'legacy_audio_fixture');
});

test('default album supports a validated explicit ID, unique 3rd album, then natural first', async () => {
  process.env.DEFAULT_ALBUM_ID = 'album_ten_fixture'; assert.equal((await json('albums', '/api/albums')).defaultAlbumId, 'album_ten_fixture');
  process.env.DEFAULT_ALBUM_ID = 'outside_folder'; put('outside_folder', 'outside', 'application/vnd.google-apps.folder', 'outside_parent');
  assert.equal((await handlers.albums(authorized('/api/albums'))).status, 503);
  delete process.env.DEFAULT_ALBUM_ID; nodes.get(albumId).name = 'Other album';
  assert.equal((await json('albums', '/api/albums')).defaultAlbumId, 'album_two_fixture');
});

test('album listing preserves audio identity/version and pairs original basename, not formatted title', async () => {
  put('wrong_lyrics_fixture', 'noah.lrc', 'text/plain', albumId, '[00:00.00]wrong');
  put('txt_lyrics_fixture', 'noah_demo.txt', 'text/plain', albumId, 'plain fallback');
  const value = await json('list', `/api/list?albumId=${albumId}`);
  assert.equal(value.album.id, albumId); assert.equal(value.tracks.length, 1);
  assert.equal(value.tracks[0].title, 'noah'); assert.equal(value.tracks[0].fileName, 'noah_demo.mp3');
  assert.equal(value.tracks[0].ver, nodes.get(audioId).md5Checksum);
  assert.deepEqual(value.tracks[0].lyrics, { id: 'lyrics_noah_fixture', ver: nodes.get('lyrics_noah_fixture').md5Checksum, format: 'lrc' });
});

test('lyrics returns original text/paragraphs privately and has an independent version', async () => {
  const value = await json('lyrics', `/api/lyrics/${audioId}`);
  assert.equal(value.audioId, audioId); assert.equal(value.albumId, albumId);
  assert.equal(value.lyrics.text, '[00:00.00]一行目\n\n[00:05.00]二行目\n');
  const audioVersion = nodes.get(audioId).md5Checksum;
  put('lyrics_noah_fixture', 'noah_demo.lrc', 'text/plain', albumId, '[00:01.00]更新した行\n');
  const changed = await json('lyrics', `/api/lyrics?audioId=${audioId}`);
  assert.notEqual(value.lyrics.ver, changed.lyrics.ver); assert.equal(nodes.get(audioId).md5Checksum, audioVersion);
});

test('TXT fallback, absent lyrics and ignored Google Docs/HTML files are distinguished', async () => {
  nodes.delete('lyrics_noah_fixture');
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).lyrics, null);
  put('docs_fixture', 'noah_demo.lrc', 'application/vnd.google-apps.document', albumId);
  put('html_fixture', 'noah_demo.lrc', 'text/html', albumId, '<html>not lyrics</html>');
  put('txt_fixture', 'noah_demo.txt', 'text/plain', albumId, '普通の歌詞\n\n次の段落');
  const value = await json('lyrics', `/api/lyrics/${audioId}`);
  assert.equal(value.lyrics.format, 'txt'); assert.equal(value.lyrics.text, '普通の歌詞\n\n次の段落');
});

test('duplicate preferred lyrics and duplicate audio names never select a random match', async () => {
  put('duplicate_lrc_fixture', 'noah_demo.lrc', 'text/plain', albumId, '[00:00.00]別の歌詞');
  let value = await json('lyrics', `/api/lyrics/${audioId}`);
  assert.equal(value.lyrics, null); assert.equal(value.issue, 'ambiguous'); assert.equal(mediaCalls, 0);
  assert.equal((await json('list', `/api/list?albumId=${albumId}`)).tracks[0].lyricsIssue, 'ambiguous');
  nodes.delete('duplicate_lrc_fixture'); put('duplicate_audio_fixture', 'noah_demo.mp3', 'audio/mpeg', albumId, 'other audio');
  value = await json('lyrics', `/api/lyrics/${audioId}`); assert.equal(value.issue, 'ambiguous'); assert.equal(value.lyrics, null);
});

test('audio renamed or moved between metadata and folder listing cannot inherit another audio file lyrics', async () => {
  for (const moved of [false, true]) {
    listOverride = (_args, files) => ({ files: [
      ...files.filter(file => !moved || file.id !== audioId).map(file => file.id === audioId ? { ...file, name: 'other.mp3' } : file),
      { ...nodes.get(audioId), id: 'replacement_audio_fixture' },
    ] });
    const value = await json('lyrics', `/api/lyrics/${audioId}`);
    assert.equal(value.lyrics, null); assert.equal(value.issue, 'ambiguous');
  }
  assert.equal(mediaCalls, 0);
});

test('root and album moves preserve cookie/audio IDs while each request rechecks membership', async () => {
  nodes.get(rootId).parents = ['new_music_parent'];
  const before = await handlers.stream(authorized(`/api/stream/${audioId}`)); assert.equal(before.status, 200);
  nodes.get(albumId).parents = ['outside_parent'];
  assert.equal((await handlers.stream(authorized(`/api/stream/${audioId}`))).status, 404);
  assert.equal((await handlers.lyrics(authorized(`/api/lyrics/${audioId}`))).status, 404);
  nodes.get(albumId).parents = [rootId]; nodes.get(audioId).parents = [rootId];
  assert.equal((await handlers.stream(authorized(`/api/stream/${audioId}`))).status, 200);
  nodes.get(audioId).parents = [albumId]; assert.equal((await json('list', '/api/list')).tracks[0].id, audioId);
});

test('outside, nested, deleted and shortcut folders cannot be selected or used for streaming', async () => {
  put('outside_folder', 'outside', 'application/vnd.google-apps.folder', 'outside_parent');
  put('nested_folder', 'nested', 'application/vnd.google-apps.folder', albumId);
  put('shortcut_folder', 'shortcut', 'application/vnd.google-apps.shortcut', rootId);
  const deleted = put('deleted_folder', 'deleted', 'application/vnd.google-apps.folder', rootId); deleted.trashed = true;
  for (const id of ['outside_folder', 'nested_folder', 'shortcut_folder', 'deleted_folder']) {
    assert.equal((await handlers.list(authorized(`/api/list?albumId=${id}`))).status, 404);
    put(`audio_${id}`, 'bad.mp3', 'audio/mpeg', id, 'bytes');
    assert.equal((await handlers.stream(authorized(`/api/stream/audio_${id}`))).status, 404);
  }
  const values = await json('albums', '/api/albums'); assert.ok(!values.albums.some(album => ['shortcut_folder', 'deleted_folder', 'nested_folder', 'outside_folder'].includes(album.id)));
});

test('invalid root and trashed/shortcut audio or lyrics are never served', async () => {
  nodes.get(rootId).trashed = true;
  assert.equal((await handlers.albums(authorized('/api/albums'))).status, 404);
  nodes.get(rootId).trashed = false; nodes.get(audioId).mimeType = 'application/vnd.google-apps.shortcut';
  assert.equal((await handlers.stream(authorized(`/api/stream/${audioId}`))).status, 404);
  nodes.get(audioId).mimeType = 'audio/mpeg'; nodes.get('lyrics_noah_fixture').trashed = true;
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).lyrics, null);
});

test('same-name lyrics in another album are not exposed and arbitrary document IDs are not accepted', async () => {
  nodes.delete('lyrics_noah_fixture');
  put('other_lyrics_fixture', 'noah_demo.lrc', 'text/plain', 'album_two_fixture', '[00:00.00]private to other album');
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).lyrics, null);
  assert.equal((await handlers.lyrics(authorized('/api/lyrics/other_lyrics_fixture'))).status, 404);
  assert.equal(mediaCalls, 0);
});

test('UTF-8 BOM is accepted while invalid UTF-8, binary, HTML and oversized text fail closed', async () => {
  put('lyrics_noah_fixture', 'noah_demo.lrc', 'text/plain', albumId, '\uFEFF[00:00.00]歌詞\r\n\r\n[00:01.00]次の行');
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).lyrics.text, '[00:00.00]歌詞\r\n\r\n[00:01.00]次の行');
  for (const [body, status] of [[Buffer.from([0xc3, 0x28]), 415], [Buffer.from('bad\u0000text'), 415], [Buffer.from('a'.repeat(200_001)), 413], [Buffer.from('x\n'.repeat(5_001)), 413], [Buffer.alloc(800_001, 65), 413]]) {
    put('lyrics_noah_fixture', 'noah_demo.lrc', 'text/plain', albumId, body);
    assert.equal((await handlers.lyrics(authorized(`/api/lyrics/${audioId}`))).status, status);
  }
  put('lyrics_noah_fixture', 'noah_demo.lrc', 'text/plain', albumId, '<html>bad upstream response</html>'); responseType = 'text/html';
  assert.equal((await handlers.lyrics(authorized(`/api/lyrics/${audioId}`))).status, 415);
});

test('lyrics edited during metadata/content reads never get cached under a stale version', async () => {
  bodies.set('lyrics_noah_fixture', Buffer.from('[00:00.00]changed without matching metadata'));
  assert.equal((await handlers.lyrics(authorized(`/api/lyrics/${audioId}`))).status, 409);
});

test('unannounced oversized lyric bodies are bounded and cancelled while streaming', async () => {
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(800_001)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'text/plain' } });
  assert.equal((await handlers.lyrics(authorized(`/api/lyrics/${audioId}`))).status, 413);
  assert.equal(cancelled, true);
});

test('Unicode-equivalent basenames pair only when the result is unique', async () => {
  nodes.get(audioId).name = 'Cafe\u0301.mp3'; nodes.get('lyrics_noah_fixture').name = 'Café.lrc';
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).lyrics.id, 'lyrics_noah_fixture');
  put('unicode_duplicate_fixture', 'Cafe\u0301.lrc', 'text/plain', albumId, '[00:00.00]別の歌詞');
  assert.equal((await json('lyrics', `/api/lyrics/${audioId}`)).issue, 'ambiguous');
});

test('an empty root remains a valid empty legacy list for older clients', async () => {
  for (const id of [...nodes.keys()]) if (id !== rootId) nodes.delete(id);
  assert.deepEqual(await json('albums', '/api/albums'), { albums: [], defaultAlbumId: null });
  const value = await json('list', '/api/list'); assert.deepEqual(value.album, { id: rootId, name: '試聴用', legacy: true }); assert.deepEqual(value.tracks, []);
});

test('album audio keeps authenticated Range and HEAD with private headers', async () => {
  const range = await handlers.stream(authorized(`/api/stream/${audioId}`, { headers: { Range: 'bytes=0-' } }));
  assert.equal(range.status, 206); assertPrivate(assert, range); assert.match(range.headers.get('Content-Range'), /^bytes 0-/);
  const head = await handlers.stream(authorized(`/api/stream/${audioId}`, { method: 'HEAD' })); assert.equal(head.status, 200); assert.equal(await head.text(), '');
});

test('malformed/duplicate album or rewritten audio parameters fail without interpolation', async () => {
  for (const path of ['/api/list?albumId=bad%27id', `/api/list?albumId=${albumId}&albumId=${rootId}`, '/api/list?albumId=']) assert.equal((await handlers.list(authorized(path))).status, 400);
  for (const path of ['/api/lyrics', '/api/lyrics?audioId=one&audioId=two', '/api/lyrics?audioId=bad%2Fid']) assert.equal((await handlers.lyrics(authorized(path))).status, 400);
});

test('paged metadata is fully collected and repeated page tokens fail safely', async () => {
  listOverride = (args, files) => args.pageToken ? { files: files.slice(1) } : { files: files.slice(0, 1), nextPageToken: 'second' };
  assert.equal((await json('albums', '/api/albums')).albums.length, 3);
  listOverride = (_args, files) => ({ files, nextPageToken: 'repeated' });
  assert.equal((await handlers.albums(authorized('/api/albums'))).status, 502);
});
