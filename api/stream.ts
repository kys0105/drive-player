import stream from '../netlify/functions/stream.ts';
import { privateResponse } from '../netlify/functions/_http.ts';

export default {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);
    // Rewrites preserve the original URL on some runtimes and expose the
    // destination URL on others. Accept either shape, with one validated ID.
    const path = /^\/(?:api|\.netlify\/functions)\/stream\/([A-Za-z0-9_-]{1,200})$/.exec(
      url.pathname
    );
    const ids = url.searchParams.getAll('fileId');
    const fileId = path?.[1] ?? (url.pathname === '/api/stream' && ids.length === 1 ? ids[0] : '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) return privateResponse('Invalid file ID', 400);
    url.pathname = `/api/stream/${fileId}`;
    url.searchParams.delete('fileId');
    // Preserve the upstream ReadableStream; do not buffer music into an arrayBuffer.
    return stream(new Request(url, request));
  },
};
