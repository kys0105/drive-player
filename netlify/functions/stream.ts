import type { Handler } from '@netlify/functions';
import { getDrive } from './_drive';
import type { Readable } from 'node:stream';

export const handler: Handler = async (event) => {
  const fileId = event.path.split('/').pop();
  if (!fileId) return { statusCode: 400, body: 'fileId required' };

  const drive = getDrive();

  // メタ情報（サイズ・MIME）
  const meta = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,size',
    alt: 'json',
  });
  const mime = meta.data.mimeType || 'application/octet-stream';
  const size = Number(meta.data.size || 0);

  // Range 解析
  const range = event.headers['range'];
  let start = 0;
  let end = size ? size - 1 : undefined;

  if (range && size) {
    const m = /bytes=(\d+)-(\d+)?/.exec(range);
    if (m) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (size && end !== undefined) headers['Content-Length'] = String(end - start + 1);
  if (range && size) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  // Drive からデータ取得（Range対応）
  const resp = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream', headers: range ? { Range: `bytes=${start}-${end}` } : {} }
  );

  // ストリーム→Bufferに読み込み、base64 で返す
  const stream = resp.data as unknown as Readable;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const buf = Buffer.concat(chunks);

  return {
    statusCode: range && size ? 206 : 200,
    headers,
    body: buf.toString('base64'),
    isBase64Encoded: true,
  };
};
