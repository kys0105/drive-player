import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const {
  clearStoredLyrics, getStoredLyrics, saveStoredLyrics, removeStoredLyrics,
  lyricsIdentityKey, subscribeLyricsCleared,
} = await import('../../src/lyrics/storage.ts');

const identity = { scope: 'session-a', trackId: 'track-1', version: 'audio-md5-1' };
beforeEach(async () => { await clearStoredLyrics(); });

function openRaw() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('drive-player-lyrics-v1', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putRaw(record) {
  const db = await openRaw();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('lyrics', 'readwrite');
      transaction.objectStore('lyrics').put(record);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

test('lyrics persist as source text and reparse on a later read', async () => {
  const saved = await saveStoredLyrics(identity, '[00:01.50]本物の入力');
  assert.deepEqual(saved.lyrics, { synced: true, lines: [{ time: 1.5, text: '本物の入力' }] });
  const read = await getStoredLyrics({ ...identity });
  assert.equal(read.text, '[00:01.50]本物の入力');
  assert.deepEqual(read.lyrics, saved.lyrics);
  assert.equal(typeof read.updatedAt, 'number');
  assert.equal('sample' in read.lyrics, false);
});

test('scope, song and audio version isolate saved lyrics, including separator-like IDs', async () => {
  const variants = [
    identity,
    { ...identity, scope: 'session-b' },
    { ...identity, trackId: 'track-2' },
    { ...identity, version: 'audio-md5-2' },
    { scope: 'a:b', trackId: 'c', version: 'd' },
    { scope: 'a', trackId: 'b:c', version: 'd' },
  ];
  for (let index = 0; index < variants.length; index++) await saveStoredLyrics(variants[index], '歌詞' + index);
  for (let index = 0; index < variants.length; index++) assert.equal((await getStoredLyrics(variants[index])).text, '歌詞' + index);
  assert.equal(await getStoredLyrics({ ...identity, version: 'updated-audio' }), null);
});

test('invalid or empty input cannot overwrite existing lyrics', async () => {
  await saveStoredLyrics(identity, '保存済み');
  await assert.rejects(saveStoredLyrics(identity, '[00:10]同期\n同期しない'), /混在/);
  await assert.rejects(saveStoredLyrics(identity, ' \n '), /歌詞を入力/);
  assert.equal((await getStoredLyrics(identity)).text, '保存済み');
});

test('removing one song does not erase another version', async () => {
  const other = { ...identity, version: 'other-version' };
  await saveStoredLyrics(identity, '一つ目');
  await saveStoredLyrics(other, '別版');
  await removeStoredLyrics(identity);
  assert.equal(await getStoredLyrics(identity), null);
  assert.equal((await getStoredLyrics(other)).text, '別版');
});

test('scope clear notifies consumers immediately and preserves unrelated scopes', async () => {
  const other = { ...identity, scope: 'session-b' };
  await saveStoredLyrics(identity, '消す歌詞');
  await saveStoredLyrics(other, '残す歌詞');
  const notifications = [];
  const unsubscribe = subscribeLyricsCleared((scope) => { notifications.push(scope); });
  const clearing = clearStoredLyrics(identity.scope);
  assert.deepEqual(notifications, ['session-a']);
  await clearing;
  unsubscribe();
  assert.equal(await getStoredLyrics(identity), null);
  assert.equal((await getStoredLyrics(other)).text, '残す歌詞');
});

test('global clear removes all persisted scopes', async () => {
  await saveStoredLyrics(identity, '一つ目');
  await saveStoredLyrics({ ...identity, scope: 'session-b' }, '二つ目');
  await clearStoredLyrics();
  assert.equal(await getStoredLyrics(identity), null);
  assert.equal(await getStoredLyrics({ ...identity, scope: 'session-b' }), null);
});

test('a save started before logout cannot resurrect lyrics after scope clear', async () => {
  const saving = saveStoredLyrics(identity, '書き込み中');
  const outcome = saving.catch((error) => error);
  await clearStoredLyrics(identity.scope);
  assert.match((await outcome).message, /ログイン状態が変更/);
  assert.equal(await getStoredLyrics(identity), null);
});

test('new saves are blocked while a global clear is in progress', async () => {
  await saveStoredLyrics(identity, '既存の歌詞');
  const clearing = clearStoredLyrics();
  await assert.rejects(saveStoredLyrics(identity, '再生成してはいけない'), /ログイン状態が変更/);
  await clearing;
  assert.equal(await getStoredLyrics(identity), null);
});

test('corrupted persisted records cannot cross identity boundaries or inject invalid parsed state', async () => {
  await putRaw({ ...identity, key: lyricsIdentityKey(identity), scope: 'another-scope', text: '別の人の歌詞', updatedAt: Date.now() });
  assert.equal(await getStoredLyrics(identity), null);
  await putRaw({ ...identity, key: lyricsIdentityKey(identity), text: '[00:10]歌詞\n時刻なし', updatedAt: Date.now(), lyrics: { sample: true } });
  assert.equal(await getStoredLyrics(identity), null);
});
