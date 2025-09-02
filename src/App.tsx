import { useEffect, useMemo, useRef, useState } from 'react';
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
} from '@mui/material';
import { PlayArrow, Pause, SkipNext, SkipPrevious } from '@mui/icons-material';

type Track = { id: string; title: string; artist?: string; artwork?: string };
const driveUrl = (id: string) => `https://drive.google.com/uc?export=download&id=${id}`;

export default function App() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const src = useMemo(() => (tracks[index] ? driveUrl(tracks[index].id) : ''), [tracks, index]);

  useEffect(() => {
    fetch('/tracks.json')
      .then((r) => r.json())
      .then(setTracks);
  }, []);

  const onLoaded = () => setDuration(audioRef.current?.duration ?? 0);
  const onTime = () => setCurrent(audioRef.current?.currentTime ?? 0);
  const onSeek = (_: Event, v: number | number[]) => {
    const val = Array.isArray(v) ? v[0] : v;
    if (audioRef.current) audioRef.current.currentTime = val;
  };

  const play = async () => {
    if (!audioRef.current) return;
    await audioRef.current.play();
    setPlaying(true);
  };
  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };
  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const next = () => setIndex((i) => Math.min(tracks.length - 1, i + 1));

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
  }, [index, tracks]);

  useEffect(() => {
    // 曲切替で自動再生（任意）
    if (audioRef.current) {
      audioRef.current.load();
      play().catch(() => {});
    }
    setCurrent(0);
  }, [src]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60),
      sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const t = tracks[index];

  return (
    <Container maxWidth="sm" sx={{ py: 2 }}>
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

          <audio
            ref={audioRef}
            src={src}
            onLoadedMetadata={onLoaded}
            onTimeUpdate={onTime}
            onEnded={next}
            preload="metadata"
          />

          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 2 }}>
            <IconButton onClick={prev} disabled={index === 0}>
              <SkipPrevious />
            </IconButton>
            {playing ? (
              <IconButton onClick={pause}>
                <Pause />
              </IconButton>
            ) : (
              <IconButton onClick={play}>
                <PlayArrow />
              </IconButton>
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
