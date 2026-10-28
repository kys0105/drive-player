import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readLyricsFile } from './parse.ts';
import {
  getStoredLyrics, lyricsIdentityKey, removeStoredLyrics, saveStoredLyrics, subscribeLyricsCleared,
  type LyricsIdentity, type StoredLyrics,
} from './storage.ts';

type State = { key: string; record: StoredLyrics | null; loading: boolean; busy: boolean; error: string | null };

function message(error: unknown) {
  return error instanceof Error ? error.message : '歌詞を処理できませんでした。もう一度お試しください。';
}

export function useTrackLyrics(identity: LyricsIdentity | null) {
  const scope = identity?.scope ?? '';
  const trackId = identity?.trackId ?? '';
  const version = identity?.version ?? '';
  const target = useMemo(() => scope && trackId ? { scope, trackId, version } : null, [scope, trackId, version]);
  const key = target ? lyricsIdentityKey(target) : '';
  const active = useRef<LyricsIdentity | null>(null);
  const operation = useRef<object>({});
  const [state, setState] = useState<State>({ key: '', record: null, loading: false, busy: false, error: null });

  useEffect(() => {
    const generation = {};
    operation.current = generation;
    active.current = target;
    setState({ key, record: null, loading: Boolean(target), busy: false, error: null });
    const unsubscribe = subscribeLyricsCleared((clearedScope) => {
      if (clearedScope === undefined || target?.scope === clearedScope) {
        operation.current = {};
        active.current = null;
        setState({ key, record: null, loading: false, busy: false, error: null });
      }
    });
    if (target) {
      void getStoredLyrics(target).then((record) => {
        if (generation === operation.current && active.current) {
          setState({ key, record, loading: false, busy: false, error: null });
        }
      }).catch((error: unknown) => {
        if (generation === operation.current && active.current) {
          setState({ key, record: null, loading: false, busy: false, error: message(error) });
        }
      });
    }
    return () => {
      unsubscribe();
      operation.current = {};
      active.current = null;
    };
  }, [key, target]);

  const run = useCallback(async (action: (current: LyricsIdentity, isCurrent: () => boolean) => Promise<StoredLyrics | null>) => {
    const current = active.current;
    if (!current || lyricsIdentityKey(current) !== key) {
      throw new Error('歌詞を編集できません。曲を選び直してください。');
    }
    const generation = {};
    operation.current = generation;
    const isCurrent = () => generation === operation.current && active.current !== null &&
      lyricsIdentityKey(active.current) === key;
    setState((previous) => ({ ...previous, key, loading: false, busy: true, error: null }));
    try {
      const record = await action(current, isCurrent);
      if (!isCurrent()) throw new Error('ログイン状態や曲が変更されたため、歌詞の編集を中止しました。');
      setState({ key, record, loading: false, busy: false, error: null });
    } catch (error: unknown) {
      if (isCurrent()) {
        setState((previous) => ({ ...previous, loading: false, busy: false, error: message(error) }));
      }
      throw error;
    }
  }, [key]);

  const saveText = useCallback((text: string) => run((current) => saveStoredLyrics(current, text)), [run]);
  const importFile = useCallback((file: File) => run(async (current, isCurrent) => {
    const text = await readLyricsFile(file);
    if (!isCurrent()) throw new Error('曲やログイン状態が変わったため、ファイルの読み込みを中止しました。');
    return saveStoredLyrics(current, text);
  }), [run]);
  const remove = useCallback(() => run(async (current) => {
    await removeStoredLyrics(current);
    return null;
  }), [run]);

  const displayed = state.key === key ? state : null;
  return {
    lyrics: displayed?.record?.lyrics ?? null,
    sourceText: displayed?.record?.text ?? '',
    loading: displayed?.loading ?? Boolean(target),
    busy: displayed?.busy ?? false,
    error: displayed?.error ?? null,
    saveText,
    importFile,
    remove,
  };
}
