import type { drive_v3 } from 'googleapis';
import type { Album, LyricsAsset, Track } from '../../src/types.js';
import { getDrive, getFolderId } from './_drive.js';
import { privateResponse } from './_http.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,parents,trashed,size,md5Checksum,modifiedTime,thumbnailLink';
const natural = new Intl.Collator('ja', { numeric: true, sensitivity: 'variant' });
export type DriveFile = drive_v3.Schema$File;
export type AuthorizedAudio = { file: DriveFile; album: Album };
export type Association = { asset?: LyricsAsset; file?: DriveFile; issue?: 'ambiguous' };

export class LibraryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function libraryError(error: unknown): Response {
  return error instanceof LibraryError ? privateResponse(error.message, error.status) : privateResponse('Unable to load library', 502);
}
export function validId(value: string): boolean { return /^[A-Za-z0-9_-]{1,200}$/.test(value); }
export function version(file: DriveFile): string { return file.md5Checksum ?? file.modifiedTime ?? ''; }
function baseName(name: string): string { const dot = name.lastIndexOf('.'); return (dot < 0 ? name : name.slice(0, dot)).normalize('NFC'); }
function title(name: string): string { const underscore = name.indexOf('_'); return underscore < 0 ? name.slice(0, name.lastIndexOf('.') < 0 ? undefined : name.lastIndexOf('.')) : name.slice(0, underscore); }
function format(file: DriveFile): 'lrc' | 'txt' | undefined {
  const type = file.mimeType?.split(';')[0].toLowerCase();
  if (!type || !['text/plain', 'text/x-lrc', 'text/lrc', 'application/x-lrc', 'application/lrc', 'application/octet-stream'].includes(type)) return;
  const extension = /\.(lrc|txt)$/i.exec(file.name ?? '')?.[1].toLowerCase();
  return extension === 'lrc' || extension === 'txt' ? extension : undefined;
}
function isChild(file: DriveFile, parent: string): boolean {
  return Boolean(file.id && validId(file.id) && file.trashed === false && file.parents?.length === 1 && file.parents[0] === parent);
}

/** Request-scoped metadata only: moved/deleted folders are rechecked on every API request. */
export class DriveLibrary {
  readonly rootId: string;
  readonly drive: ReturnType<typeof getDrive>;
  private rootPromise?: Promise<DriveFile>;
  private childrenPromises = new Map<string, Promise<DriveFile[]>>();
  constructor() {
    const id = getFolderId();
    if (!id) throw new LibraryError(503, 'Service unavailable');
    this.rootId = id;
    this.drive = getDrive();
  }
  async metadata(id: string): Promise<DriveFile> {
    if (!validId(id)) throw new LibraryError(400, 'Invalid file ID');
    try {
      const response = await this.drive.files.get({ fileId: id, fields: FIELDS, alt: 'json' });
      const file = response.data;
      if (file.id !== id || file.trashed !== false) throw new LibraryError(404, 'Not found');
      return file;
    } catch (error) {
      if (error instanceof LibraryError) throw error;
      const code = Number((error as { code?: unknown; response?: { status?: number } })?.response?.status ?? (error as { code?: unknown })?.code);
      if (code === 403 || code === 404) throw new LibraryError(404, 'Not found');
      throw new LibraryError(502, 'Unable to load library');
    }
  }
  root(): Promise<DriveFile> {
    return this.rootPromise ??= this.metadata(this.rootId).then(file => {
      if (file.mimeType !== FOLDER_MIME) throw new LibraryError(404, 'Not found');
      return file;
    });
  }
  legacy(): Album { return { id: this.rootId, name: '試聴用', legacy: true }; }
  async album(id: string): Promise<Album> {
    await this.root();
    if (id === this.rootId) return this.legacy();
    const file = await this.metadata(id);
    if (file.mimeType !== FOLDER_MIME || !isChild(file, this.rootId)) throw new LibraryError(404, 'Not found');
    return { id, name: file.name ?? 'アルバム' };
  }
  children(parent: string): Promise<DriveFile[]> {
    const existing = this.childrenPromises.get(parent);
    if (existing) return existing;
    const pending = (async () => {
      const found = new Map<string, DriveFile>();
      const tokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const response = await this.drive.files.list({
          q: `'${parent}' in parents and trashed=false`,
          fields: `files(${FIELDS}),nextPageToken`, orderBy: 'name_natural', pageSize: 1000, pageToken,
        });
        for (const file of response.data.files ?? []) if (isChild(file, parent)) found.set(file.id!, file);
        pageToken = response.data.nextPageToken ?? undefined;
        if (pageToken && tokens.has(pageToken)) throw new LibraryError(502, 'Unable to load library');
        if (pageToken) tokens.add(pageToken);
      } while (pageToken);
      return [...found.values()].sort((a, b) => natural.compare(a.name ?? '', b.name ?? '') || (a.id ?? '').localeCompare(b.id ?? ''));
    })();
    this.childrenPromises.set(parent, pending);
    return pending;
  }
  async albums(): Promise<{ albums: Album[]; defaultAlbumId: string | null }> {
    await this.root();
    const children = await this.children(this.rootId);
    const albums: Album[] = children.filter(file => file.mimeType === FOLDER_MIME && file.id !== this.rootId)
      .map(file => ({ id: file.id!, name: file.name ?? 'アルバム' }));
    const legacy = children.some(file => file.mimeType === 'audio/mpeg');
    if (legacy) albums.unshift(this.legacy());
    let defaultAlbumId = legacy ? this.rootId : null;
    if (!defaultAlbumId && process.env.DEFAULT_ALBUM_ID) {
      const configured = process.env.DEFAULT_ALBUM_ID;
      if (!validId(configured)) throw new LibraryError(503, 'Default album unavailable');
      let album: Album;
      try { album = await this.album(configured); } catch { throw new LibraryError(503, 'Default album unavailable'); }
      if (!albums.some(item => item.id === album.id)) throw new LibraryError(503, 'Default album unavailable');
      defaultAlbumId = album.id;
    }
    if (!defaultAlbumId) {
      const thirds = albums.filter(album => album.name.normalize('NFC').trim().toLowerCase() === '3rd album');
      defaultAlbumId = (thirds.length === 1 ? thirds[0] : albums[0])?.id ?? null;
    }
    return { albums, defaultAlbumId };
  }
  async chooseAlbum(id?: string): Promise<Album> {
    if (id !== undefined) {
      if (!validId(id)) throw new LibraryError(400, 'Invalid album ID');
      return this.album(id);
    }
    const { defaultAlbumId } = await this.albums();
    // Keep the old /api/list contract useful even before the first song is added.
    return defaultAlbumId ? this.album(defaultAlbumId) : this.legacy();
  }
  async audio(id: string): Promise<AuthorizedAudio> {
    await this.root();
    const file = await this.metadata(id);
    if (file.mimeType !== 'audio/mpeg' || file.parents?.length !== 1) throw new LibraryError(404, 'Not found');
    const album = await this.album(file.parents[0]);
    if (!isChild(file, album.id)) throw new LibraryError(404, 'Not found');
    return { file, album };
  }
  association(audio: DriveFile, siblings: DriveFile[]): Association {
    if (!audio.name) return {};
    // Metadata and folder listings are separate Drive reads. If this audio was
    // renamed/moved meanwhile, a different same-name file must not supply lyrics.
    if (!siblings.some(file => file.id === audio.id && file.name === audio.name && file.mimeType === 'audio/mpeg')) return { issue: 'ambiguous' };
    const name = baseName(audio.name);
    const audioCount = siblings.filter(file => file.mimeType === 'audio/mpeg' && file.name && baseName(file.name) === name).length;
    if (audioCount !== 1) return { issue: 'ambiguous' };
    const candidates = siblings.filter(file => file.name && baseName(file.name) === name && format(file));
    const lrc = candidates.filter(file => format(file) === 'lrc');
    const preferred = lrc.length ? lrc : candidates.filter(file => format(file) === 'txt');
    if (preferred.length > 1) return { issue: 'ambiguous' };
    const file = preferred[0];
    return file ? { asset: { id: file.id!, ver: version(file), format: format(file)! }, file } : {};
  }
  async tracks(album: Album): Promise<Track[]> {
    const files = await this.children(album.id);
    return files.filter(file => file.mimeType === 'audio/mpeg').map(file => {
      const lyrics = this.association(file, files);
      return { id: file.id!, title: title(file.name ?? 'audio'), fileName: file.name ?? 'audio', albumId: album.id,
        mimeType: 'audio/mpeg', artwork: file.thumbnailLink ?? undefined, artist: '',
        size: file.size ? Number(file.size) : undefined, modifiedTime: file.modifiedTime ?? undefined, ver: version(file),
        ...(lyrics.asset ? { lyrics: lyrics.asset } : {}), ...(lyrics.issue ? { lyricsIssue: lyrics.issue } : {}) };
    });
  }
  async accessToken(): Promise<string> {
    const client = this.drive.context._options.auth;
    if (!client || typeof client !== 'object' || !('getAccessToken' in client)) throw new LibraryError(503, 'Service unavailable');
    const access = await client.getAccessToken();
    const token = typeof access === 'string' ? access : access?.token;
    if (!token) throw new LibraryError(503, 'Service unavailable');
    return token;
  }
}
