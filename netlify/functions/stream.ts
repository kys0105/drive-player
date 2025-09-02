// netlify/functions/stream.ts （該当箇所だけ差し替え）
import type { Handler } from '@netlify/functions';
import { getDrive } from './_drive';
import type { Readable } from 'node:stream';

function guessAudioMime(name: string, driveMime: string | undefined) {
  const n = name.toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4'; // m4aは実質AAC in MP4
  // Driveの値が妥当なら使う
  if (driveMime && driveMime.startsWith('audio/')) return driveMime;
  // Driveがvideo/mp4だが拡張子がm4a系なら補正
  if ((n.endsWith('.m4a') || n.endsWith('.aac')) && driveMime === 'video/mp4') return 'audio/mp4';
  return 'audio/mpeg'; // 最低限でmp3扱いにフォールバック
}

export const handler: Handler = async (event) => {
  try {
    const fileId = event.path.split('/').pop();
    if (!fileId) return { statusCode: 400, body: 'fileId required' };

    const drive = getDrive();

    // メタ情報取得（nameも取得）
    const meta = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      alt: 'json',
    });

    const name = meta.data.name || '';
    const driveMime = meta.data.mimeType || undefined;
    const mime = guessAudioMime(name, driveMime);

    const sizeNum = Number(meta.data.size ?? 0);
    const hasSize = Number.isFinite(sizeNum) && sizeNum > 0;

    // Range
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

    // Drive から取得（Range 対応）
    const resp = await drive.files.get(
      { fileId, alt: 'media' },
      {
        responseType: 'stream',
        headers: range && hasSize ? { Range: `bytes=${start}-${end}` } : {},
      }
    );

    // stream -> Buffer
    const stream = resp.data as unknown as Readable;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const buf = Buffer.concat(chunks);

    // ヘッダ
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Length': String(buf.byteLength),
    };
    if (range && hasSize && end !== undefined) {
      headers['Content-Range'] = `bytes ${start}-${end}/${sizeNum}`;
      headers['Content-Length'] = String(end - start + 1);
    }

    return {
      statusCode: range && hasSize ? 206 : 200,
      headers,
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { statusCode: 500, body: msg };
  }
};
