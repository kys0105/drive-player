import type { Handler } from '@netlify/functions';
import { getDrive } from './_drive';

function guessAudioMimeByName(name: string, driveMime?: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.wav')) return 'audio/wav';
  if (driveMime && driveMime.startsWith('audio/')) return driveMime;
  return driveMime ?? 'application/octet-stream';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const handler: Handler = async () => {
  try {
    const folderId = process.env.FOLDER_ID;
    if (!folderId) {
      return { statusCode: 500, body: 'FOLDER_ID is not set' };
    }

    const drive = getDrive();

    const q = [
      `'${folderId}' in parents`,
      'trashed=false',
      "(mimeType='audio/mpeg' or mimeType='audio/wav' or mimeType='audio/x-wav')",
    ].join(' and ');

    const res = await drive.files.list({
      q,
      fields: 'files(id,name,mimeType,iconLink,thumbnailLink,modifiedTime,size),nextPageToken',
      orderBy: 'name_natural',
      pageSize: 1000,
      // pageToken のハンドリングは必要に応じて（今回は 1000 件まで）
    });

    const files = res.data.files ?? [];

    const tracks = files.map((f) => {
      const name = f.name ?? 'audio';
      const driveMime = f.mimeType ?? '';
      const guessed = guessAudioMimeByName(name, driveMime);
      return {
        id: f.id!,
        title: name,
        mimeType: guessed, // UI 用（<audio> canPlayType 判定に）
        driveMimeType: driveMime, // デバッグ確認用
        artwork: f.thumbnailLink ?? undefined,
        artist: '', // 必要なら命名規則で抽出
        size: f.size ? Number(f.size) : undefined,
        modifiedTime: f.modifiedTime ?? undefined,
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
