import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { assertPrivate, clearDriveMock, loadFunction, request, sessionCookie, setDriveMock } from './helpers.mjs';

const password = 'vercel-adapter-regression-passphrase';
const salt = Buffer.from('only-for-tests!!');
const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const originalEnv = Object.fromEntries(
  ['APP_PASSWORD_HASH', 'SESSION_SECRET', 'FOLDER_ID', 'GOOGLE_SERVICE_ACCOUNT_BASE64', 'GOOGLE_SERVICE_ACCOUNT']
    .map((key) => [key, process.env[key]])
);
const originalFetch = globalThis.fetch;
const fileId = 'vercel_audio_fixture';
const folderId = 'vercel_folder_fixture';
const handlers = {};
let cookie;
let mediaRequest;

function loggedInRequest(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  return request(path, { ...init, headers });
}

before(async () => {
  process.env.APP_PASSWORD_HASH = `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
  process.env.SESSION_SECRET = 'vercel-adapter-test-secret-at-least-32-bytes';
  process.env.FOLDER_ID = folderId;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({ client_email: 'test@example.invalid', private_key: 'fixture-only' });
  for (const name of ['login', 'session', 'logout', 'list', 'stream']) {
    handlers[name] = await loadFunction(name, { directory: 'api', webExport: true });
  }
  const response = await handlers.login(request('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }));
  assert.equal(response.status, 200);
  cookie = sessionCookie(response);
});

beforeEach(() => {
  mediaRequest = null;
  setDriveMock(() => ({
    files: {
      async get({ fileId: requestedId }) { return { data: requestedId === folderId ? { id: folderId, name: '試聴用', mimeType: 'application/vnd.google-apps.folder', trashed: false } : { id: fileId, name: 'noah_track.mp3', mimeType: 'audio/mpeg', parents: [folderId], trashed: false, size: '6000000' } }; },
      async list() { return { data: { files: [{ id: fileId, name: 'noah_track.mp3', mimeType: 'audio/mpeg', md5Checksum: 'v1', parents: [folderId], trashed: false }] } }; },
    },
    context: { _options: { auth: { async getAccessToken() { return { token: 'fixture-access-token' }; } } } },
  }));
  globalThis.fetch = async (input, init) => {
    mediaRequest = { url: String(input), method: init.method, headers: new Headers(init.headers), signal: init.signal };
    const range = new Headers(init.headers).get('Range');
    return new Response(init.method === 'HEAD' ? null : 'fixture-audio', {
      status: range ? 206 : 200,
      headers: { 'Content-Type': 'audio/mpeg', ...(range ? { 'Content-Range': 'bytes 0-12/6000000' } : {}) },
    });
  };
});

afterEach(() => { globalThis.fetch = originalFetch; clearDriveMock(); });
after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('Vercel adapters preserve authentication, CSRF, methods and private CDN headers', async () => {
  for (const name of ['session', 'list', 'stream']) {
    const path = name === 'stream' ? `/api/stream/${fileId}` : `/api/${name}`;
    const denied = await handlers[name](request(path));
    assert.equal(denied.status, 401);
    assertPrivate(assert, denied);
    assert.equal(denied.headers.get('Vercel-CDN-Cache-Control'), 'no-store');
  }
  assert.equal((await handlers.login(request('/api/login', {
    method: 'POST', origin: 'https://attacker.example', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }))).status, 403);
  assert.equal((await handlers.logout(request('/api/logout', { method: 'POST', origin: 'https://attacker.example' }))).status, 403);
  assert.equal((await handlers.login(request('/api/login'))).status, 405);
});

test('server-confirmed offline lease is 30 days from verification, independent of Cookie expiry', async () => {
  const response = await handlers.session(loggedInRequest('/api/session'));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.offlineUntil - value.serverTime, 30 * 24 * 60 * 60);
  assert.ok(value.serverTime * 1000 <= Date.now());
  assert.ok(value.expiresAt > value.serverTime);
  assert.equal(value.authenticated, true);
  assert.ok(value.cacheScope);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('canonical and legacy stream rewrites preserve validated file IDs and Range/HEAD', async () => {
  for (const path of [`/api/stream/${fileId}?v=v1`, `/api/stream?fileId=${fileId}&v=v1`, `/.netlify/functions/stream/${fileId}?v=v1`]) {
    const response = await handlers.stream(loggedInRequest(path, { headers: { Range: 'bytes=0-12' } }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), 'bytes 0-12/6000000');
    assert.equal(await response.text(), 'fixture-audio');
    assert.ok(mediaRequest.url.includes(`/files/${fileId}?alt=media`));
    assert.equal(mediaRequest.headers.get('Range'), 'bytes=0-12');
    assert.ok(mediaRequest.signal instanceof AbortSignal);
  }
  const head = await handlers.stream(loggedInRequest(`/api/stream?fileId=${fileId}`, { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(mediaRequest.method, 'HEAD');
  for (const path of ['/api/stream', '/api/stream?fileId=one&fileId=two', '/api/stream?fileId=bad%2Fid', '/api/stream/invalid/id']) {
    assert.equal((await handlers.stream(loggedInRequest(path))).status, 400);
  }
});

test('large audio response remains a lazy ReadableStream with backpressure and cancellation', async () => {
  const chunk = new Uint8Array(64 * 1024);
  let pulls = 0;
  let cancelled = false;
  const upstream = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(chunk); if (pulls === 100) controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  globalThis.fetch = async () => new Response(upstream, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(chunk.byteLength * 100) } });
  const response = await handlers.stream(loggedInRequest(`/api/stream?fileId=${fileId}`));
  assert.equal(response.status, 200);
  assert.equal(pulls, 0, 'the adapter must not read or buffer upstream audio before returning');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.value.byteLength, chunk.byteLength);
  assert.equal(pulls, 1);
  await reader.cancel();
  assert.equal(cancelled, true);

  let count = 0;
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); if (++count === 100) controller.close(); },
  }, { highWaterMark: 0 }));
  const full = await handlers.stream(loggedInRequest(`/api/stream/${fileId}`));
  const body = await full.arrayBuffer();
  assert.equal(body.byteLength, 6_553_600, 'a streamed response may exceed the buffered-function 4.5MB limit');
});

test('Vercel config routes old URLs to the same protected APIs and sets bounded streaming duration', async () => {
  const config = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.functions['api/*.ts'].maxDuration, 300);
  assert.equal(config.functions['api/*.ts'].supportsCancellation, true);
  for (const name of ['login', 'session', 'logout', 'list']) {
    assert.ok(config.rewrites.some((rule) => rule.source === `/.netlify/functions/${name}` && rule.destination === `/api/${name}`));
  }
  assert.ok(config.rewrites.some((rule) => rule.source === '/api/stream/:fileId'));
  assert.ok(config.rewrites.some((rule) => rule.source === '/.netlify/functions/stream/:fileId'));
});
