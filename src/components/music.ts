import type { Track } from '../types';
import { buildArtworkUrl } from '../utils/cache';

export const preferredTitles = ['ghost', 'noah', 'ほしを継ぐもの', 'flowers3', 'milkomeda', '4 Lib Isl', '螺旋とは', 'Impulse'];
export const fallbackArtwork = '/icons/track-placeholder.svg';
export function artwork(track?: Track) {
  return track ? buildArtworkUrl(track) ?? fallbackArtwork : fallbackArtwork;
}
export function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}
export function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function preferredTracks(tracks: Track[]) {
  const rank = (track: Track) => {
    const index = preferredTitles.findIndex((title) => track.title.toLocaleLowerCase().startsWith(title.toLocaleLowerCase()) || (title === '4 Lib Isl' && /^for lib isl/i.test(track.title)));
    return index < 0 ? preferredTitles.length : index;
  };
  return [...tracks].sort((a, b) => rank(a) - rank(b));
}
