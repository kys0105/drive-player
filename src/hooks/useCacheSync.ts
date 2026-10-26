import { useEffect, useState } from 'react';
import type { Track } from '../types';
import { buildStreamUrl, hasCached, cleanupCache } from '../utils/cache';

export function useCacheSync(tracks: Track[], cacheScope: string, onSessionExpired: () => void) {
  const [loadingById, setLoadingById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tracks.length || !('caches' in window)) return;

    const controller = new AbortController();

    (async () => {
      const validAbsUrls: string[] = [];
      const toFetch: { id: string; url: string }[] = [];

      for (const t of tracks) {
        if (controller.signal.aborted) return;
        const url = buildStreamUrl(t);
        const absUrl = new URL(url, location.origin).href;
        validAbsUrls.push(absUrl);

        if (!(await hasCached(url, cacheScope))) toFetch.push({ id: t.id, url });
      }

      if (controller.signal.aborted) return;
      if (toFetch.length) {
        setLoadingById((prev) => {
          const next = { ...prev };
          for (const f of toFetch) next[f.id] = true;
          return next;
        });
      }

      for (const f of toFetch) {
        if (controller.signal.aborted) return;
        try {
          const response = await fetch(f.url, {
            cache: 'no-store',
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          if (response.status === 401) {
            onSessionExpired();
            return;
          }
          if (!response.ok) throw new Error(`Prefetch returned ${response.status}`);
          // Consume the body even if a service worker has not taken control yet.
          await response.arrayBuffer();
        } catch (e) {
          if (!controller.signal.aborted) console.warn('prefetch failed:', f.id, e);
        } finally {
          if (!controller.signal.aborted) setLoadingById((prev) => ({ ...prev, [f.id]: false }));
        }
      }

      if (!controller.signal.aborted) await cleanupCache(validAbsUrls, cacheScope);
    })().catch((error) => {
      if (!controller.signal.aborted) console.warn('Audio cache sync failed:', error);
    });

    return () => controller.abort();
  }, [tracks, cacheScope, onSessionExpired]);

  return { loadingById };
}
