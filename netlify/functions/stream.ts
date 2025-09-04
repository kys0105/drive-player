// netlify/functions/stream.ts
import { getDrive } from './_drive';
import type { OAuth2Client } from 'google-auth-library';

function guessAudioMime(name: string, driveMime?: string): string {
  const n = name.toLowerCase();
  if (n.endsWith('.mp3')) return 'audio/mpeg';
  if (driveMime === 'audio/mpeg') return driveMime;
  return 'audio/mpeg';
}

export default async (req: Request) => {
  try {
    const urlObj = new URL(req.url);
    const fileId = urlObj.pathname.split('/').pop();
    const ver = urlObj.searchParams.get('v') || ''; // ★ バージョン

    if (!fileId) return new Response('fileId required', { status: 400 });

    const drive = getDrive();
    const meta = await drive.files.get({
      fileId,
      fields: 'id,name,mimeType,size',
      alt: 'json',
    });
    const name = meta.data.name ?? 'audio';
    const mime = guessAudioMime(name, meta.data.mimeType ?? '');
    const sizeNum = Number(meta.data.size ?? 0);
    const hasSize = Number.isFinite(sizeNum) && sizeNum > 0;

    // OAuth2 トークン取り出し
    const auth = (drive.context._options?.auth ?? null) as OAuth2Client | null;
    const token = auth ? (await auth.getAccessToken()).token : null;
    if (!token) return new Response('no access token', { status: 500 });

    // Range 透過
    const range = req.headers.get('range') || undefined;
    const upstream = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const shouldRetry = (s: number) => [429, 500, 502, 503, 504].includes(s);
    let res: Response | null = null;
    for (let i = 0; i < 3; i++) {
      res = await fetch(upstream, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...(range && hasSize ? { Range: range } : {}),
        },
      });
      if (res.ok || res.status === 206) break;
      if (!shouldRetry(res.status)) break;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
    if (!res) return new Response('Upstream fetch failed', { status: 502 });
    if (!res.ok && res.status !== 206) {
      const txt = await res.text().catch(() => '');
      return new Response(txt || 'Upstream error', { status: res.status });
    }

    // ヘッダ整形
    const out = new Headers();
    for (const k of [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'etag',
      'last-modified',
      'cache-control',
    ] as const) {
      const v = res.headers.get(k);
      if (v) out.set(k, v);
    }
    if (!out.has('content-type')) out.set('content-type', mime);
    if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');

    // ★ ここがポイント：v がある時だけ長期キャッシュ可能に
    if (ver) {
      out.set('cache-control', 'public, max-age=31536000, immutable');
      out.set('Vary', 'Range'); // 念のため
      // ETag は上流のままでOK。任意で x-cache-key を付与しても良い
      out.set('x-cache-key', `${fileId}:${ver}`);
    } else {
      out.set('cache-control', 'no-store');
    }

    return new Response(res.body, { status: res.status, headers: out });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(msg || 'stream error', { status: 500 });
  }
};
