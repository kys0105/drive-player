import type { Track } from '../types';

export const CACHE_NAME = 'audio-v1';
const MANIFEST_KEY = 'audio-cache-manifest-v1'; // localStorage: { [id]: ver }
export type Manifest = Record<string, string>;

export function buildStreamUrl(t: Track): string {
  const v = encodeURIComponent(t.ver ?? '');
  return `/.netlify/functions/stream/${t.id}?v=${v}`;
}

export function loadManifest(): Manifest {
  try {
    return JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}');
  } catch {
    return {};
  }
}

export function saveManifest(m: Manifest) {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
}

export async function hasCached(url: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(url);
  return !!res;
}

export async function cleanupCache(validAbsUrls: string[]) {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const valid = new Set(validAbsUrls);
  await Promise.all(
    keys.map((req) => (valid.has(req.url) ? Promise.resolve() : cache.delete(req)))
  );
}
