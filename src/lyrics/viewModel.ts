import type { LyricLine } from './parse.ts';

export type LyricsMode = 'follow' | 'full';
const MODE_KEY = 'drive-player.lyrics-mode.v1';

export function readLyricsMode(): LyricsMode | null {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return value === 'follow' || value === 'full' ? value : null;
  } catch { return null; }
}
export function storeLyricsMode(mode: LyricsMode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* The current view still changes if browser storage is unavailable. */ }
}
export function resolveLyricsMode(synced: boolean, preferred: LyricsMode | null): LyricsMode {
  return synced && preferred !== 'full' ? 'follow' : 'full';
}
export function activeLyricIndex(lines: LyricLine[], currentTime: number): number {
  let low = 0, high = lines.length - 1, active = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const time = lines[middle].time;
    if (time !== null && time <= currentTime) { active = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return active;
}
