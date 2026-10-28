import type { Album, LibrarySnapshot, Track } from '../types';
import { clearLocalSession } from './session';

const AUDIO_PREFIX = 'audio-private-v3:';
const ARTWORK_PREFIX = 'artwork-private-v1:';
const META_CACHE = 'drive-private-state-v3';
const activeDownloads = new Set<AbortController>();
let generation = 0;
type SavedTrack = Track & { savedUrl?: string };
export type DownloadProgress = { loaded: number; total?: number };

export function buildStreamUrl(track: Track): string {
  return `/api/stream/${encodeURIComponent(track.id)}?v=${encodeURIComponent(track.ver ?? '')}`;
}

export function buildArtworkUrl(track: Track): string | null {
  const cover = track.cover;
  if (track.coverIssue === 'ambiguous' || !cover || typeof cover.id !== 'string' || !cover.id ||
      typeof cover.ver !== 'string' || !cover.ver || !['webp', 'jpg', 'png'].includes(cover.format)) return null;
  return `/api/artwork/${encodeURIComponent(track.id)}?v=${encodeURIComponent(cover.ver)}`;
}
function cacheName(scope: string) { return `${AUDIO_PREFIX}${encodeURIComponent(scope)}`; }
function stateUrl(kind: string, scope: string, albumId?: string) {
  const album = albumId === undefined ? '' : `/${encodeURIComponent(albumId)}`;
  return new URL(`/__private__/${kind}${album}/${encodeURIComponent(scope)}`, location.origin).href;
}

function catalogTracks(value: unknown): Track[] {
  return Array.isArray(value)
    ? value.filter((track): track is Track => Boolean(track && typeof track.id === 'string' && typeof track.title === 'string'))
    : [];
}

async function workerRequest(data: Record<string, unknown>, timeoutMs = 30_000, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (!('serviceWorker' in navigator)) throw new Error('このブラウザでは端末への保存を利用できません。');
  const registration = navigator.serviceWorker.controller ? null : await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const timeout = setTimeout(() => finish(() => reject(new Error('端末保存の準備ができません。一度ページを再読み込みしてください。'))), 8_000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try {
      void navigator.serviceWorker.ready.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    } catch (error) { finish(() => reject(error)); }
  });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const worker = navigator.serviceWorker.controller ?? registration?.active;
  if (!worker) throw new Error('保存の準備中です。一度ページを再読み込みしてください。');
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      channel.port1.close();
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    const timeout = setTimeout(() => finish(() => reject(new Error('保存処理が応答しません。再度お試しください。'))), timeoutMs);
    channel.port1.onmessage = event => {
      const result = event.data;
      finish(() => { if (result?.error) reject(new Error(String(result.error))); else resolve(result ?? {}); });
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage(data, [channel.port2]); } catch (error) { finish(() => reject(error)); }
  });
}

export async function hasCached(url: string, scope: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  try {
    const response = await (await caches.open(cacheName(scope))).match(url);
    return response?.status === 200 && response.headers.get('X-Drive-Saved') === '1';
  } catch { return false; }
}

export async function listSavedTracks(scope: string): Promise<Track[]> {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open(META_CACHE);
    const value: unknown = await (await cache.match(stateUrl('saved', scope)))?.json();
    if (!Array.isArray(value)) return [];
    const tracks = value.filter((track): track is SavedTrack => Boolean(track && typeof track.id === 'string' && typeof track.title === 'string'));
    const present = await Promise.all(tracks.map(track => hasCached(track.savedUrl ?? buildStreamUrl(track), scope)));
    return tracks.filter((_, index) => present[index]);
  } catch { return []; }
}

export async function loadLibrary(scope: string): Promise<LibrarySnapshot> {
  const empty = { albums: [], defaultAlbumId: null };
  if (!('caches' in window)) return empty;
  try {
    const cache = await caches.open(META_CACHE);
    const value: unknown = await (await cache.match(stateUrl('library', scope)))?.json();
    if (!value || typeof value !== 'object' || !('albums' in value) || !Array.isArray(value.albums)) return empty;
    const albums = value.albums.filter((album): album is Album => Boolean(album && typeof album.id === 'string' && album.id && typeof album.name === 'string'));
    const defaultAlbumId = 'defaultAlbumId' in value && typeof value.defaultAlbumId === 'string' && albums.some(album => album.id === value.defaultAlbumId)
      ? value.defaultAlbumId : null;
    return { albums, defaultAlbumId };
  } catch { return empty; }
}

export async function saveLibrary(snapshot: LibrarySnapshot, scope: string): Promise<void> {
  await workerRequest({ type: 'SAVE_LIBRARY', cacheScope: scope, snapshot });
}

/** Exact saved snapshot presence, including an intentionally empty folder. */
export async function hasCatalog(scope: string, albumId?: string): Promise<boolean> {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(META_CACHE);
    const value: unknown = await (await cache.match(stateUrl('catalog', scope, albumId)))?.json();
    return Array.isArray(value);
  } catch { return false; }
}

export async function loadCatalog(scope: string, albumId?: string): Promise<Track[]> {
  if (!('caches' in window)) return [];
  try {
    const cache = await caches.open(META_CACHE);
    const value: unknown = await (await cache.match(stateUrl('catalog', scope, albumId)))?.json();
    // An explicitly saved empty folder must not resurrect the previous catalog.
    if (Array.isArray(value)) return catalogTracks(value)
      .filter(track => albumId === undefined || !track.albumId || track.albumId === albumId)
      .map(track => albumId !== undefined && !track.albumId ? { ...track, albumId } : track);
    if (albumId === undefined) return [];
    const previous: unknown = await (await cache.match(stateUrl('catalog', scope)))?.json();
    const library = await loadLibrary(scope);
    return catalogTracks(previous)
      .filter(track => track.albumId === albumId || (!track.albumId && library.defaultAlbumId === albumId))
      .map(track => track.albumId ? track : { ...track, albumId });
  } catch { return []; }
}

export async function saveCatalog(tracks: Track[], scope: string, albumId?: string): Promise<void> {
  await workerRequest({ type: 'SAVE_CATALOG', cacheScope: scope, tracks, albumId });
}

/** Enrich metadata only. The same ID/version audio body and URL are retained. */
export async function migrateSavedTracks(tracks: Track[], scope: string): Promise<void> {
  if (!tracks.length) return;
  await workerRequest({ type: 'MIGRATE_SAVED_TRACKS', cacheScope: scope, tracks });
}

export async function deleteSavedTrack(track: Track, scope: string): Promise<void> {
  await workerRequest({ type: 'DELETE_TRACK', cacheScope: scope, url: (track as SavedTrack).savedUrl ?? buildStreamUrl(track), trackId: track.id });
}

export async function downloadTrack(track: Track, scope: string, options: { signal?: AbortSignal; onProgress?: (progress: DownloadProgress) => void } = {}): Promise<void> {
  const expected = generation;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  activeDownloads.add(controller);
  let storing = false;
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const sync = await workerRequest({ type: 'SYNC_SESSION' }, 30_000, controller.signal);
    const session = sync.session as { cacheScope?: string } | null;
    if (session?.cacheScope !== scope || expected !== generation) throw new Error('オンラインでログイン状態を確認してから保存してください。');
    const response = await fetch(buildStreamUrl(track), {
      credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'X-Drive-Download': '1' },
    });
    if (response.status === 401) { await clearPrivateAudioCache(); throw new Error('ログインの有効期限が切れました。'); }
    if (response.status !== 200 || response.headers.has('Content-Range') || !response.body || !/^audio\//.test(response.headers.get('Content-Type') ?? '')) throw new Error('音源を保存できませんでした。再試行してください。');
    const announcedLength = Number(response.headers.get('Content-Length'));
    const total = Number.isFinite(announcedLength) && announcedLength > 0 ? announcedLength : track.size;
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];
    let loaded = 0;
    options.onProgress?.({ loaded, total });
    while (true) {
      const part = await reader.read();
      if (controller.signal.aborted || expected !== generation) { await reader.cancel(); throw new DOMException('Aborted', 'AbortError'); }
      if (part.done) break;
      chunks.push(part.value.slice().buffer);
      loaded += part.value.byteLength;
      options.onProgress?.({ loaded, total });
    }
    if (!loaded || (total !== undefined && loaded !== total)) throw new Error('音源の取得が途中で止まりました。もう一度保存してください。');
    storing = true;
    await workerRequest({ type: 'STORE_TRACK', cacheScope: scope, url: buildStreamUrl(track), track, blob: new Blob(chunks, { type: 'audio/mpeg' }) }, 120_000, controller.signal);
    if (controller.signal.aborted || expected !== generation) {
      await deleteSavedTrack(track, scope).catch(() => {});
      throw new DOMException('Aborted', 'AbortError');
    }
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
  } catch (error) {
    if (storing && (controller.signal.aborted || expected !== generation)) await deleteSavedTrack(track, scope).catch(() => {});
    throw error;
  } finally {
    activeDownloads.delete(controller);
    options.signal?.removeEventListener('abort', abort);
  }
}

/** Explicit image persistence is confirmed by the private worker, never inferred from viewing. */
export async function cacheArtwork(track: Track, scope: string, options: { signal?: AbortSignal } = {}): Promise<void> {
  const url = buildArtworkUrl(track);
  if (!url) return;
  const expected = generation;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  activeDownloads.add(controller);
  let serverRevoked = false;
  try {
    if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const sync = await workerRequest({ type: 'SYNC_SESSION' }, 30_000, controller.signal);
    if ((sync.session as { cacheScope?: string } | null)?.cacheScope !== scope || expected !== generation) throw new Error('ログイン状態が変わったため、画像を保存できませんでした。');
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'X-Drive-Artwork-Save': '1', 'X-Drive-Cache-Scope': scope } });
    try {
      if (controller.signal.aborted || expected !== generation) throw new DOMException('Aborted', 'AbortError');
      if (response.status === 401) { serverRevoked = true; await clearPrivateAudioCache(); throw new Error('ログインの有効期限が切れました。'); }
      if ([404, 409].includes(response.status)) throw new Error('曲の画像が変更されています。曲一覧を更新してから再試行してください。');
      if (response.status !== 200) throw new Error('曲の画像を保存できませんでした。通信状態を確認して再試行してください。');
      const outcome = response.headers.get('X-Drive-Artwork-Cache');
      if (outcome === 'quota') throw new Error('画像を保存する空き容量が不足しています。不要な保存曲を削除してください。');
      if (outcome === 'cancelled') throw new DOMException('Aborted', 'AbortError');
      if (outcome !== 'stored') throw new Error('画像を端末に保存できませんでした。ブラウザの保存領域を確認し、ページを再読み込みしてから再試行してください。');
    } finally { await response.body?.cancel().catch(() => {}); }
  } catch (error) {
    if (serverRevoked) throw new Error('ログインの有効期限が切れました。');
    if (controller.signal.aborted || expected !== generation || error instanceof DOMException && error.name === 'AbortError') throw new DOMException('Aborted', 'AbortError');
    if (error instanceof TypeError) throw new Error('曲の画像を取得できませんでした。通信状態を確認してください。');
    throw error;
  } finally {
    activeDownloads.delete(controller);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function cleanupCache(validAbsUrls: string[], scope: string): Promise<void> {
  const valid = new Set(validAbsUrls.map(url => new URL(url, location.origin).href));
  for (const track of await listSavedTracks(scope)) {
    if (!valid.has(new URL((track as SavedTrack).savedUrl ?? buildStreamUrl(track), location.origin).href)) await deleteSavedTrack(track, scope);
  }
}

/** Revoke pending downloads before acknowledging deletion; the worker serializes writes. */
export async function clearPrivateAudioCache(scope?: string): Promise<void> {
  generation++;
  for (const controller of activeDownloads) controller.abort();
  clearLocalSession();
  let acknowledged = false;
  try {
    if ('serviceWorker' in navigator && (navigator.serviceWorker.controller || (await navigator.serviceWorker.getRegistration())?.active)) {
      await workerRequest({ type: 'CLEAR_PRIVATE_AUDIO', cacheScope: scope });
      acknowledged = true;
    }
  } catch { /* Direct deletion below is also needed when an older worker is installed. */ }
  if ('caches' in window) {
    for (const key of await caches.keys()) {
      if (key === 'audio-v1' || key.startsWith('audio-private-v2:') || key.startsWith(AUDIO_PREFIX) || key.startsWith(ARTWORK_PREFIX) || (!acknowledged && key === META_CACHE)) await caches.delete(key);
    }
  }
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('drive-player.catalog.') || key.startsWith('drive-player.lyrics.') || key.startsWith('drive-player.order.')) localStorage.removeItem(key);
    }
  } catch { /* Optional local metadata. */ }
}
