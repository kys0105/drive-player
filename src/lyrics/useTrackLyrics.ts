import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LyricsAsset } from '../types.ts';
import { loadDriveLyrics, LyricsAmbiguousError } from './drive.ts';
import { lyricsErrorMessage as message } from './errors.ts';
import { readLyricsFile } from './parse.ts';
import {
  getStoredDriveLyrics, getStoredLyrics, lyricsIdentityKey, removeStoredDriveLyrics, removeStoredLyrics, saveStoredLyrics, subscribeLyricsCleared,
  type LyricsIdentity, type StoredDriveLyrics, type StoredLyrics,
} from './storage.ts';

export type LyricsSource = 'drive' | 'local';
export type TrackLyricsOptions = { asset?: LyricsAsset; issue?: 'ambiguous'; enabled?: boolean; offline?: boolean; onSessionExpired?: () => void };
type State = {
  key: string; local: StoredLyrics | null; drive: StoredDriveLyrics | null;
  localLoading: boolean; driveLoading: boolean; busy: boolean; localError: string | null; driveError: string | null;
};
const initialState = (key: string): State => ({ key, local: null, drive: null, localLoading: false, driveLoading: false, busy: false, localError: null, driveError: null });
function aborted() { return new DOMException('Aborted', 'AbortError'); }

export function useTrackLyrics(identity: LyricsIdentity | null, options: TrackLyricsOptions = {}) {
  const scope = identity?.scope ?? '', trackId = identity?.trackId ?? '', version = identity?.version ?? '';
  const enabled = options.enabled ?? true;
  const offline = options.offline ?? false;
  const issue = options.issue;
  const target = useMemo(() => scope && trackId ? { scope, trackId, version } : null, [scope, trackId, version]);
  const key = target ? lyricsIdentityKey(target) : '';
  const assetId = options.asset?.id, assetVersion = options.asset?.ver, assetFormat = options.asset?.format;
  const asset = useMemo(() => assetId !== undefined && assetVersion !== undefined && assetFormat !== undefined
    ? { id: assetId, ver: assetVersion, format: assetFormat } : undefined, [assetId, assetVersion, assetFormat]);
  const active = useRef<LyricsIdentity | null>(null);
  const localOperation = useRef<object>({}), driveOperation = useRef<object>({});
  const driveRequest = useRef<AbortController | null>(null);
  const expiredHandler = useRef(options.onSessionExpired);
  expiredHandler.current = options.onSessionExpired;
  const [state, setState] = useState<State>(() => initialState(''));
  const [selection, setSelection] = useState<{ key: string; source: LyricsSource }>({ key: '', source: 'drive' });
  const sourceChoice = selection.key === key ? selection.source : 'drive';

  useEffect(() => {
    const generation = {};
    localOperation.current = generation;
    active.current = target;
    setState({ ...initialState(key), localLoading: Boolean(target) });
    const unsubscribe = subscribeLyricsCleared(clearedScope => {
      if (clearedScope === undefined || target?.scope === clearedScope) {
        localOperation.current = {}; driveOperation.current = {};
        driveRequest.current?.abort(); active.current = null;
        setState(initialState(key));
        setSelection({ key, source: 'drive' });
      }
    });
    if (target) void getStoredLyrics(target).then(local => {
      if (generation === localOperation.current && active.current) setState(previous => ({ ...previous, local, localLoading: false }));
    }).catch((error: unknown) => {
      if (generation === localOperation.current && active.current) setState(previous => ({ ...previous, localLoading: false, localError: message(error) }));
    });
    return () => {
      unsubscribe(); localOperation.current = {}; driveOperation.current = {};
      driveRequest.current?.abort(); active.current = null;
    };
  }, [key, target]);

  const refresh = useCallback(async () => {
    const current = active.current;
    if (!current || lyricsIdentityKey(current) !== key) throw aborted();
    driveRequest.current?.abort();
    const controller = new AbortController(), generation = {};
    driveRequest.current = controller; driveOperation.current = generation;
    const isCurrent = () => !controller.signal.aborted && generation === driveOperation.current &&
      active.current !== null && lyricsIdentityKey(active.current) === key;
    setState(previous => ({ ...previous, driveLoading: true, driveError: null }));
    let cached: StoredDriveLyrics | null = null;
    try {
      if (issue === 'ambiguous') {
        await removeStoredDriveLyrics(current).catch(() => {});
        if (!isCurrent()) throw aborted();
        throw new LyricsAmbiguousError();
      }
      try { cached = await getStoredDriveLyrics(current, asset); } catch { /* Online viewing still works if IndexedDB is unavailable. */ }
      if (!isCurrent()) throw aborted();
      setState(previous => ({ ...previous, drive: cached }));
      const result = await loadDriveLyrics(current, { offline, asset, signal: controller.signal, onSessionExpired: () => expiredHandler.current?.() });
      if (!isCurrent()) throw aborted();
      setState(previous => ({ ...previous, drive: result.record, driveLoading: false, driveError: result.cacheError }));
    } catch (error: unknown) {
      if (isCurrent()) setState(previous => ({ ...previous, drive: error instanceof LyricsAmbiguousError ? null : cached, driveLoading: false,
        driveError: error instanceof DOMException && error.name === 'AbortError' ? '歌詞の取得が中断されました。再試行してください。' : message(error) }));
      throw error;
    }
  }, [asset, issue, key, offline]);

  useEffect(() => {
    if (enabled && target) void refresh().catch(() => {});
    else { driveRequest.current?.abort(); setState(previous => ({ ...previous, driveLoading: false })); }
    return () => { driveRequest.current?.abort(); };
  }, [enabled, refresh, target]);
  useEffect(() => {
    const online = () => { if (enabled && target) void refresh().catch(() => {}); };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [enabled, refresh, target]);

  const run = useCallback(async (action: (current: LyricsIdentity, isCurrent: () => boolean) => Promise<StoredLyrics | null>) => {
    const current = active.current;
    if (!current || lyricsIdentityKey(current) !== key) throw new Error('歌詞を編集できません。曲を選び直してください。');
    const generation = {};
    localOperation.current = generation;
    const isCurrent = () => generation === localOperation.current && active.current !== null && lyricsIdentityKey(active.current) === key;
    setState(previous => ({ ...previous, localLoading: false, busy: true, localError: null }));
    try {
      const local = await action(current, isCurrent);
      if (!isCurrent()) throw new Error('ログイン状態や曲が変更されたため、歌詞の編集を中止しました。');
      setState(previous => ({ ...previous, local, localLoading: false, busy: false, localError: null }));
      setSelection({ key, source: local ? 'local' : 'drive' });
    } catch (error: unknown) {
      if (isCurrent()) setState(previous => ({ ...previous, localLoading: false, busy: false, localError: message(error) }));
      throw error;
    }
  }, [key]);
  const saveText = useCallback((text: string) => run(current => saveStoredLyrics(current, text)), [run]);
  const importFile = useCallback((file: File) => run(async (current, isCurrent) => {
    const text = await readLyricsFile(file);
    if (!isCurrent()) throw new Error('曲やログイン状態が変わったため、ファイルの読み込みを中止しました。');
    return saveStoredLyrics(current, text);
  }), [run]);
  const remove = useCallback(() => run(async current => { await removeStoredLyrics(current); return null; }), [run]);
  const setSourceChoice = useCallback((source: LyricsSource) => { setSelection({ key, source }); }, [key]);
  const displayed = state.key === key ? state : null;
  const record = sourceChoice === 'local' ? displayed?.local : issue === 'ambiguous' ? null : displayed?.drive;
  return {
    lyrics: record?.lyrics ?? null, sourceText: record?.text ?? '', localSourceText: displayed?.local?.text ?? '',
    loading: sourceChoice === 'local' ? displayed?.localLoading ?? Boolean(target) : issue === 'ambiguous' ? false : displayed?.driveLoading ?? Boolean(target && enabled),
    localLoading: displayed?.localLoading ?? Boolean(target), busy: displayed?.busy ?? false,
    error: displayed?.localError ?? (sourceChoice === 'drive' ? issue === 'ambiguous' ? new LyricsAmbiguousError().message : displayed?.driveError ?? null : null),
    sourceChoice, setSourceChoice, localAvailable: Boolean(displayed?.local), source: record ? sourceChoice : null,
    saveText, importFile, remove, refresh,
  };
}
