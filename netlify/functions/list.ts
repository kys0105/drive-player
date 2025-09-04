// netlify/functions/list.ts
import type { Handler } from '@netlify/functions';
import { getDrive } from './_drive';

function guessAudioMimeByName(name: string, driveMime?: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (driveMime === 'audio/mpeg') return driveMime;
  return 'audio/mpeg';
}

function formatTitle(name: string): string {
  const underscoreIndex = name.indexOf('_');
  if (underscoreIndex >= 0) return name.slice(0, underscoreIndex);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(0, dotIndex) : name;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const handler: Handler = async () => {
  try {
    const folderId = process.env.FOLDER_ID;
    if (!folderId) return { statusCode: 500, body: 'FOLDER_ID is not set' };

    const drive = getDrive();

    const q = [`'${folderId}' in parents`, 'trashed=false', "mimeType='audio/mpeg'"].join(' and ');

    const res = await drive.files.list({
      q,
      // ★ md5Checksum を追加
      fields: 'files(id,name,mimeType,thumbnailLink,modifiedTime,md5Checksum,size),nextPageToken',
      orderBy: 'name_natural',
      pageSize: 1000,
    });

    const files = res.data.files ?? [];
    const tracks = files.map((f) => {
      const name = f.name ?? 'audio';
      const driveMime = f.mimeType ?? '';
      const guessed = guessAudioMimeByName(name, driveMime);
      const title = formatTitle(name);

      // ★ ver は md5Checksum 優先、なければ modifiedTime
      const ver = f.md5Checksum ?? f.modifiedTime ?? '';

      return {
        id: f.id!,
        title,
        mimeType: guessed,
        artwork: f.thumbnailLink ?? undefined,
        artist: '',
        size: f.size ? Number(f.size) : undefined,
        modifiedTime: f.modifiedTime ?? undefined,
        ver, // ★ここがポイント
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ tracks }),
    };
  } catch (e: unknown) {
    return { statusCode: 500, body: errMsg(e) };
  }
};
