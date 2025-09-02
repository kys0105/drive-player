import type { Handler } from '@netlify/functions';
import type { Readable } from 'node:stream';
import { getDrive } from './_drive';

/** Drive の mimeType が不正確でも拡張子から確実に audio/*
 *  に補正します（m4a=audio/mp4, mp3=audio/mpeg）。
 */
function guessAudioMime(name: string, driveMime?: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4'; // AAC in MP4 想定
  if (driveMime && driveMime.startsWith('audio/')) return driveMime;
  if ((n.endsWith('.m4a') || n.endsWith('.aac')) && driveMime === 'video/mp4') {
    return 'audio/mp4';
  }
  return 'audio/mpeg';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const handler: Handler = async (event) => {
  try {
    const fileId = event.path.split('/').pop();
    if (!fileId) return { statusCode: 400, body: 'fileId required' };

    const drive = getDrive();

    // メタ情報（name / mimeType / size を取得）
    const meta = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      alt: 'json',
    });

    const name = meta.data.name ?? 'audio';
    const driveMime = meta.data.mimeType ?? '';
    const mime = guessAudioMime(name, driveMime);

    const sizeNum = Number(meta.data.size ?? 0);
    const hasSize = Number.isFinite(sizeNum) && sizeNum > 0;

    // Range リクエスト対応
    const range = event.headers['range'];
    let start = 0;
    let end = hasSize ? sizeNum - 1 : undefined;
    if (range && hasSize) {
      const m = /bytes=(\d+)-(\d+)?/.exec(range);
      if (m) {
        start = parseInt(m[1], 10);
        if (m[2]) end = Math.min(parseInt(m[2], 10), sizeNum - 1);
      }
    }

    // Drive から本体取得（Range があれば伝搬）
    const resp = await drive.files.get(
      { fileId, alt: 'media' },
      {
        responseType: 'stream',
        headers: range && hasSize ? { Range: `bytes=${start}-${end}` } : {},
      }
    );

    // stream → Buffer（Netlify との相性を考え base64 応答）
    const stream = resp.data as unknown as Readable;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const buf = Buffer.concat(chunks);

    // 応答ヘッダ
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };

    if (range && hasSize && end !== undefined) {
      headers['Content-Range'] = `bytes ${start}-${end}/${sizeNum}`;
      headers['Content-Length'] = String(end - start + 1);
    } else {
      headers['Content-Length'] = String(buf.byteLength);
    }

    return {
      statusCode: range && hasSize ? 206 : 200,
      headers,
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e: unknown) {
    return { statusCode: 500, body: errMsg(e) };
  }
};
