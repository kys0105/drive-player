import type { LyricsAsset, Track } from '../types.ts';
import { clearLocalSession } from '../utils/session.ts';
import { normalizeLyricsError } from './errors.ts';
import { MAX_LYRIC_CHARACTERS, parseLyrics } from './parse.ts';
import {
  clearStoredLyrics, createLyricsScopeGuard, getStoredDriveLyrics, removeStoredDriveLyrics, saveStoredDriveLyrics,
  subscribeLyricsCleared, validLyricsAsset, type DriveLyricsIdentity, type StoredDriveLyrics,
} from './storage.ts';

export type DriveLyricsOptions = { signal?: AbortSignal; onSessionExpired?: () => void; offline?: boolean };
export type DriveLyricsResult = { record: StoredDriveLyrics | null; cacheError: string | null };
const MAX_RESPONSE_BYTES = MAX_LYRIC_CHARACTERS * 6 + 16_384;
const OFFLINE_MESSAGE = 'オフラインのため歌詞を取得できません。オンラインでこの曲の歌詞を保存してください。';

export class LyricsSessionExpiredError extends Error {
  constructor() { super('ログインの有効期限が切れました。もう一度ログインしてください。'); this.name = 'LyricsSessionExpiredError'; }
}
export class LyricsAmbiguousError extends Error {
  constructor() { super('対応する歌詞が複数あります。Driveの同名ファイルを確認してください。'); this.name = 'LyricsAmbiguousError'; }
}

function aborted(): DOMException { return new DOMException('Aborted', 'AbortError'); }

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('歌詞の応答が大きすぎます。');
  if (!response.body) throw new Error('歌詞の応答を読み込めませんでした。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw aborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('歌詞の応答が大きすぎます。');
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Authenticated, bounded fetch. This never blocks audio playback. */
export async function loadDriveLyrics(identity: DriveLyricsIdentity, options: DriveLyricsOptions & { albumId?: string; asset?: LyricsAsset; requireCache?: boolean } = {}): Promise<DriveLyricsResult> {
  const allowed = createLyricsScopeGuard(identity.scope);
  if (options.offline || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
    if (options.signal?.aborted || !allowed()) throw aborted();
    const cached = await getStoredDriveLyrics(identity, options.asset);
    if (options.signal?.aborted || !allowed()) throw aborted();
    if (!cached && options.requireCache) throw new Error(OFFLINE_MESSAGE);
    return { record: cached, cacheError: cached ? null : OFFLINE_MESSAGE };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  const unsubscribe = subscribeLyricsCleared(scope => { if (scope === undefined || scope === identity.scope) abort(); });
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  const check = () => { if (controller.signal.aborted || options.signal?.aborted || !allowed()) throw aborted(); };
  try {
    check();
    const response = await fetch('/api/lyrics/' + encodeURIComponent(identity.trackId), {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
    });
    if (!allowed()) throw aborted();
    if (response.status === 401) {
      clearLocalSession();
      const clearing = clearStoredLyrics();
      // Notify immediately, including when IndexedDB deletion is slow or unavailable.
      try { options.onSessionExpired?.(); } finally { await clearing.catch(() => {}); }
      throw new LyricsSessionExpiredError();
    }
    check();
    if (!response.ok) throw new Error('Driveの歌詞を取得できませんでした。再試行してください。');
    const value = await readJson(response, controller.signal);
    check();
    if (!value || typeof value !== 'object' || !('audioId' in value) || value.audioId !== identity.trackId ||
        !('albumId' in value) || (value.albumId !== null && typeof value.albumId !== 'string') ||
        (options.albumId && value.albumId !== options.albumId) || !('lyrics' in value)) {
      throw new Error('歌詞と曲の対応を確認できませんでした。曲一覧を更新してください。');
    }
    if ('issue' in value && value.issue === 'ambiguous') {
      await removeStoredDriveLyrics(identity, allowed);
      throw new LyricsAmbiguousError();
    }
    if (value.lyrics === null) {
      await removeStoredDriveLyrics(identity, allowed);
      check();
      return { record: null, cacheError: null };
    }
    const data = value.lyrics;
    if (!validLyricsAsset(data) || !('text' in data) || typeof data.text !== 'string') throw new Error('歌詞の形式を確認できませんでした。');
    const lyrics = parseLyrics(data.text);
    if (!lyrics.lines.length) throw new Error('Driveの歌詞ファイルに本文がありません。');
    const asset = { id: data.id, ver: data.ver, format: data.format };
    const record: StoredDriveLyrics = { ...identity, asset, text: data.text, updatedAt: Date.now(), lyrics };
    try {
      await saveStoredDriveLyrics(identity, asset, data.text, () => allowed() && !controller.signal.aborted);
      check();
      return { record, cacheError: null };
    } catch (error: unknown) {
      check();
      if (options.requireCache) throw error;
      return { record, cacheError: '歌詞は表示できますが、この端末への保存に失敗しました。' };
    }
  } catch (error: unknown) {
    throw normalizeLyricsError(error);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Call after saving audio; lyric and audio versions are intentionally independent. */
export async function cacheDriveLyrics(track: Track, scope: string, options: DriveLyricsOptions = {}): Promise<'saved' | 'none'> {
  if (track.lyricsIssue === 'ambiguous') {
    const allowed = createLyricsScopeGuard(scope);
    if (options.signal?.aborted) throw aborted();
    await removeStoredDriveLyrics({ scope, trackId: track.id }, () => allowed() && !options.signal?.aborted);
    throw new LyricsAmbiguousError();
  }
  const result = await loadDriveLyrics({ scope, trackId: track.id }, { ...options, albumId: track.albumId, requireCache: true });
  return result.record ? 'saved' : 'none';
}
