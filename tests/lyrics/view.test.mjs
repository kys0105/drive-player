import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseLyrics } from '../../src/lyrics/parse.ts';
import { activeLyricIndex, readLyricsMode, resolveLyricsMode, storeLyricsMode } from '../../src/lyrics/viewModel.ts';

const built = await build({ entryPoints: [fileURLToPath(new URL('../../src/lyrics/LyricsView.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], loader: { '.css': 'empty' } });
const module = { exports: {} };
new Function('require', 'exports', 'module', built.outputFiles[0].text)(createRequire(import.meta.url), module.exports, module);
const LyricsView = module.exports.default;
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
const render = (lyrics, props = {}) => renderToStaticMarkup(createElement(LyricsView, { lyrics, currentTime: 12, duration: 60, onSeek: () => {}, onAddLyrics: () => {}, ...props }));

test('the initial mode follows timed lyrics and preserves the explicit device choice', () => {
  storage.clear();
  assert.equal(readLyricsMode(), null);
  assert.equal(resolveLyricsMode(true, null), 'follow');
  storeLyricsMode('full');
  assert.equal(resolveLyricsMode(true, readLyricsMode()), 'full');
  assert.equal(resolveLyricsMode(false, 'follow'), 'full');
  // An untimed song does not overwrite the user's choice for later timed songs.
  storeLyricsMode('follow');
  assert.equal(resolveLyricsMode(false, readLyricsMode()), 'full');
  assert.equal(resolveLyricsMode(true, readLyricsMode()), 'follow');
  storage.clear();
});

test('active line lookup uses the final tied timestamp and handles before-start and end positions', () => {
  const lines = parseLyrics('[00:10]one\n[00:10]two\n[00:30]three').lines;
  assert.equal(activeLyricIndex(lines, 0), -1);
  assert.equal(activeLyricIndex(lines, 10), 1);
  assert.equal(activeLyricIndex(lines, 29.9), 1);
  assert.equal(activeLyricIndex(lines, 60), 2);
});

test('full mode renders original paragraphs without repeated timestamp expansion or seek buttons', () => {
  storeLyricsMode('full');
  const html = render(parseLyrics('[00:10][00:40]repeat\n\n[00:20]<b>text</b>'));
  assert.match(html, /class="lyrics-full">repeat\n\n&lt;b&gt;text&lt;\/b&gt;/);
  assert.equal(html.split('repeat').length - 1, 1);
  assert.doesNotMatch(html, /class="lyrics-line|から再生|aria-current/);
  assert.match(html, /aria-pressed="true">全文/);
  storage.clear();
});

test('follow mode is always switchable, marks the active line, and exposes seekable labels', () => {
  const html = render(parseLyrics('[00:10]first\n[00:20]second'));
  assert.match(html, /aria-label="歌詞の表示方法"/);
  assert.match(html, /aria-pressed="true">追従/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /0分10秒から再生/);
});

test('untimed text disables follow and loading, failure and absent states are distinct', () => {
  const plain = render(parseLyrics('first\n\nsecond'));
  assert.match(plain, /disabled="">追従/);
  assert.match(plain, /タイミング情報なし/);
  assert.match(plain, /class="lyrics-full">first\n\nsecond/);
  assert.match(render(null, { loading: true }), /歌詞を読み込んでいます/);
  assert.match(render(null, { error: '接続エラー', onRetry: () => {} }), /歌詞を取得できませんでした/);
  assert.match(render(null), /この曲の歌詞はまだありません/);
});
