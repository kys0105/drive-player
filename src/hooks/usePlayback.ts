import { useCallback, useEffect, useRef, useState } from 'react';
import type { Track } from '../types';
import { buildStreamUrl } from '../utils/cache';
import { getSession } from '../utils/session';

export type RepeatMode = 'none' | 'all' | 'one';
type Options = {
  tracks: Track[];
  offline: boolean;
  savedIds: Set<string>;
  onSessionExpired: () => void;
  notify: (message: string) => void;
};

/** One audio element remains mounted across library, player, lyrics and sheets. */
export function usePlayback(options: Options) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [trackId, setTrackId] = useState('');
  const trackIdRef = useRef('');
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [repeat, setRepeat] = useState<RepeatMode>('none');
  const repeatRef = useRef(repeat);
  repeatRef.current = repeat;
  const intent = useRef(false);
  const attempt = useRef(0);
  const [error, setError] = useState('');

  const playElement = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio?.getAttribute('src')) return;
    const currentAttempt = ++attempt.current;
    intent.current = true;
    setError('');
    setLoading(audio.readyState < 3);
    try {
      await audio.play();
    } catch (failure) {
      if (currentAttempt !== attempt.current) return;
      setLoading(false);
      setPlaying(false);
      intent.current = false;
      if (failure instanceof DOMException && failure.name === 'AbortError') return;
      const message = failure instanceof DOMException && failure.name === 'NotAllowedError'
        ? '再生ボタンを押すと再生を再開できます。'
        : '音源を再生できません。接続や保存状態を確認し、もう一度お試しください。';
      setError(message);
      optionsRef.current.notify(message);
    }
  }, []);

  const chooseTrack = useCallback((id: string, autoPlay = true) => {
    const current = optionsRef.current;
    const track = current.tracks.find((item) => item.id === id);
    if (!track) return;
    if (current.offline && !current.savedIds.has(id)) {
      current.notify('この曲は端末に保存されていません。オンラインで再生してください。');
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const source = buildStreamUrl(track);
    if (trackIdRef.current !== id || audio.getAttribute('src') !== source || audio.error) {
      attempt.current += 1;
      intent.current = autoPlay;
      trackIdRef.current = id;
      setTrackId(id);
      setPosition(0);
      setDuration(0);
      setError('');
      setPlaying(false);
      setLoading(false);
      audio.src = source;
      audio.load();
    } else if (audio.ended) {
      audio.currentTime = 0;
    }
    if (autoPlay) void playElement();
  }, [playElement]);

  const pause = useCallback(() => {
    intent.current = false;
    attempt.current += 1;
    audioRef.current?.pause();
    setLoading(false);
  }, []);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused || (intent.current && audio.readyState < 3)) pause();
    else if (trackIdRef.current) chooseTrack(trackIdRef.current, true);
  }, [chooseTrack, pause]);

  const seek = useCallback((seconds: number, autoPlay = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    const value = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : seconds, seconds));
    try {
      audio.currentTime = value;
      setPosition(value);
      if (autoPlay) void playElement();
    } catch {
      optionsRef.current.notify('音源の読み込み後に、もう一度お試しください。');
    }
  }, [playElement]);

  const next = useCallback((autoPlay?: boolean) => {
    const current = optionsRef.current;
    const index = current.tracks.findIndex((item) => item.id === trackIdRef.current);
    const eligible = (item: Track) => !current.offline || current.savedIds.has(item.id);
    const candidate = current.tracks.slice(index + 1).find(eligible)
      ?? (repeatRef.current === 'all' ? current.tracks.find(eligible) : undefined);
    if (candidate) chooseTrack(candidate.id, autoPlay ?? intent.current);
    else {
      pause();
      current.notify(current.offline ? '保存した曲の最後まで再生しました。' : '最後まで再生しました。');
    }
  }, [chooseTrack, pause]);

  const previous = useCallback(() => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > 3) { seek(0); return; }
    const current = optionsRef.current;
    const index = current.tracks.findIndex((item) => item.id === trackIdRef.current);
    const candidate = current.tracks.slice(0, index).reverse()
      .find((item) => !current.offline || current.savedIds.has(item.id));
    if (candidate) chooseTrack(candidate.id, intent.current);
    else seek(0);
  }, [chooseTrack, seek]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const updateTime = () => setPosition(audio.currentTime);
    const updateDuration = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const onPlay = () => { setPlaying(true); setLoading(false); };
    const onPause = () => setPlaying(false);
    const onWaiting = () => { if (intent.current) setLoading(true); };
    const onReady = () => setLoading(false);
    const onEnded = () => {
      setPlaying(false);
      if (repeatRef.current === 'one') { seek(0, true); }
      else next(true);
    };
    const onError = (event: Event) => {
      // load() resets MediaError. A queued error from the previous resource can
      // arrive after a version/source switch; it must not fail the new song.
      if (!audio.error) return;
      console.warn('Audio playback failed', {
        code: audio.error?.code, message: audio.error?.message,
        readyState: audio.readyState, networkState: audio.networkState,
        currentTime: audio.currentTime, attempt: attempt.current,
        eventTime: event.timeStamp,
      });
      setLoading(false);
      setPlaying(false);
      intent.current = false;
      const message = '音源を取得できませんでした。保存状態や通信を確認して、再生を押してください。';
      setError(message);
      if (navigator.onLine) void getSession().then((session) => {
        if (!session) optionsRef.current.onSessionExpired();
      }).catch(() => { /* A network error does not revoke an offline permit. */ });
    };
    const handlers = { timeupdate: updateTime, durationchange: updateDuration, loadedmetadata: updateDuration,
      playing: onPlay, pause: onPause, waiting: onWaiting, canplay: onReady, ended: onEnded, error: onError };
    for (const [name, handler] of Object.entries(handlers)) audio.addEventListener(name, handler);
    return () => {
      attempt.current += 1;
      for (const [name, handler] of Object.entries(handlers)) audio.removeEventListener(name, handler);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
      }
    };
  }, [next, seek]);

  const activeTrack = options.tracks.find((item) => item.id === trackId);
  useEffect(() => {
    const selected = options.tracks.find(item => item.id === trackIdRef.current);
    if (!selected && trackIdRef.current) {
      pause();
      trackIdRef.current = '';
      setTrackId('');
      setPosition(0);
      setDuration(0);
      audioRef.current?.removeAttribute('src');
      audioRef.current?.load();
    }
    if (!selected && options.tracks.length) chooseTrack(options.tracks[0].id, false);
    else if (selected && audioRef.current?.getAttribute('src') !== buildStreamUrl(selected)) {
      chooseTrack(selected.id, intent.current);
    }
  }, [options.tracks, chooseTrack, pause]);

  useEffect(() => {
    if (!('mediaSession' in navigator) || !activeTrack) return;
    if (typeof MediaMetadata !== 'undefined') navigator.mediaSession.metadata = new MediaMetadata({
      title: activeTrack.title, artist: activeTrack.artist || 'SetagayaGenico',
    });
    const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void playElement(), pause, nexttrack: () => next(), previoustrack: previous,
      seekto: (event) => { if (event.seekTime !== undefined) seek(event.seekTime); },
      seekbackward: (event) => seek((audioRef.current?.currentTime ?? 0) - (event.seekOffset ?? 10)),
      seekforward: (event) => seek((audioRef.current?.currentTime ?? 0) + (event.seekOffset ?? 10)),
    };
    for (const [name, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(name as MediaSessionAction, handler!); } catch { /* Optional OS action. */ }
    }
    return () => {
      for (const name of Object.keys(actions)) {
        try { navigator.mediaSession.setActionHandler(name as MediaSessionAction, null); } catch { /* Optional OS action. */ }
      }
    };
  }, [activeTrack, playElement, pause, next, previous, seek]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    if (duration > 0) {
      try { navigator.mediaSession.setPositionState?.({ duration, position: Math.min(duration, position), playbackRate: 1 }); }
      catch { /* Some browsers expose an incomplete MediaSession implementation. */ }
    }
  }, [playing, duration, position]);

  return { audioRef, trackId, activeTrack, playing, loading, position, duration, repeat, setRepeat,
    error, chooseTrack, togglePlayback, pause, seek, next, previous };
}
