import { createHash } from 'node:crypto';
import { requireSession } from './_auth.js';
import { DriveLibrary, LibraryError, libraryError, validId } from './_library.js';
import { jsonResponse, methodNotAllowed } from './_http.js';

const MAX_BYTES = 800_000, MAX_CHARACTERS = 200_000, MAX_LINES = 5_000;
function binaryControls(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

async function readText(response: Response): Promise<{ text: string; checksum: string }> {
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new LibraryError(502, 'Unable to load lyrics'); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new LibraryError(413, 'Lyrics file is too large'); }
  if (/^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')) { await response.body.cancel(); throw new LibraryError(415, 'Invalid lyrics text'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new LibraryError(413, 'Lyrics file is too large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new LibraryError(415, 'Invalid lyrics UTF-8'); }
  if (text.length > MAX_CHARACTERS || text.split(/\r\n?|\n/).length > MAX_LINES) throw new LibraryError(413, 'Lyrics file is too large');
  if (!text.trim() || binaryControls(text)) throw new LibraryError(415, 'Invalid lyrics text');
  return { text, checksum: createHash('md5').update(bytes).digest('hex') };
}

export default async function lyrics(request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(request); if (auth instanceof Response) return auth;
  const audioId = new URL(request.url).pathname.split('/').pop() ?? '';
  if (!validId(audioId)) return libraryError(new LibraryError(400, 'Invalid audio ID'));
  try {
    const library = new DriveLibrary();
    const audio = await library.audio(audioId);
    const match = library.association(audio.file, await library.children(audio.album.id));
    const identity = { audioId, albumId: audio.album.id };
    if (!match.asset || !match.file) return jsonResponse({ ...identity, lyrics: null, ...(match.issue ? { issue: match.issue } : {}) });
    if (Number(match.file.size) > MAX_BYTES) throw new LibraryError(413, 'Lyrics file is too large');
    const file = await library.metadata(match.asset.id);
    if (file.parents?.length !== 1 || file.parents[0] !== audio.album.id || file.name !== match.file.name || file.mimeType !== match.file.mimeType) throw new LibraryError(404, 'Not found');
    const token = await library.accessToken();
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(match.asset.id)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' }, redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    const { text, checksum } = await readText(response);
    // The file may have been edited between metadata and content reads. Do not
    // attach new text to a stale cache version; let the client retry its listing.
    if (file.md5Checksum && /^[a-f0-9]{32}$/i.test(file.md5Checksum) && checksum !== file.md5Checksum.toLowerCase()) throw new LibraryError(409, 'Lyrics changed; refresh the library');
    return jsonResponse({ ...identity, lyrics: { id: match.asset.id, ver: file.md5Checksum ?? file.modifiedTime ?? '', format: match.asset.format, text } });
  } catch (error) { return libraryError(error); }
}
