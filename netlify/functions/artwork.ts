import { createHash } from 'node:crypto';
import type { ArtworkAsset } from '../../src/types.js';
import { requireSession } from './_auth.js';
import { DriveLibrary, LibraryError, libraryError, validId, version } from './_library.js';
import { methodNotAllowed, privateResponse } from './_http.js';

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 4096, MAX_PIXELS = 16_000_000;
const MIME = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' } as const;
type Dimensions = { width: number; height: number };
function invalid(): never { throw new LibraryError(415, 'Invalid artwork image'); }
function dimensions(width: number, height: number): Dimensions {
  if (!width || !height) invalid();
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new LibraryError(413, 'Artwork dimensions are too large');
  return { width, height };
}

// Inspect bounded image containers without decoding untrusted pixel data. The
// returned MIME always follows these signatures, never the uploaded filename.
function png(bytes: Buffer): Dimensions {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
  let offset = 8, size: Dimensions | undefined, image = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) invalid();
    if (!size) {
      if (kind !== 'IHDR' || length !== 13) invalid();
      size = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      if (bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (kind === 'IHDR' || kind === 'acTL') invalid();
    if (kind === 'IDAT' && length) image = true;
    if (kind === 'IEND') {
      if (length || !image || end !== bytes.length) invalid();
      return size;
    }
    offset = end;
  }
  return invalid();
}

function jpeg(bytes: Buffer): Dimensions {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) invalid();
  let offset = 2, size: Dimensions | undefined, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) invalid();
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scan || offset !== bytes.length) invalid();
      return size;
    }
    if (marker === 0 || marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) invalid();
      const current = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
      if (size && (size.width !== current.width || size.height !== current.height)) invalid();
      size = current;
    }
    offset = end;
    if (marker === 0xda) {
      if (!size || length < 6) invalid();
      scan = true;
      // Entropy data can contain escaped FF bytes and restart markers. Stop at
      // the next segment so progressive JPEG scans are also checked safely.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        const code = bytes[next];
        if (code === 0 || (code >= 0xd0 && code <= 0xd7)) offset = next + 1;
        else break;
      }
    }
  }
  return invalid();
}

function webp(bytes: Buffer): Dimensions {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, canvas: Dimensions | undefined, image: Dimensions | undefined;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('latin1', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8, end = start + length, paddedEnd = end + (length & 1);
    if (paddedEnd > bytes.length || ((length & 1) && bytes[end] !== 0)) invalid();
    if (kind === 'VP8X') {
      if (offset !== 12 || canvas || length !== 10 || (bytes[start] & 0x02)) invalid();
      canvas = dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1);
    } else if (kind === 'VP8 ' || kind === 'VP8L') {
      if (image) invalid();
      if (kind === 'VP8 ') {
        if (length < 10 || (bytes[start] & 1) || bytes.toString('hex', start + 3, start + 6) !== '9d012a') invalid();
        image = dimensions(bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff);
      } else {
        if (length < 5 || bytes[start] !== 0x2f) invalid();
        const bits = bytes.readUInt32LE(start + 1);
        if (bits >>> 29) invalid();
        image = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
    } else if (kind === 'ANIM' || kind === 'ANMF') invalid();
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !image || (canvas && (canvas.width !== image.width || canvas.height !== image.height))) invalid();
  return image;
}

async function readImage(response: Response, format: ArtworkAsset['format']): Promise<Buffer> {
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new LibraryError(502, 'Unable to load artwork'); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel(); throw new LibraryError(413, 'Artwork file is too large'); }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (mime !== MIME[format] && mime !== 'application/octet-stream') { await response.body.cancel(); invalid(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new LibraryError(413, 'Artwork file is too large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  ({ png, jpg: jpeg, webp })[format](bytes);
  return bytes;
}

export default async function artwork(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  const auth = requireSession(request); if (auth instanceof Response) return auth;
  const url = new URL(request.url), audioId = url.pathname.split('/').pop() ?? '';
  const versions = url.searchParams.getAll('v');
  if (!validId(audioId)) return libraryError(new LibraryError(400, 'Invalid audio ID'));
  if (versions.length !== 1 || !versions[0] || versions[0].length > 200) return libraryError(new LibraryError(400, 'Artwork version is required'));
  try {
    const library = new DriveLibrary(), audio = await library.audio(audioId);
    const match = library.artworkAssociation(audio.file, await library.children(audio.album.id));
    if (match.issue) throw new LibraryError(409, 'Artwork association is ambiguous');
    if (!match.asset || !match.file) throw new LibraryError(404, 'Not found');
    if (versions[0] !== match.asset.ver) throw new LibraryError(409, 'Artwork changed; refresh the library');
    const file = await library.metadata(match.asset.id);
    if (file.parents?.length !== 1 || file.parents[0] !== audio.album.id || file.name !== match.file.name || file.mimeType !== match.file.mimeType) throw new LibraryError(404, 'Not found');
    if (version(file) !== match.asset.ver) throw new LibraryError(409, 'Artwork changed; refresh the library');
    if (Number(file.size) > MAX_BYTES) throw new LibraryError(413, 'Artwork file is too large');
    const token = await library.accessToken();
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id!)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' }, redirect: 'error',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000)]),
    });
    const bytes = await readImage(response, match.asset.format);
    if (file.md5Checksum) {
      if (!/^[a-f0-9]{32}$/i.test(file.md5Checksum)) throw new LibraryError(502, 'Unable to verify artwork');
      if (createHash('md5').update(bytes).digest('hex') !== file.md5Checksum.toLowerCase()) throw new LibraryError(409, 'Artwork changed; refresh the library');
    } else {
      const after = await library.metadata(file.id!);
      if (!file.modifiedTime || version(after) !== version(file) || after.name !== file.name || after.mimeType !== file.mimeType || after.parents?.length !== 1 || after.parents[0] !== audio.album.id) throw new LibraryError(409, 'Artwork changed; refresh the library');
    }
    return privateResponse(request.method === 'HEAD' ? null : bytes, 200, {
      'Content-Type': MIME[match.asset.format], 'Content-Length': String(bytes.length),
      'Content-Disposition': 'inline',
    });
  } catch (error) { return libraryError(error); }
}
