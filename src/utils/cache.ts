import type { Track } from '../types';

const PRIVATE_CACHE_PREFIX = 'audio-private-v2:';
const LEGACY_CACHE_NAME = 'audio-v1';

export function buildStreamUrl(t: Track): string {
  const v = encodeURIComponent(t.ver ?? '');
  return `/.netlify/functions/stream/${encodeURIComponent(t.id)}?v=${v}`;
}

function cacheName(cacheScope: string): string {
  return `${PRIVATE_CACHE_PREFIX}${encodeURIComponent(cacheScope)}`;
}

export async function hasCached(url: string, cacheScope: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  const cache = await caches.open(cacheName(cacheScope));
  const res = await cache.match(url);
  return res?.status === 200;
}

export async function cleanupCache(validAbsUrls: string[], cacheScope: string) {
  if (!('caches' in window)) return;
  const cache = await caches.open(cacheName(cacheScope));
  const keys = await cache.keys();
  const valid = new Set(validAbsUrls);
  await Promise.all(keys.map((req) => (valid.has(req.url) ? undefined : cache.delete(req))));
}

/** Ask the worker to finish outstanding writes before deleting private audio. */
export async function clearPrivateAudioCache(cacheScope?: string): Promise<void> {
  if ('serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration();
    const worker = navigator.serviceWorker.controller ?? registration?.active;
    if (worker) {
      await new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        const finish = () => {
          clearTimeout(timeout);
          channel.port1.close();
          resolve();
        };
        const timeout = window.setTimeout(finish, 2000);
        channel.port1.onmessage = finish;
        worker.postMessage({ type: 'CLEAR_PRIVATE_AUDIO', cacheScope }, [channel.port2]);
      });
    }
  }
  // Also clean up installations still using the previous worker.
  if ('caches' in window) {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key === LEGACY_CACHE_NAME || key.startsWith(PRIVATE_CACHE_PREFIX))
        .map((key) => caches.delete(key))
    );
  }
}
