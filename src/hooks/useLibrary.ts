import { useCallback, useEffect, useState } from 'react';
import type { Album, LibrarySnapshot, Track } from '../types';
import { preferredTracks } from '../config/trackOrder';
import { hasCatalog, listSavedTracks, loadCatalog, loadLibrary, migrateSavedTracks, saveCatalog, saveLibrary } from '../utils/cache';

const legacyOffline: Album = { id: 'legacy-offline', name: '保存したライブラリ', legacy: true };
const isTrack = (value: unknown): value is Track => Boolean(value && typeof value === 'object' && 'id' in value && typeof value.id === 'string' && 'title' in value && typeof value.title === 'string');
function preference(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function remember(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Storage is optional online. */ } }
function orderTracks(tracks: Track[], scope: string, albumId: string, isDefault: boolean) {
  const key = `drive-player.order.${scope}.${albumId}`;
  let order = preference(key);
  if (order === null && isDefault) {
    order = preference(`drive-player.order.${scope}`);
    if (order !== null) remember(key, order);
  }
  let ids: string[] = [];
  try { const value: unknown = JSON.parse(order ?? '[]'); if (Array.isArray(value)) ids = value.filter((id): id is string => typeof id === 'string'); } catch { /* Use the shared default order. */ }
  const rank = new Map(ids.map((id, index) => [id, index]));
  return preferredTracks(tracks).sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}
function libraryValue(value: unknown): LibrarySnapshot | null {
  if (!value || typeof value !== 'object' || !('albums' in value) || !Array.isArray(value.albums)) return null;
  const albums = value.albums.filter((album): album is Album => Boolean(album && typeof album.id === 'string' && typeof album.name === 'string'));
  const id = 'defaultAlbumId' in value && typeof value.defaultAlbumId === 'string' ? value.defaultAlbumId : null;
  return { albums, defaultAlbumId: albums.some(album => album.id === id) ? id : albums[0]?.id ?? null };
}

/** Browsing a folder has no effect on the independent playback queue. */
export function useLibrary(scope: string, online: boolean, onSessionExpired: () => void) {
  const [library, setLibrary] = useState<LibrarySnapshot>({ albums: [], defaultAlbumId: null });
  const [albumId, setAlbumId] = useState('');
  const [catalog, setCatalog] = useState<{ albumId: string; tracks: Track[] }>({ albumId: '', tracks: [] });
  const [saved, setSaved] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const selectionKey = `drive-player.album.${scope}`;

  useEffect(() => {
    // The first new page can still be controlled by the previous worker. Retry
    // album metadata once its new message handlers become available.
    const updated = () => setRevision(value => value + 1);
    navigator.serviceWorker?.addEventListener('controllerchange', updated);
    return () => navigator.serviceWorker?.removeEventListener('controllerchange', updated);
  }, []);

  useEffect(() => {
    const controller = new AbortController(); let gone = false;
    const install = (snapshot: LibrarySnapshot) => {
      if (gone) return;
      setLibrary(snapshot);
      setAlbumId(previous => {
        const desired = previous || preference(selectionKey);
        return snapshot.albums.some(album => album.id === desired) ? desired! : snapshot.defaultAlbumId ?? '';
      });
    };
    void (async () => {
      const [cached, oldCatalog, savedTracks] = await Promise.all([loadLibrary(scope), loadCatalog(scope), listSavedTracks(scope)]);
      if (gone) return;
      setSaved(savedTracks);
      if (cached.albums.length) install(cached);
      else if (oldCatalog.length || savedTracks.length) install({ albums: [legacyOffline], defaultAlbumId: legacyOffline.id });
      try {
        if (!online) throw new Error('offline');
        const response = await fetch('/api/albums', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (gone) return;
        if (response.status === 401) { onSessionExpired(); return; }
        if (!response.ok) throw new Error('albums');
        const snapshot = libraryValue(await response.json());
        if (!snapshot) throw new Error('albums');
        install(snapshot);
        void saveLibrary(snapshot, scope).catch(() => { /* Online use remains possible. */ });
        if (!snapshot.albums.length) { setLoading(false); setError('フォルダはまだありません。'); }
      } catch {
        if (!gone && !cached.albums.length && !oldCatalog.length && !savedTracks.length) {
          setError('フォルダを読み込めません。接続を確認して再試行してください。'); setLoading(false);
        }
      }
    })();
    return () => { gone = true; controller.abort(); };
  }, [scope, selectionKey, online, revision, onSessionExpired]);

  useEffect(() => {
    if (!albumId) return;
    const controller = new AbortController(); let gone = false;
    const isDefault = albumId === library.defaultAlbumId;
    const sort = (tracks: Track[]) => orderTracks(tracks, scope, albumId, isDefault);
    void (async () => {
      setLoading(true); setError('');
      const [cached, savedTracks, old, catalogExists] = await Promise.all([
        loadCatalog(scope, albumId), listSavedTracks(scope),
        albumId === legacyOffline.id || isDefault ? loadCatalog(scope) : Promise.resolve([] as Track[]),
        hasCatalog(scope, albumId),
      ]);
      if (gone) return;
      // A missing catalog may be recovered from known saved metadata. An empty
      // snapshot is authoritative; unassigned legacy songs belong only to default.
      const savedFallback = savedTracks.filter(track => track.albumId === albumId || (!track.albumId && isDefault))
        .map(track => track.albumId ? track : { ...track, albumId });
      const fallback = albumId === legacyOffline.id ? old.length ? old : savedTracks
        : cached.length || catalogExists ? cached : savedFallback;
      setSaved(savedTracks);
      setCatalog({ albumId, tracks: sort(fallback) });
      if (fallback.length) setLoading(false);
      try {
        if (!online || albumId === legacyOffline.id) throw new Error('offline');
        const response = await fetch(`/api/list?albumId=${encodeURIComponent(albumId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (gone) return;
        if (response.status === 401) { onSessionExpired(); return; }
        if (!response.ok) throw new Error('catalog');
        const value: unknown = await response.json();
        if (!value || typeof value !== 'object' || !('tracks' in value) || !Array.isArray(value.tracks)) throw new Error('catalog');
        const tracks = value.tracks.filter(isTrack).map(track => ({ ...track, albumId }));
        if (gone) return;
        setCatalog({ albumId, tracks: sort(tracks) });
        void saveCatalog(tracks, scope, albumId).catch(() => { /* Optional persistence. */ });
        void migrateSavedTracks(tracks, scope).then(() => listSavedTracks(scope)).then(value => { if (!gone) setSaved(value); }).catch(() => { /* Existing saved audio stays playable. */ });
      } catch {
        if (!gone) setError(fallback.length ? online ? '保存された曲一覧を表示しています。オンラインで更新できます。' : '' : online ? '曲一覧を読み込めません。接続を確認して再試行してください。' : 'このフォルダの曲はまだ端末に保存されていません。');
      } finally { if (!gone) setLoading(false); }
    })();
    return () => { gone = true; controller.abort(); };
  }, [scope, albumId, library.defaultAlbumId, online, revision, onSessionExpired]);

  const selectAlbum = useCallback((id: string) => {
    if (!library.albums.some(album => album.id === id)) return;
    setAlbumId(id); remember(selectionKey, id);
  }, [library.albums, selectionKey]);
  const setTracks = useCallback((tracks: Track[]) => {
    setCatalog({ albumId, tracks });
    remember(`drive-player.order.${scope}.${albumId}`, JSON.stringify(tracks.map(track => track.id)));
  }, [scope, albumId]);
  const refreshSaved = useCallback(async () => { setSaved(await listSavedTracks(scope)); }, [scope]);
  return { albums: library.albums, albumId, album: library.albums.find(album => album.id === albumId),
    tracks: catalog.albumId === albumId ? catalog.tracks : [], saved, loading, error,
    selectAlbum, setTracks, refreshSaved, refresh: () => setRevision(value => value + 1) };
}
