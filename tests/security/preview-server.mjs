// Local browser verification only. Never bundled into the production application.
import { createServer } from 'node:http';
import { createHash, scryptSync } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadFunction, setDriveMock } from './helpers.mjs';

const host = 'localhost';
const port = 4177;
const origin = `http://${host}:${port}`;
const distRoot = resolve(fileURLToPath(new URL('../../dist/', import.meta.url)));
const salt = Buffer.from('only-for-tests!!');
const hash = scryptSync('security-regression-test-passphrase', salt, 32, {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
process.env.SESSION_SECRET = 'this-is-a-browser-test-secret-with-over-32-bytes';
process.env.FOLDER_ID = 'browser_fixture_folder_1234567890';
process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({
  client_email: 'browser-tests@example.invalid',
  private_key: 'test-fixture-key',
});

// Original encoded silence: a real decodable MP3, long enough to inspect playback.
const audioFixture = await readFile(new URL('../fixtures/silence.mp3', import.meta.url));
const fixtureVersion = createHash('md5').update(audioFixture).digest('hex');
const albumId = 'browser_fixture_album_3333333333';
const demoAlbumId = 'browser_fixture_album_4444444444';
process.env.DEFAULT_ALBUM_ID = albumId;
const folder = (id, name, parent) => ({ id, name, mimeType: 'application/vnd.google-apps.folder', parents: [parent], trashed: false });
const folders = [
  folder(process.env.FOLDER_ID, '00_試聴用', 'browser_fixture_music_parent'),
  folder(albumId, '3rd album', process.env.FOLDER_ID),
  folder(demoAlbumId, 'Demo collection', process.env.FOLDER_ID),
];
const files = [
  { id: 'browser_fixture_audio_1111111111', name: 'Security fixture one_track.mp3', albumId },
  { id: 'browser_fixture_audio_2222222222', name: 'Security fixture two_track.mp3', albumId },
  { id: 'browser_fixture_audio_5555555555', name: 'Demo collection sample_track.mp3', albumId: demoAlbumId },
].map(({ albumId: parent, ...file }) => ({
  ...file, mimeType: 'audio/mpeg', size: String(audioFixture.length), parents: [parent],
  trashed: false, md5Checksum: fixtureVersion, modifiedTime: '2026-10-28T00:00:00Z',
}));
// Original test-only text. No Notion lyrics or real private music are bundled.
const lyricBodies = new Map([
  ['browser_fixture_lyrics_1111111111', Buffer.from('[00:00.00]テスト用の一行目\n\n[00:05.00]五秒からの二行目\n[00:10.00]十秒からの三行目\n', 'utf8')],
  ['browser_fixture_lyrics_2222222222', Buffer.from('[00:00.00]二曲目のテスト歌詞\n\n[00:06.00]段落を分けた二行目\n[00:12.00]最後のテスト行\n', 'utf8')],
]);
const lyricFiles = [...lyricBodies].map(([id, body], index) => ({
  id, name: files[index].name.replace(/\.mp3$/i, '.lrc'), mimeType: 'text/plain',
  size: String(body.length), md5Checksum: createHash('md5').update(body).digest('hex'),
  parents: [albumId], trashed: false, modifiedTime: '2026-10-28T00:00:00Z',
}));
const entries = [...folders, ...files, ...lyricFiles];

setDriveMock(() => ({
  files: {
    async list({ q }) {
      const parent = /^'([A-Za-z0-9_-]+)' in parents/.exec(q)?.[1];
      if (!parent) throw new Error('Fixture requires a parent-restricted query');
      return { data: { files: entries.filter(entry => entry.parents.includes(parent) && !entry.trashed) } };
    },
    async get({ fileId }) {
      const file = entries.find((entry) => entry.id === fileId);
      if (!file) throw Object.assign(new Error('Unknown fixture file'), { code: 404 });
      return { data: file };
    },
  },
  context: {
    _options: {
      auth: {
        async getAccessToken() {
          return { token: 'browser-fixture-token' };
        },
      },
    },
  },
}));
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
  if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/files/')) {
    return nativeFetch(input, init);
  }
  const fileId = url.pathname.split('/').pop();
  const file = entries.find(entry => entry.id === fileId);
  if (!file || !['audio/mpeg', 'text/plain'].includes(file.mimeType) || url.searchParams.get('alt') !== 'media') return new Response(null, { status: 404 });
  if (new Headers(init?.headers).get('Authorization') !== 'Bearer browser-fixture-token') return new Response(null, { status: 403 });
  const payload = file.mimeType === 'text/plain' ? lyricBodies.get(fileId) : audioFixture;
  if (!payload) return new Response(null, { status: 404 });
  const headers = new Headers({ 'Content-Type': file.mimeType, 'Accept-Ranges': 'bytes' });
  const range = new Headers(init?.headers).get('Range');
  let start = 0;
  let end = payload.length - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else {
      start = Math.max(0, payload.length - Number(match[2]));
    }
    if (start > end || start >= payload.length) {
      headers.set('Content-Range', `bytes */${payload.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${payload.length}`);
  }
  const body = payload.subarray(start, end + 1);
  headers.set('Content-Length', String(body.length));
  return new Response(init?.method === 'HEAD' ? null : body, {
    status: range ? 206 : 200,
    headers,
  });
};

const names = ['login', 'session', 'logout', 'list', 'stream', 'albums', 'lyrics'];
export const handlers = Object.fromEntries(
  await Promise.all(names.map(async (name) => [name, await loadFunction(name, { directory: 'api', webExport: true })]))
);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', origin);
    const functionName = /^\/(?:api|\.netlify\/functions)\/(login|session|logout|list|stream|albums|lyrics)(?:\/|$)/.exec(url.pathname)?.[1];
    let response;
    if (functionName) {
      const abort = new AbortController();
      incoming.once('aborted', () => abort.abort());
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
        else if (value !== undefined) headers.set(name, value);
      }
      const method = incoming.method ?? 'GET';
      const request = new Request(url, {
        method,
        headers,
        signal: abort.signal,
        ...(!['GET', 'HEAD'].includes(method)
          ? { body: Readable.toWeb(incoming), duplex: 'half' }
          : {}),
      });
      response = await handlers[functionName](request);
    } else {
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        pathname = '/';
      }
      let filePath = resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (filePath !== distRoot && !filePath.startsWith(`${distRoot}${sep}`)) {
        response = new Response('Not found', { status: 404 });
      } else {
        try {
          if (!(await stat(filePath)).isFile()) throw new Error('Not a file');
        } catch {
          filePath = resolve(distRoot, 'index.html');
        }
        response = new Response(await readFile(filePath), {
          headers: {
            'Content-Type': types[extname(filePath)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
          },
        });
      }
    }
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (incoming.method === 'HEAD' || !response.body) return outgoing.end();
    Readable.fromWeb(response.body)
      .on('error', () => outgoing.destroy())
      .pipe(outgoing);
  } catch {
    if (!outgoing.headersSent)
      outgoing.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    outgoing.end('Local test server error');
  }
});
// API-only import lets Node verify the same fixtures without opening a port.
if (process.env.DRIVE_FIXTURE_API_ONLY !== '1') {
  server.listen(port, host, () => { console.log(`Test-only browser preview: ${origin}`); });
}
