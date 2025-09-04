// src/components/PlayerScreen.tsx
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Container } from '@mui/material';
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';

import type { Track } from '../types';
import { PlayerControls } from './PlayerControls';
import { TrackList } from './TrackList';
import { buildStreamUrl, useAudioCache } from '../hooks/useAudioCache';

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

  // dnd sensors
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor)
  );

  // 起動時：楽曲リスト取得
  useEffect(() => {
    (async () => {
      const r = await fetch('/.netlify/functions/list');
      if (!r.ok) {
        console.error('list failed', r.status, await r.text());
        return;
      }
      const d = await r.json();
      setTracks(d.tracks ?? []);
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

    setTracks((prev) => arrayMove(prev, oldIdx, newIdx));
    // 再生中インデックスも調整
    setIndex((idx) => {
      if (idx === oldIdx) return newIdx;
      if (oldIdx < idx && idx <= newIdx) return idx - 1;
      if (newIdx <= idx && idx < oldIdx) return idx + 1;
      return idx;
    });
  };

  const loadingById = useAudioCache(tracks);

  const t = tracks[index];

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
        playing={playing}
        canPlayThis={canPlayThis}
        index={index}
        tracksLength={tracks.length}
        current={current}
        duration={duration}
        prev={prev}
        next={next}
        play={play}
        pause={pause}
        onSeek={onSeek}
        fmt={fmt}
        audioRef={audioRef}
        src={src}
        onLoaded={onLoaded}
        onTime={onTime}
        wantAutoPlayRef={wantAutoPlayRef}
        interactedRef={interactedRef}
      />
      <TrackList
        tracks={tracks}
        index={index}
        setIndex={setIndex}
        sensors={sensors}
        handleDragEnd={handleDragEnd}
        loadingById={loadingById}
      />
    </Container>
  );
}
