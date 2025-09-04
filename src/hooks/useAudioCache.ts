// src/hooks/useAudioCache.ts
import { useEffect, useState } from 'react';
import type { Track } from '../types';

const CACHE_NAME = 'audio-v1';
const MANIFEST_KEY = 'audio-cache-manifest-v1';
type Manifest = Record<string, string>;

export function buildStreamUrl(t: Track): string {
  const v = encodeURIComponent(t.ver ?? '');
  return `/.netlify/functions/stream/${t.id}?v=${v}`;
}

function loadManifest(): Manifest {
  try {
    return JSON.parse(localStorage.getItem(MANIFEST_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveManifest(m: Manifest) {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(m));
}

async function hasCached(url: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  const cache = await caches.open(CACHE_NAME);
  const res = await cache.match(url);
  return !!res;
}

async function cleanupCache(validAbsUrls: string[]) {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const valid = new Set(validAbsUrls);
  await Promise.all(
    keys.map((req) => (valid.has(req.url) ? Promise.resolve() : cache.delete(req)))
  );
}

export function useAudioCache(tracks: Track[]) {
  const [loadingById, setLoadingById] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!tracks.length || !('caches' in window)) return;

    let aborted = false;

    (async () => {
      const oldManifest = loadManifest();
      const newManifest: Manifest = {};

      // 今回の正規URL（絶対URL）一覧（掃除用）
      const validAbsUrls: string[] = [];

      // 差分収集
      const toFetch: { id: string; url: string; reason: 'missing' | 'updated' }[] = [];

      for (const t of tracks) {
        const url = buildStreamUrl(t);
        const absUrl = new URL(url, location.origin).href;
        validAbsUrls.push(absUrl);

        const newVer = t.ver ?? '';
        newManifest[t.id] = newVer;

        const oldVer = oldManifest[t.id];
        if (!oldVer) {
          // マニフェストに無い＝初回 or 新規
          if (!(await hasCached(url))) {
            toFetch.push({ id: t.id, url, reason: 'missing' });
          }
        } else if (oldVer !== newVer) {
          toFetch.push({ id: t.id, url, reason: 'updated' });
        }
      }

      // スピナーON
      if (toFetch.length) {
        setLoadingById((prev) => {
          const next = { ...prev };
          for (const f of toFetch) next[f.id] = true;
          return next;
        });
      }

      // 順次フェッチ（SW が 200 レスポンスを Cache Storage に保存）
      const cache = await caches.open(CACHE_NAME);
      for (const f of toFetch) {
        if (aborted) break;
        try {
          await fetch(f.url, { cache: 'reload' });
          // 旧verの掃除
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
        // 帯域にやさしく
        await new Promise((r) => setTimeout(r, 150));
      }

      // 孤児キャッシュ掃除（別フォルダの古い曲など）
      await cleanupCache(validAbsUrls);

      // 新マニフェスト保存
      saveManifest(newManifest);
    })();

    return () => {
      aborted = true;
    };
  }, [tracks]);

  return loadingById;
}

