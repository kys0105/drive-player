import { useEffect, useState } from 'react';
import type { Track } from '../types';
import { hasCached, buildStreamUrl } from '../utils/cache';

/** Read saved state only. Playback/list loading must never download every track. */
export function useCacheSync(tracks: Track[], cacheScope: string, _onSessionExpired?: () => void) {
  void _onSessionExpired; // Retained for the previous PlayerScreen call signature.
  const [savedById, setSavedById] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(tracks.map(async track => [track.id, await hasCached(buildStreamUrl(track), cacheScope)] as const)).then(entries => {
      if (!cancelled) setSavedById(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, [tracks, cacheScope]);
  return { savedById, loadingById: {} as Record<string, boolean> };
}
