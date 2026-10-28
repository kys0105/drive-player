import type { Track } from '../types';

export const preferredTitles = ['ghost', 'noah', 'ほしを継ぐもの', 'flowers3', 'milkomeda', '4 Lib Isl', '螺旋とは', 'Impulse'];
const covers: Array<[RegExp, string]> = [
  [/^(4|for)\s*lib\s*isl/i, 'lib-island'], [/^anchor/i, 'anchor'], [/^flowers3/i, 'flowers3'],
  [/^ghost/i, 'ghost'], [/^milkomeda/i, 'milkomeda'], [/^noah/i, 'noah'],
  [/^ほしを継ぐもの/, 'hoshi'], [/^砂/, 'suna'], [/^紐/, 'himo'], [/^螺旋とは/, 'rasen'],
];
export function artwork(track?: Track) {
  const cover = covers.find(([pattern]) => pattern.test(track?.title ?? ''))?.[1] ?? 'noah';
  return `/art/${cover}.webp`;
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
