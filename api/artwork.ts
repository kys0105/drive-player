import artwork from '../netlify/functions/artwork.js';
import { privateResponse } from '../netlify/functions/_http.js';

export default {
  fetch(request: Request): Promise<Response> | Response {
    const url = new URL(request.url);
    const path = /^\/(?:api|\.netlify\/functions)\/artwork\/([A-Za-z0-9_-]{1,200})$/.exec(url.pathname);
    const ids = url.searchParams.getAll('audioId');
    const audioId = path?.[1] ?? (url.pathname === '/api/artwork' && ids.length === 1 ? ids[0] : '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(audioId)) return privateResponse('Invalid audio ID', 400);
    url.pathname = `/api/artwork/${audioId}`;
    url.searchParams.delete('audioId');
    return artwork(new Request(url, request));
  },
};
