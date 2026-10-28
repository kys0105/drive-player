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
const files = [
  { id: 'browser_fixture_audio_1111111111', name: 'Security fixture one_track.mp3' },
  { id: 'browser_fixture_audio_2222222222', name: 'Security fixture two_track.mp3' },
].map((file) => ({
  ...file,
  mimeType: 'audio/mpeg',
  size: String(audioFixture.length),
  parents: [process.env.FOLDER_ID],
  trashed: false,
  md5Checksum: fixtureVersion,
  modifiedTime: '2026-10-26T00:00:00Z',
}));
setDriveMock(() => ({
  files: {
    async list() {
      return { data: { files } };
    },
    async get({ fileId }) {
      const file = files.find((entry) => entry.id === fileId);
      if (!file) throw new Error('Unknown fixture file');
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
  const headers = new Headers({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
  const range = new Headers(init?.headers).get('Range');
  let start = 0;
  let end = audioFixture.length - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416 });
    if (match[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), end);
    } else {
      start = Math.max(0, audioFixture.length - Number(match[2]));
    }
    if (start > end || start >= audioFixture.length) {
      headers.set('Content-Range', `bytes */${audioFixture.length}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Range', `bytes ${start}-${end}/${audioFixture.length}`);
  }
  const body = audioFixture.subarray(start, end + 1);
  headers.set('Content-Length', String(body.length));
  return new Response(init?.method === 'HEAD' ? null : body, {
    status: range ? 206 : 200,
    headers,
  });
};

const names = ['login', 'session', 'logout', 'list', 'stream'];
const handlers = Object.fromEntries(
  await Promise.all(names.map(async (name) => [name, await loadFunction(name, { directory: 'api', webExport: true })]))
);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url ?? '/', origin);
    const functionName = /^\/(?:api|\.netlify\/functions)\/(login|session|logout|list|stream)(?:\/|$)/.exec(url.pathname)?.[1];
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
server.listen(port, host, () => {
  console.log(`Test-only browser preview: ${origin}`);
});
