import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const { clearStoredLyrics, createLyricsScopeGuard, getStoredDriveLyrics, saveStoredDriveLyrics, removeStoredDriveLyrics, saveStoredLyrics, getStoredLyrics } = await import('../../src/lyrics/storage.ts');
const identity = { scope: 'scope-a', trackId: 'song-1' };
const asset = { id: 'lyrics-1', ver: 'lyrics-md5-1', format: 'lrc' };
const localIdentity = { ...identity, version: 'audio-md5-1' };
beforeEach(async () => { await clearStoredLyrics(); });

test('Drive lyrics coexist with the existing local source and use a separate lyric version', async () => {
  await saveStoredLyrics(localIdentity, '端末だけの旧歌詞');
  await saveStoredDriveLyrics(identity, asset, '[00:01]共有の歌詞');
  assert.equal((await getStoredLyrics(localIdentity)).text, '端末だけの旧歌詞');
  assert.equal((await getStoredDriveLyrics(identity, asset)).text, '[00:01]共有の歌詞');
  assert.equal(await getStoredDriveLyrics(identity, { ...asset, ver: 'new-lyrics-version' }), null);
  assert.equal((await getStoredDriveLyrics({ ...identity, version: 'audio-md5-2' }, asset)).lyrics.fullText, '共有の歌詞');
  const newer = { ...asset, ver: 'lyrics-md5-2' };
  await saveStoredDriveLyrics(identity, newer, '[00:02]修正した歌詞');
  assert.equal((await getStoredDriveLyrics(identity, newer)).lyrics.lines[0].time, 2);
  assert.equal((await getStoredLyrics(localIdentity)).text, '端末だけの旧歌詞');
});

test('Drive lyrics are isolated by authenticated scope and song, and missing/current asset mismatches are rejected', async () => {
  await saveStoredDriveLyrics(identity, asset, '[00:01]共有の歌詞');
  assert.equal(await getStoredDriveLyrics({ ...identity, scope: 'other-scope' }), null);
  assert.equal(await getStoredDriveLyrics({ ...identity, trackId: 'other-song' }), null);
  assert.equal(await getStoredDriveLyrics(identity, { ...asset, id: 'different-file' }), null);
  assert.equal(await getStoredDriveLyrics(identity, { ...asset, format: 'txt' }), null);
  await assert.rejects(saveStoredDriveLyrics(identity, { ...asset, format: 'html' }, 'bad format'), /歌詞情報/);
});

test('a missing or ambiguous Drive association can discard only Drive cache while preserving local lyrics', async () => {
  await saveStoredLyrics(localIdentity, '残す歌詞');
  await saveStoredDriveLyrics(identity, asset, '[00:01]取り消す共有歌詞');
  await removeStoredDriveLyrics(identity);
  assert.equal(await getStoredDriveLyrics(identity), null);
  assert.equal((await getStoredLyrics(localIdentity)).text, '残す歌詞');
});

test('scope and global clear remove both source kinds and preserve unrelated scopes', async () => {
  const other = { ...identity, scope: 'scope-b' };
  await saveStoredLyrics(localIdentity, '端末歌詞');
  await saveStoredDriveLyrics(identity, asset, '[00:01]共有歌詞');
  await saveStoredDriveLyrics(other, asset, '[00:01]他の範囲');
  await clearStoredLyrics(identity.scope);
  assert.equal(await getStoredLyrics(localIdentity), null);
  assert.equal(await getStoredDriveLyrics(identity), null);
  assert.ok(await getStoredDriveLyrics(other));
  await clearStoredLyrics();
  assert.equal(await getStoredDriveLyrics(other), null);
});

test('a network/file guard captured before logout prevents a late remote write even after deletion finishes', async () => {
  const allowed = createLyricsScopeGuard(identity.scope);
  await clearStoredLyrics(identity.scope);
  await assert.rejects(saveStoredDriveLyrics(identity, asset, '[00:01]遅延した歌詞', allowed), /ログイン状態/);
  const writing = saveStoredDriveLyrics(identity, asset, '[00:01]書込中の歌詞');
  const result = writing.catch(error => error);
  await clearStoredLyrics();
  assert.match((await result).message, /ログイン状態/);
  assert.equal(await getStoredDriveLyrics(identity), null);
});
