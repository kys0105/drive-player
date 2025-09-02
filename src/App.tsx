import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  Container,
  Card,
  CardContent,
  Typography,
  IconButton,
  Slider,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Avatar,
  Tooltip,
} from '@mui/material';
import { PlayArrow, Pause, SkipNext, SkipPrevious } from '@mui/icons-material';

type Track = {
  id: string;
  title: string;
  artist?: string;
  artwork?: string;
  mimeType?: string; // list.ts が返す想定（任意）
};

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [userInteracted, setUserInteracted] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wantAutoPlayRef = useRef(false); // canplay 到達での自動再生予約

  // リスト取得
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

  // 空文字は返さない
  const src = useMemo(
    () => (tracks[index] ? `/.netlify/functions/stream/${tracks[index].id}` : undefined),
    [tracks, index]
  );

  // ブラウザ簡易対応判定（mimeType があれば優先）
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

  // 通常再生
  const play = useCallback(async () => {
    if (!userInteracted) return; // 自動再生ブロック対策
    const el = audioRef.current;
    if (!el) return;

    if (el.readyState === 0) {
      // まだ読み込み前なら canplay まで待つ
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

  // 曲切替時：load のみ。canplay で再生
  useEffect(() => {
    const el = audioRef.current;
    if (el && src) {
      el.load();
      wantAutoPlayRef.current = userInteracted; // 操作済みなら再生予約
    }
    setCurrent(0);
  }, [src, userInteracted]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const t = tracks[index];

  return (
    <Container
      maxWidth="sm"
      sx={{ py: 2 }}
      onClick={() => setUserInteracted(true)}
      onTouchStart={() => setUserInteracted(true)}
    >
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" spacing={2} alignItems="center">
            <Avatar variant="rounded" src={t?.artwork} sx={{ width: 72, height: 72 }}>
              {t?.title?.[0]}
            </Avatar>
            <div>
              <Typography variant="h6">{t?.title ?? '…'}</Typography>
              <Typography variant="body2" color="text.secondary">
                {t?.artist ?? ''}
              </Typography>
            </div>
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

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <IconButton onClick={prev} disabled={index === 0}>
              <SkipPrevious />
            </IconButton>

            {playing ? (
              <IconButton onClick={pause} disabled={!src}>
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
                  >
                    <PlayArrow />
                  </IconButton>
                </span>
              </Tooltip>
            )}

            <IconButton onClick={next} disabled={index >= tracks.length - 1}>
              <SkipNext />
            </IconButton>

            <Typography variant="body2" sx={{ ml: 1, width: 48, textAlign: 'right' }}>
              {fmt(current)}
            </Typography>
            <Slider
              value={Math.min(current, duration)}
              min={0}
              max={duration || 0}
              step={1}
              onChange={onSeek}
              aria-label="seek"
              sx={{ mx: 1, flex: 1 }}
              disabled={!src}
            />
            <Typography variant="body2" sx={{ width: 48 }}>
              {fmt(duration)}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            プレイリスト
          </Typography>
          <List dense>
            {tracks.map((x, i) => (
              <ListItem key={x.id} disablePadding>
                <ListItemButton selected={i === index} onClick={() => setIndex(i)}>
                  <ListItemText primary={x.title} secondary={x.artist} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        </CardContent>
      </Card>
    </Container>
  );
}
