// src/components/PlayerControls.tsx
import {
  Card,
  CardContent,
  Stack,
  Avatar,
  Box,
  Typography,
  IconButton,
  Tooltip,
  Slider,
  CircularProgress,
} from '@mui/material';
import { PlayArrow, Pause, SkipNext, SkipPrevious } from '@mui/icons-material';
import type { Track } from '../types';
import type { MutableRefObject, RefObject } from 'react';

type Props = {
  track?: Track;
  index: number;
  tracksLength: number;
  playing: boolean;
  duration: number;
  current: number;
  canPlayThis: boolean;
  src?: string;
  prev: () => void;
  next: () => void;
  play: () => Promise<void> | void;
  pause: () => void;
  onSeek: (_: Event, v: number | number[]) => void;
  onLoaded: () => void;
  onTime: () => void;
  audioRef: RefObject<HTMLAudioElement | null>;
  wantAutoPlayRef: MutableRefObject<boolean>;
  interactedRef: MutableRefObject<boolean>;
  fmt: (s: number) => string;
  maxWidth: number;
};

export function PlayerControls({
  track: t,
  index,
  tracksLength,
  playing,
  duration,
  current,
  canPlayThis,
  src,
  prev,
  next,
  play,
  pause,
  onSeek,
  onLoaded,
  onTime,
  audioRef,
  wantAutoPlayRef,
  interactedRef,
  fmt,
  maxWidth,
}: Props) {
  return (
    <Card sx={{ mb: 2, width: '100%', maxWidth }}>
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

          <IconButton onClick={next} disabled={index >= tracksLength - 1} size="large">
            <SkipNext />
          </IconButton>

          <Typography variant="body2" sx={{ ml: 1, width: 56, textAlign: 'right' }}>
            {fmt(current)}
          </Typography>
          <Typography
            variant="body2"
            sx={{
              width: 56,
              textAlign: 'left',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
            }}
          >
            {src && duration === 0 ? <CircularProgress size={16} /> : fmt(duration)}
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
  );
}

export default PlayerControls;
