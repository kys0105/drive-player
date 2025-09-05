// src/components/PlayerScreen.tsx
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Container } from '@mui/material';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

import type { Track } from '../types';
import { buildStreamUrl } from '../utils/cache';
import { useCacheSync } from '../hooks/useCacheSync';
import { PlayerControls } from './PlayerControls';
import { Playlist } from './Playlist';

const YUMOSHIN_TITLES = [
  'ghost mi#',
  'noah',
  'ほしを継ぐもの',
  'flowers3',
  'milkomeda',
  'for Lib Isl',
  '螺旋とは',
  'Impulse',
];

export default function PlayerScreen() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantAutoPlayRef = useRef(false);

  // 即時反映用の「操作済み」フラグ
  const interactedRef = useRef(false);
  const markInteracted = useCallback(() => {
    if (!interactedRef.current) {
      interactedRef.current = true;
    }
  }, []);

  // 起動時：楽曲リスト取得
  useEffect(() => {
    (async () => {
      const r = await fetch('/.netlify/functions/list');
      if (!r.ok) {
        console.error('list failed', r.status, await r.text());
        return;
      }
      const d = await r.json();
      const fetched = d.tracks ?? [];
      const stored = localStorage.getItem('trackOrder');
      const order: string[] = stored ? JSON.parse(stored) : [];
      const sorted = [...fetched].sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
      setTracks(sorted);
      localStorage.setItem('trackOrder', JSON.stringify(sorted.map((t) => t.id)));
    })();
  }, []);

  // 再生URL（?v= を含めてキャッシュ自動更新）
  const src = useMemo(
    () => (tracks[index] ? buildStreamUrl(tracks[index]) : undefined),
    [tracks, index]
  );

  const canPlayThis = useMemo(() => {
    const t = tracks[index];
    if (!t) return false;
    const test = document.createElement('audio');
    return t.mimeType ? test.canPlayType(t.mimeType) !== '' : true;
  }, [tracks, index]);

  const onLoaded = () => setDuration(audioRef.current?.duration ?? 0);
  const onTime = () => setCurrent(audioRef.current?.currentTime ?? 0);
  const onSeek = (_: Event, v: number | number[]) => {
    const val = Array.isArray(v) ? v[0] : v;
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const play = useCallback(async () => {
    const el = audioRef.current;
    if (!el) return;

    if (!interactedRef.current) {
      // ユーザー操作前は再生しない（autoplay制限回避）
      return;
    }
    if (el.readyState === 0) {
      // まだメディアが準備できてなければ、canplay で再試行
      wantAutoPlayRef.current = true;
      return;
    }
    try {
      await el.play();
      setPlaying(true);
    } catch (e) {
      console.warn('play blocked', (e as Error).name);
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);
  const next = useCallback(
    () => setIndex((i) => Math.min(tracks.length - 1, i + 1)),
    [tracks.length]
  );

  // Media Session
  // Media Session
  useEffect(() => {
    if (!('mediaSession' in navigator) || !tracks[index]) return;

    const t = tracks[index];

    // コンストラクタがあるブラウザのみ設定（型は d.ts で定義済み）
    if (window.MediaMetadata) {
      const ctor = window.MediaMetadata;
      navigator.mediaSession.metadata = new ctor({
        title: t.title,
        artist: t.artist ?? '',
        artwork: t.artwork ? [{ src: t.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    } else {
      // 未対応ブラウザでは無理に代入しない
      navigator.mediaSession.metadata = null;
    }

    navigator.mediaSession.setActionHandler?.('play', play);
    navigator.mediaSession.setActionHandler?.('pause', pause);
    navigator.mediaSession.setActionHandler?.('previoustrack', prev);
    navigator.mediaSession.setActionHandler?.('nexttrack', next);
  }, [index, tracks, play, pause, prev, next]);

  // 曲切替時
  useEffect(() => {
    const el = audioRef.current;
    if (el && src) {
      el.load();
      // 直前にユーザー操作があったら、canplay で自動再生
      wantAutoPlayRef.current = interactedRef.current;
    }
    setDuration(0);
    setCurrent(0);
  }, [src]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // 並べ替え確定
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const oldIdx = tracks.findIndex((x) => x.id === active.id);
    const newIdx = tracks.findIndex((x) => x.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;

    setTracks((prev) => {
      const arr = arrayMove(prev, oldIdx, newIdx);
      localStorage.setItem('trackOrder', JSON.stringify(arr.map((t) => t.id)));
      return arr;
    });
    // 再生中インデックスも調整
    setIndex((idx) => {
      if (idx === oldIdx) return newIdx;
      if (oldIdx < idx && idx <= newIdx) return idx - 1;
      if (newIdx <= idx && idx < oldIdx) return idx + 1;
      return idx;
    });
  };

  const handleYumoshinOrder = useCallback(() => {
    setTracks((prev) => {
      const order = new Map(YUMOSHIN_TITLES.map((t, i) => [t, i]));
      const sorted = [...prev].sort((a, b) => {
        const ai = order.get(a.title);
        const bi = order.get(b.title);
        if (ai === undefined && bi === undefined) return 0;
        if (ai === undefined) return 1;
        if (bi === undefined) return -1;
        return ai - bi;
      });
      const currentId = prev[index]?.id;
      const newIdx = sorted.findIndex((t) => t.id === currentId);
      setIndex(newIdx >= 0 ? newIdx : 0);
      localStorage.setItem('trackOrder', JSON.stringify(sorted.map((t) => t.id)));
      return sorted;
    });
  }, [index]);

  /* -------------------- 起動時の自動キャッシュ同期 -------------------- */
  const { loadingById } = useCacheSync(tracks);
  /* ------------------------------------------------------------------ */

  const t = tracks[index];
  const CONTENT_MAX_W = 560;

  return (
    <Container
      maxWidth="sm"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minHeight: '100vh',
        py: 2,
      }}
      onClick={markInteracted}
      onTouchStart={markInteracted}
    >
      <PlayerControls
        track={t}
        index={index}
        tracksLength={tracks.length}
        playing={playing}
        duration={duration}
        current={current}
        canPlayThis={canPlayThis}
        src={src}
        prev={prev}
        next={next}
        play={play}
        pause={pause}
        onSeek={onSeek}
        onLoaded={onLoaded}
        onTime={onTime}
        audioRef={audioRef}
        wantAutoPlayRef={wantAutoPlayRef}
        interactedRef={interactedRef}
        fmt={fmt}
        maxWidth={CONTENT_MAX_W}
      />

      {/* プレイリスト：ドラッグ&ドロップで順序変更 */}
      <Playlist
        tracks={tracks}
        index={index}
        setIndex={setIndex}
        handleDragEnd={handleDragEnd}
        loadingById={loadingById}
        maxWidth={CONTENT_MAX_W}
        onYumoshinOrder={handleYumoshinOrder}
      />
    </Container>
  );
}
