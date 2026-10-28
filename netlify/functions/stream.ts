import { requireSession } from './_auth.js';
import { getDrive, getFolderId } from './_drive.js';
import { methodNotAllowed, privateResponse } from './_http.js';

function validRange(range: string): boolean {
  const parts = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(range);
  if (!parts || (!parts[1] && !parts[2])) return false;
  const start = Number(parts[1]);
  const end = Number(parts[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  return !parts[1] ? end > 0 : !parts[2] || end >= start;
}

async function handleStream(req: Request): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  const auth = requireSession(req);
  if (auth instanceof Response) return auth;
  const folderId = getFolderId();
  if (!folderId) return privateResponse('Service unavailable', 503);
  const fileId = new URL(req.url).pathname.split('/').pop() ?? '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) return privateResponse('Invalid file ID', 400);
  const range = req.headers.get('range');
  if (range && !validRange(range)) {
    return privateResponse('Unsupported range', 416);
  }

  try {
    const drive = getDrive();
    const meta = await drive.files.get({
      fileId,
      fields: 'id,mimeType,size,parents,trashed',
      alt: 'json',
    });
    if (
      meta.data.trashed !== false ||
      meta.data.mimeType !== 'audio/mpeg' ||
      !meta.data.parents?.includes(folderId)
    ) {
      return privateResponse('Not found', 404);
    }

    const client = drive.context._options.auth;
    if (!client || typeof client !== 'object' || !('getAccessToken' in client)) {
      return privateResponse('Service unavailable', 503);
    }
    const access = await client.getAccessToken();
    const token = typeof access === 'string' ? access : access?.token;
    if (!token) return privateResponse('Service unavailable', 503);
    const upstream = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    // A full, explicitly saved song can take longer than 30 seconds on mobile.
    // One shared deadline bounds retries and the streamed body below Vercel's 300s limit.
    const mediaDeadline = AbortSignal.timeout(270_000);
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(upstream, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Accept-Encoding': 'identity',
          ...(range ? { Range: range } : {}),
        },
        redirect: 'error',
        signal: AbortSignal.any([req.signal, mediaDeadline]),
      });
      if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 2) break;
      await res.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!res) return privateResponse('Unable to load audio', 502);
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel();
      return privateResponse(
        req.method === 'HEAD' ? null : 'Unable to load audio',
        res.status === 416 ? 416 : 502
      );
    }
    const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
    // fetch transparently decompresses bodies; do not forward an encoded Content-Length.
    for (const name of ['content-range', 'etag', 'last-modified']) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!res.headers.has('content-encoding')) {
      const length = res.headers.get('content-length');
      if (length) headers.set('content-length', length);
    }
    return privateResponse(req.method === 'HEAD' ? null : res.body, res.status, headers);
  } catch {
    return privateResponse(req.method === 'HEAD' ? null : 'Unable to load audio', 502);
  }
}

export default async function stream(req: Request): Promise<Response> {
  const response = await handleStream(req);
  if (req.method !== 'HEAD') return response;
  await response.body?.cancel();
  return new Response(null, { status: response.status, headers: response.headers });
}
