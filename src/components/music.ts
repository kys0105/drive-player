import type { Track } from '../types';
import { buildArtworkUrl } from '../utils/cache';

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
