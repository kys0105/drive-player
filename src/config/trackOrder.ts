import type { Track } from '../types';

/** Shared default order. Songs absent from the library are simply omitted. */
export const preferredTitles = [
  '紐',
  'anchor',
  'noah',
  'ほしを継ぐもの',
  '4 Lib Isl',
  'flowers3',
  'milkomeda',
  'ghost',
  '砂',
  '螺旋とは',
  'Impulse',
] as const;

export function preferredTracks(tracks: Track[]): Track[] {
  const rank = (track: Track) => {
    const index = preferredTitles.findIndex(title => track.title.toLocaleLowerCase().startsWith(title.toLocaleLowerCase()) || (title === '4 Lib Isl' && /^for lib isl/i.test(track.title)));
    return index < 0 ? preferredTitles.length : index;
  };
  // Preserve the incoming filename order for songs outside the shared list.
  return [...tracks].sort((a, b) => rank(a) - rank(b));
}
