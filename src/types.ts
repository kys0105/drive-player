export type Album = { id: string; name: string; legacy?: boolean };
export type LyricsAsset = { id: string; ver: string; format: 'lrc' | 'txt' };
export type ArtworkAsset = { id: string; ver: string; format: 'webp' | 'jpg' | 'png' };
export type LibrarySnapshot = { albums: Album[]; defaultAlbumId: string | null };

export type Track = {
  id: string;
  title: string;
  albumId?: string;
  fileName?: string;
  lyrics?: LyricsAsset;
  lyricsIssue?: 'ambiguous';
  cover?: ArtworkAsset;
  coverIssue?: 'ambiguous';
  artist?: string;
  artwork?: string;
  mimeType?: string;
  ver?: string; // md5Checksum 優先、なければ modifiedTime を入れる想定
  size?: number; // バイト数（将来、総容量表示やプリフェッチUIで使える）
  modifiedTime?: string; // ISO 8601（デバッグや表示用）
};
