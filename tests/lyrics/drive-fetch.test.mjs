import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const { cacheDriveLyrics, loadDriveLyrics, LyricsAmbiguousError, LyricsSessionExpiredError } = await import('../../src/lyrics/drive.ts');
const { clearStoredLyrics, getStoredDriveLyrics, saveStoredDriveLyrics, saveStoredLyrics, getStoredLyrics } = await import('../../src/lyrics/storage.ts');
const track = { id: 'audio-1', title: '曲', albumId: 'album-1', ver: 'audio-v1' };
const scope = 'scope-a';
const identity = { scope, trackId: track.id };
const localIdentity = { ...identity, version: track.ver };
const asset = { id: 'lyric-1', ver: 'lyric-v1', format: 'lrc' };
const payload = (overrides = {}) => ({ audioId: track.id, albumId: track.albumId, lyrics: { ...asset, text: '[00:01]歌詞\n\n[00:02]次の段落' }, ...overrides });
const originalFetch = globalThis.fetch;
beforeEach(async () => { await clearStoredLyrics(); });
afterEach(() => { globalThis.fetch = originalFetch; });

test('Drive request authenticates the audio ID, validates its album, and saves lyrics separately from audio version', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return Response.json(payload()); };
  assert.equal(await cacheDriveLyrics(track, scope), 'saved');
  assert.equal(request.url, '/api/lyrics/audio-1');
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.cache, 'no-store');
  const record = await getStoredDriveLyrics(identity, asset);
  assert.equal(record.lyrics.fullText, '歌詞\n\n次の段落');
  assert.equal(record.asset.ver, 'lyric-v1');
  assert.equal(await cacheDriveLyrics({ ...track, ver: 'audio-v2' }, scope), 'saved');
  assert.ok(await getStoredDriveLyrics(identity, asset));
});

test('missing Drive lyrics and ambiguous matches never replace the preserved local source', async () => {
  await saveStoredLyrics(localIdentity, '端末の歌詞');
  await saveStoredDriveLyrics(identity, asset, '[00:01]旧共有歌詞');
  globalThis.fetch = async () => Response.json(payload({ lyrics: null }));
  assert.equal(await cacheDriveLyrics(track, scope), 'none');
  assert.equal(await getStoredDriveLyrics(identity), null);
  await saveStoredDriveLyrics(identity, asset, '[00:01]旧共有歌詞');
  globalThis.fetch = async () => Response.json(payload({ lyrics: null, issue: 'ambiguous' }));
  await assert.rejects(cacheDriveLyrics(track, scope), LyricsAmbiguousError);
  assert.equal(await getStoredDriveLyrics(identity), null);
  assert.equal((await getStoredLyrics(localIdentity)).text, '端末の歌詞');
});

test('401 clears every stored source and calls the expiration handler once before rejecting', async () => {
  await saveStoredLyrics(localIdentity, '端末歌詞');
  await saveStoredDriveLyrics(identity, asset, '[00:01]共有歌詞');
  await saveStoredDriveLyrics({ ...identity, scope: 'scope-b' }, asset, '[00:01]別の保存範囲');
  let expired = 0;
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(cacheDriveLyrics(track, scope, { onSessionExpired: () => { expired++; } }), LyricsSessionExpiredError);
  assert.equal(expired, 1);
  assert.equal(await getStoredLyrics(localIdentity), null);
  assert.equal(await getStoredDriveLyrics(identity), null);
  assert.equal(await getStoredDriveLyrics({ ...identity, scope: 'scope-b' }), null);
});

test('a delayed network response cannot restore lyrics after logout even if the fetch ignores abort', async () => {
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const loading = cacheDriveLyrics(track, scope);
  const result = loading.catch(error => error);
  await clearStoredLyrics();
  finish(Response.json(payload()));
  assert.equal((await result).name, 'AbortError');
  assert.equal(await getStoredDriveLyrics(identity), null);
});

test('an already cancelled request never fetches or saves', async () => {
  const controller = new AbortController(); controller.abort();
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(payload()); };
  await assert.rejects(cacheDriveLyrics(track, scope, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(requests, 0);
  assert.equal(await getStoredDriveLyrics(identity), null);
});

test('wrong audio/album, unsupported format, mixed text and oversized responses are rejected', async () => {
  const invalid = [payload({ audioId: 'another-song' }), payload({ albumId: 'another-album' }),
    payload({ lyrics: { ...asset, format: 'html', text: '歌詞' } }), payload({ lyrics: { ...asset, text: '[00:01]歌詞\n時刻なし' } })];
  for (const value of invalid) {
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(cacheDriveLyrics(track, scope));
    assert.equal(await getStoredDriveLyrics(identity), null);
  }
  globalThis.fetch = async () => new Response('x', { headers: { 'Content-Length': '2000000' } });
  await assert.rejects(cacheDriveLyrics(track, scope), /大きすぎ/);
  globalThis.fetch = async () => new Response('x'.repeat(1_300_000));
  await assert.rejects(cacheDriveLyrics(track, scope), /大きすぎ/);
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xfe]));
  await assert.rejects(cacheDriveLyrics(track, scope));
});

test('temporary HTTP failures do not erase a valid cached Drive source', async () => {
  await saveStoredDriveLyrics(identity, asset, '[00:01]保存した共有歌詞');
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(loadDriveLyrics(identity), /取得できません/);
  assert.equal((await getStoredDriveLyrics(identity)).text, '[00:01]保存した共有歌詞');
});

test('catalog ambiguity also removes an older Drive cache without making an arbitrary selection or fetching', async () => {
  await saveStoredDriveLyrics(identity, asset, '[00:01]古い共有歌詞');
  await saveStoredLyrics(localIdentity, 'この端末の歌詞');
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(payload()); };
  await assert.rejects(cacheDriveLyrics({ ...track, lyricsIssue: 'ambiguous' }, scope), LyricsAmbiguousError);
  assert.equal(requests, 0);
  assert.equal(await getStoredDriveLyrics(identity), null);
  assert.ok(await getStoredLyrics(localIdentity));
});

test('explicit app offline state uses cache even while navigator reports online, and explains a cache miss in Japanese', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'onLine');
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new TypeError('Failed to fetch'); };
  try {
    await saveStoredDriveLyrics(identity, asset, '[00:01]オフラインの歌詞');
    const result = await loadDriveLyrics(identity, { offline: true, asset });
    assert.equal(result.record.lyrics.fullText, 'オフラインの歌詞');
    assert.equal(result.cacheError, null);
    const missing = await loadDriveLyrics(identity, { offline: true, asset: { ...asset, ver: 'not-saved' } });
    assert.equal(missing.record, null);
    assert.match(missing.cacheError, /オフライン.*オンラインで.*保存/);
    await assert.rejects(loadDriveLyrics({ ...identity, trackId: 'not-saved' }, { offline: true, requireCache: true }), /オフライン/);
    assert.equal(requests, 0);
  } finally {
    if (previous) Object.defineProperty(navigator, 'onLine', previous);
    else delete navigator.onLine;
  }
});

test('browser network failures are localized for both lyric viewing and manual caching', async () => {
  const errors = [new TypeError('Failed to fetch'), new TypeError('Load failed'), new DOMException('A network failure', 'NetworkError'), new Error('NetworkError when attempting to fetch resource.')];
  for (const failure of errors) {
    globalThis.fetch = async () => { throw failure; };
    await assert.rejects(loadDriveLyrics(identity), /歌詞を取得できませんでした。通信状態を確認/);
    await assert.rejects(cacheDriveLyrics(track, scope), /歌詞を取得できませんでした。通信状態を確認/);
  }
});
