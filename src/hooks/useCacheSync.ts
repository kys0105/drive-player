import { useEffect, useState } from 'react';
import type { Track } from '../types';
import {
  buildStreamUrl,
  loadManifest,
  saveManifest,
  hasCached,
  cleanupCache,
  CACHE_NAME,
  type Manifest,
} from '../utils/cache';

export function useCacheSync(tracks: Track[]) {
  const [loadingById, setLoadingById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tracks.length || !('caches' in window)) return;

    let aborted = false;

    (async () => {
      const oldManifest = loadManifest();
      const newManifest: Manifest = {};
      const validAbsUrls: string[] = [];
      const toFetch: { id: string; url: string; reason: 'missing' | 'updated' }[] = [];

      for (const t of tracks) {
        const url = buildStreamUrl(t);
        const absUrl = new URL(url, location.origin).href;
        validAbsUrls.push(absUrl);

        const newVer = t.ver ?? '';
        newManifest[t.id] = newVer;

        const oldVer = oldManifest[t.id];
        if (!oldVer) {
          if (!(await hasCached(url))) {
            toFetch.push({ id: t.id, url, reason: 'missing' });
          }
        } else if (oldVer !== newVer) {
          toFetch.push({ id: t.id, url, reason: 'updated' });
        }
      }

      if (toFetch.length) {
        setLoadingById((prev) => {
          const next = { ...prev };
          for (const f of toFetch) next[f.id] = true;
          return next;
        });
      }

      const cache = await caches.open(CACHE_NAME);
      for (const f of toFetch) {
        if (aborted) break;
        try {
          await fetch(f.url, { cache: 'reload' });
          if (f.reason === 'updated') {
            const oldVer = oldManifest[f.id];
            if (oldVer) {
              const oldUrl = `/.netlify/functions/stream/${f.id}?v=${encodeURIComponent(oldVer)}`;
              await cache.delete(new Request(oldUrl));
            }
          }
        } catch (e) {
          console.warn('prefetch failed:', f.id, e);
        } finally {
          setLoadingById((prev) => ({ ...prev, [f.id]: false }));
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      await cleanupCache(validAbsUrls);
      saveManifest(newManifest);
    })();

    return () => {
      aborted = true;
    };
  }, [tracks]);

  return { loadingById };
}
