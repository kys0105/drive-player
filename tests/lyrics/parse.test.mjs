import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLyrics, readLyricsFile } from '../../src/lyrics/parse.ts';

test('LRC accepts BOM, CRLF, metadata, repeated timestamps and stable tied timestamps', () => {
  const parsed = parseLyrics('\uFEFF[ti:題名][ar:作者]\r\n[offset:500]\r\n[00:20.25][00:10.5]繰り返し\r\n[00:10.50]同時の行\r\n');
  assert.deepEqual(parsed, { synced: true, lines: [
    { time: 10, text: '繰り返し' }, { time: 10, text: '同時の行' }, { time: 19.75, text: '繰り返し' },
  ] });
});

test('global LRC offset works after the lyric lines, with negative offsets and zero clamping', () => {
  assert.deepEqual(parseLyrics('[00:01.00]一行\n[offset:-1000]').lines, [{ time: 2, text: '一行' }]);
  assert.deepEqual(parseLyrics('[offset:2000]\n[00:01.00]一行').lines, [{ time: 0, text: '一行' }]);
});

test('TXT preserves content and does not invent synchronization times', () => {
  assert.deepEqual(parseLyrics('一行目\r\n\r\n <b>そのままの文字</b> \n'), {
    synced: false, lines: [{ time: null, text: '一行目' }, { time: null, text: '<b>そのままの文字</b>' }],
  });
});

test('mixed timed and untimed lyric text is rejected rather than silently discarded', () => {
  assert.throws(() => parseLyrics('untimed preface\n[00:10]verse\nuntimed ending'), /時刻付きの行と時刻のない歌詞が混在/);
  assert.deepEqual(parseLyrics('[ti:曲]\n\n[00:10]一行\n[ar:作者]\n[00:20]二行'), {
    synced: true, lines: [{ time: 10, text: '一行' }, { time: 20, text: '二行' }],
  });
});

test('invalid LRC timestamps are rejected without losing lyric content', () => {
  assert.throws(() => parseLyrics('[00:75.00]失われてはいけない行'), /秒数/);
  assert.throws(() => parseLyrics('[00000:01]失われてはいけない行'), /時刻/);
});

test('empty lyrics and metadata-only inputs stay empty', () => {
  assert.deepEqual(parseLyrics('[ti:題名][ar:作者]\n\n[offset:500]'), { lines: [], synced: false });
});

test('large input and excessive expanded timestamp rows are rejected', () => {
  assert.throws(() => parseLyrics('あ'.repeat(200_001)), /20万文字/);
  assert.throws(() => parseLyrics('[00:01]'.repeat(5_001) + '一行'), /5,000行/);
});

test('file imports accept UTF-8 TXT/LRC and reject other formats or unreadable bytes', async () => {
  const utf8 = new File(['\uFEFF[00:01]歌詞'], 'song.LRC', { type: 'text/plain' });
  assert.equal(await readLyricsFile(utf8), '[00:01]歌詞');
  await assert.rejects(readLyricsFile(new File(['画像'], 'cover.png')), /TXTまたはLRC/);
  await assert.rejects(readLyricsFile(new File([new Uint8Array([0xff, 0xfe, 0xfd])], 'song.txt')), /UTF-8/);
  await assert.rejects(readLyricsFile(new File(['a\0b'], 'song.txt')), /テキスト形式/);
  await assert.rejects(readLyricsFile(new File([new Uint8Array(800_001)], 'song.txt')), /大きすぎ/);
});
