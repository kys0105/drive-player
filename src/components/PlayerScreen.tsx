import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Container,
  Card,
  CardContent,
  Typography,
  IconButton,
  Slider,
  List,
  Stack,
  Avatar,
  Tooltip,
  Box,
} from '@mui/material';
import { PlayArrow, Pause, SkipNext, SkipPrevious } from '@mui/icons-material';

// dnd-kit
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { Track } from '../types';
import { SortableTrackRow } from './SortableTrackRow';

export default function PlayerScreen() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [userInteracted, setUserInteracted] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantAutoPlayRef = useRef(false);

  // dnd sensors
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor)
  );

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

  const src = useMemo(
    () => (tracks[index] ? `/.netlify/functions/stream/${tracks[index].id}` : undefined),
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
    if (!userInteracted) return;
    const el = audioRef.current;
    if (!el) return;

    if (el.readyState === 0) {
      wantAutoPlayRef.current = true;
      return;
    }
    try {
      await el.play();
      setPlaying(true);
    } catch (e) {
      console.error('play failed', e);
    }
  }, [userInteracted]);

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
  useEffect(() => {
    if (!('mediaSession' in navigator) || !tracks[index]) return;
    const t = tracks[index];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist ?? '',
      artwork: t.artwork ? [{ src: t.artwork, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
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
      wantAutoPlayRef.current = userInteracted;
    }
    setCurrent(0);
  }, [src, userInteracted]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // 並べ替え確定
  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const oldIndex = tracks.findIndex((t) => t.id === active.id);
    const newIndex = tracks.findIndex((t) => t.id === over.id);
    const newList = arrayMove(tracks, oldIndex, newIndex);
    setTracks(newList);

    // 再生中の曲インデックスを追従
    if (index === oldIndex) setIndex(newIndex);
    else if (oldIndex < index && newIndex >= index) setIndex((i) => i - 1);
    else if (oldIndex > index && newIndex <= index) setIndex((i) => i + 1);
  };

  const t = tracks[index];
  const CONTENT_MAX_W = 560;

  return (
    <Container
      maxWidth="sm"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        py: 2,
      }}
      onClick={() => setUserInteracted(true)}
      onTouchStart={() => setUserInteracted(true)}
    >
      <Card sx={{ mb: 2, width: '100%', maxWidth: CONTENT_MAX_W }}>
        <CardContent>
          {/* 上段：アートワーク＋タイトル */}
          <Stack direction="row" spacing={2} alignItems="center">
            <Avatar variant="rounded" src={t?.artwork} sx={{ width: 80, height: 80 }}>
              {t?.title?.[0]}
            </Avatar>
            <Box>
              <Typography variant="h6" noWrap>
                {t?.title ?? '…'}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {t?.artist ?? ''}
              </Typography>
            </Box>
          </Stack>

          {src && (
            <audio
              ref={audioRef}
              src={src}
              crossOrigin="anonymous"
              preload="metadata"
              onLoadedMetadata={onLoaded}
              onCanPlay={() => {
                if (wantAutoPlayRef.current) {
                  wantAutoPlayRef.current = false;
                  void play();
                }
              }}
              onTimeUpdate={onTime}
              onEnded={next}
            />
          )}

          {/* 中段：操作ボタンと時刻表示 */}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <IconButton onClick={prev} disabled={index === 0} size="large">
              <SkipPrevious />
            </IconButton>

            {playing ? (
              <IconButton onClick={pause} disabled={!src} size="large">
                <Pause />
              </IconButton>
            ) : (
              <Tooltip title="再生">
                <span>
                  <IconButton
                    onClick={() => {
                      setUserInteracted(true);
                      void play();
                    }}
                    disabled={!src || !canPlayThis}
                    size="large"
                  >
                    <PlayArrow />
                  </IconButton>
                </span>
              </Tooltip>
            )}

            <IconButton onClick={next} disabled={index >= tracks.length - 1} size="large">
              <SkipNext />
            </IconButton>

            <Typography variant="body2" sx={{ ml: 1, width: 56, textAlign: 'right' }}>
              {fmt(current)}
            </Typography>
            <Typography variant="body2" sx={{ width: 56, textAlign: 'left' }}>
              {fmt(duration)}
            </Typography>
          </Stack>

          {/* 下段：タイムライン（横幅いっぱい） */}
          <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
            <Slider
              value={Math.min(current, duration)}
              min={0}
              max={duration || 0}
              step={1}
              onChange={onSeek}
              aria-label="seek"
              disabled={!src}
              sx={{
                width: '95%',
                height: 4,
                '& .MuiSlider-thumb': { width: 14, height: 14 },
              }}
            />
          </Box>
        </CardContent>
      </Card>

      {/* プレイリスト：ドラッグ&ドロップで順序変更 */}
      <Card sx={{ width: '100%', maxWidth: CONTENT_MAX_W }}>
        <CardContent>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={tracks.map((x) => x.id)} strategy={verticalListSortingStrategy}>
              <List dense>
                {tracks.map((x, i) => (
                  <SortableTrackRow
                    key={x.id}
                    track={x}
                    selected={i === index}
                    onClick={() => setIndex(i)}
                  />
                ))}
              </List>
            </SortableContext>
          </DndContext>
        </CardContent>
      </Card>
    </Container>
  );
}
