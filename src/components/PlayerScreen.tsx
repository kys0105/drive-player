// src/components/PlayerScreen.tsx
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

/* -------------------- キャッシュ同期ユーティリティ -------------------- */

const CACHE_NAME = 'audio-v1';
const MANIFEST_KEY = 'audio-cache-manifest-v1'; // localStorage: { [id]: ver }
type Manifest = Record<string, string>;

function buildStreamUrl(t: Track): string {
  const v = encodeURIComponent(t.ver ?? '');
  return `/.netlify/functions/stream/${t.id}?v=${v}`;
}

function loadManifest(): Manifest {
  try {
    return JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveManifest(m: Manifest) {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
}

async function hasCached(url: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(url);
  return !!res;
}

async function cleanupCache(validAbsUrls: string[]) {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const valid = new Set(validAbsUrls);
  await Promise.all(
    keys.map((req) => (valid.has(req.url) ? Promise.resolve() : cache.delete(req)))
  );
}

/* -------------------------------------------------------------------- */

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

  /* -------------------- 起動時の自動キャッシュ同期 -------------------- */

  // 行ごとの読み込みスピナー状態
  const [loadingById, setLoadingById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tracks.length || !('caches' in window)) return;

    let aborted = false;

    (async () => {
      const oldManifest = loadManifest();
      const newManifest: Manifest = {};

      // 今回の正規URL（絶対URL）一覧（掃除用）
      const validAbsUrls: string[] = [];

      // 差分収集
      const toFetch: { id: string; url: string; reason: 'missing' | 'updated' }[] = [];

      for (const t of tracks) {
        const url = buildStreamUrl(t);
        const absUrl = new URL(url, location.origin).href;
        validAbsUrls.push(absUrl);

        const newVer = t.ver ?? '';
        newManifest[t.id] = newVer;

        const oldVer = oldManifest[t.id];
        if (!oldVer) {
          // マニフェストに無い＝初回 or 新規
          if (!(await hasCached(url))) {
            toFetch.push({ id: t.id, url, reason: 'missing' });
          }
        } else if (oldVer !== newVer) {
          toFetch.push({ id: t.id, url, reason: 'updated' });
        }
      }

      // スピナーON
      if (toFetch.length) {
        setLoadingById((prev) => {
          const next = { ...prev };
          for (const f of toFetch) next[f.id] = true;
          return next;
        });
      }

      // 順次フェッチ（SW が 200 レスポンスを Cache Storage に保存）
      const cache = await caches.open(CACHE_NAME);
      for (const f of toFetch) {
        if (aborted) break;
        try {
          await fetch(f.url, { cache: 'reload' });
          // 旧verの掃除
          if (f.reason === 'updated') {
            const oldVer = oldManifest[f.id];
            if (oldVer) {
              const oldUrl = `/.netlify/functions/stream/${f.id}?v=${encodeURIComponent(oldVer)}`;
              await cache.delete(new Request(oldUrl));
            }
          }
        } catch (e) {
          console.warn('prefetch failed:', f.id, e);
        } finally {
          setLoadingById((prev) => ({ ...prev, [f.id]: false }));
        }
        // 帯域にやさしく
        await new Promise((r) => setTimeout(r, 150));
      }

      // 孤児キャッシュ掃除（別フォルダの古い曲など）
      await cleanupCache(validAbsUrls);

      // 新マニフェスト保存
      saveManifest(newManifest);
    })();

    return () => {
      aborted = true;
    };
  }, [tracks]);

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
      <Card sx={{ mb: 2, width: '100%', maxWidth: CONTENT_MAX_W }}>
        <CardContent>
          {/* 上段：アートワーク＋タイトル */}
          <Stack direction="row" spacing={2} alignItems="center">
            <Avatar variant="rounded" src={t?.artwork} sx={{ width: 80, height: 80 }}>
              {t?.title?.[0]}
            </Avatar>
            <Box>
              <Typography variant="h6" noWrap>
                {t?.title ?? '—'}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {t?.artist ?? ''}
              </Typography>
            </Box>
          </Stack>

          {/* 中段：操作ボタンと時刻表示 */}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <IconButton onClick={prev} disabled={index === 0} size="large">
              <SkipPrevious />
            </IconButton>

            {playing ? (
              <Tooltip title="一時停止">
                <span>
                  <IconButton onClick={pause} disabled={!canPlayThis} size="large" color="primary">
                    <Pause />
                  </IconButton>
                </span>
              </Tooltip>
            ) : (
              <Tooltip title="再生">
                <span>
                  <IconButton onClick={play} disabled={!canPlayThis} size="large" color="primary">
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

          {/* オーディオ */}
          {src && (
            <audio
              ref={audioRef}
              src={src}
              crossOrigin="anonymous"
              preload="metadata"
              onLoadedMetadata={onLoaded}
              onCanPlay={() => {
                if (wantAutoPlayRef.current && interactedRef.current) {
                  wantAutoPlayRef.current = false;
                  void play();
                }
              }}
              onTimeUpdate={onTime}
              onEnded={next}
              onError={(e) => {
                const el = e.currentTarget;
                console.error('AUDIO ERROR', el.error?.code, {
                  networkState: el.networkState,
                  readyState: el.readyState,
                  src: el.currentSrc,
                });
              }}
            />
          )}
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
              <List>
                {tracks.map((x, i) => (
                  <SortableTrackRow
                    key={x.id}
                    track={x}
                    selected={i === index}
                    onClick={() => setIndex(i)}
                    loading={!!loadingById[x.id]}
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
