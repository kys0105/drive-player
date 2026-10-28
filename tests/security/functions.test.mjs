import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import {
  assertPrivate,
  clearDriveMock,
  loadFunction,
  request,
  sessionCookie,
  setDriveMock,
} from './helpers.mjs';

const password = 'security-regression-test-passphrase';
const salt = Buffer.from('only-for-tests!!');
const hash = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const passwordHash = `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
const folderId = 'allowed_folder_1234567890';
const fileId = 'valid_audio_file_1234567890';
const originalEnv = Object.fromEntries(
  [
    'APP_PASSWORD_HASH',
    'SESSION_SECRET',
    'FOLDER_ID',
    'GOOGLE_SERVICE_ACCOUNT_BASE64',
    'GOOGLE_SERVICE_ACCOUNT',
  ].map((key) => [key, process.env[key]])
);
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let login;
let session;
let logout;
let list;
let stream;
let cookie;
let driveCalls;
let mediaCalls;
let metadata;
let listArgs;
let requestedRange;
let tokenCalls;

async function logIn(options = {}) {
  return login(
    request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      ...options,
    })
  );
}

function authenticated(path, options = {}) {
  return withCookie(cookie, path, options);
}

function withCookie(browserCookie, path, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('Cookie', browserCookie);
  return request(path, { ...options, headers });
}

before(async () => {
  process.env.APP_PASSWORD_HASH = passwordHash;
  process.env.SESSION_SECRET = 'this-is-a-test-secret-with-over-32-bytes';
  process.env.FOLDER_ID = folderId;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({
    client_email: 'tests@example.invalid',
    private_key: 'test-fixture-key',
  });
  [login, session, logout, list, stream] = await Promise.all(
    ['login', 'session', 'logout', 'list', 'stream'].map(loadFunction)
  );
  const response = await logIn();
  assert.equal(response.status, 200);
  cookie = sessionCookie(response);
});

beforeEach(() => {
  process.env.APP_PASSWORD_HASH = passwordHash;
  process.env.SESSION_SECRET = 'this-is-a-test-secret-with-over-32-bytes';
  process.env.FOLDER_ID = folderId;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = JSON.stringify({
    client_email: 'tests@example.invalid',
    private_key: 'test-fixture-key',
  });
  Date.now = originalNow;
  driveCalls = 0;
  mediaCalls = 0;
  tokenCalls = 0;
  listArgs = undefined;
  requestedRange = undefined;
  metadata = {
    id: fileId,
    name: 'Example_track.mp3',
    mimeType: 'audio/mpeg',
    parents: [folderId],
    trashed: false,
    size: '10',
  };
  setDriveMock(() => {
    driveCalls++;
    return {
      files: {
        async get({ fileId: requestedId }) {
          return { data: requestedId === folderId ? { id: folderId, name: '試聴用', mimeType: 'application/vnd.google-apps.folder', trashed: false } : metadata };
        },
        async list(args) {
          listArgs = args;
          return { data: { files: [
            { ...metadata, md5Checksum: 'file-version' },
            { id: 'not_audio_fixture', name: 'ignore.pdf', mimeType: 'application/pdf', parents: [folderId], trashed: false },
            { id: 'outside_audio_fixture', name: 'outside.mp3', mimeType: 'audio/mpeg', parents: ['outside_fixture'], trashed: false },
          ] } };
        },
      },
      context: {
        _options: {
          auth: {
            async getAccessToken() {
              tokenCalls++;
              return { token: 'mock-access-token' };
            },
          },
        },
      },
    };
  });
  globalThis.fetch = async (input, init) => {
    mediaCalls++;
    assert.match(String(input), /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\//);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer mock-access-token');
    requestedRange = headers.get('Range');
    return new Response(requestedRange ? '1234' : '0123456789', {
      status: requestedRange ? 206 : 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': requestedRange ? '4' : '10',
        ...(requestedRange ? { 'Content-Range': 'bytes 1-4/10' } : {}),
        'Cache-Control': 'public, max-age=31536000',
      },
    });
  };
});

afterEach(() => {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  clearDriveMock();
});

after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('HTTPS login establishes an opaque, signed HttpOnly host cookie and private response', async () => {
  const response = await logIn();
  assert.equal(response.status, 200);
  assertPrivate(assert, response);
  const header = response.headers.get('Set-Cookie');
  assert.match(header, /^__Host-drive_session=/);
  assert.match(header, /;\s*HttpOnly(?:;|$)/i);
  assert.match(header, /;\s*Secure(?:;|$)/i);
  assert.match(header, /;\s*SameSite=(?:Strict|Lax)(?:;|$)/i);
  assert.match(header, /;\s*Path=\/(?:;|$)/i);
  assert.doesNotMatch(header, /Domain=/i);
  assert.doesNotMatch(header, new RegExp(password));
  const result = await response.json();
  assert.equal(result.authenticated, true);
  assert.ok(result.expiresAt > originalNow() / 1000);
  assert.ok(typeof result.cacheScope === 'string' && result.cacheScope.length >= 16);
});

test('session endpoint validates the cookie server-side', async () => {
  const response = await session(authenticated('/.netlify/functions/session'));
  assert.equal(response.status, 200);
  assertPrivate(assert, response);
  assert.equal((await response.json()).authenticated, true);
});

test('simultaneous shared-password logins issue independent browser cookies and cache scopes', async () => {
  const now = originalNow();
  Date.now = () => now;
  const responses = await Promise.all([logIn(), logIn()]);
  for (const response of responses) assert.equal(response.status, 200);
  const browserCookies = responses.map(sessionCookie);
  const sessions = await Promise.all(responses.map((response) => response.json()));
  assert.notEqual(browserCookies[0], browserCookies[1]);
  assert.notEqual(sessions[0].cacheScope, sessions[1].cacheScope);
  assert.equal(sessions[0].expiresAt, sessions[1].expiresAt);

  for (const [index, browserCookie] of browserCookies.entries()) {
    const response = await session(withCookie(browserCookie, '/.netlify/functions/session'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), sessions[index]);
  }
});

test('logging out one browser leaves another browser session, listing, and playback usable', async () => {
  const responses = await Promise.all([logIn(), logIn()]);
  for (const response of responses) assert.equal(response.status, 200);
  const [browserA, browserB] = responses.map(sessionCookie);
  const endpoints = [
    [session, '/.netlify/functions/session'],
    [list, '/.netlify/functions/list'],
    [stream, `/.netlify/functions/stream/${fileId}?v=file-version`],
  ];
  for (const browserCookie of [browserA, browserB]) {
    const active = await Promise.all(
      endpoints.map(([handler, path]) => handler(withCookie(browserCookie, path)))
    );
    for (const response of active) assert.equal(response.status, 200);
  }

  const signedOut = await logout(
    withCookie(browserA, '/.netlify/functions/logout', { method: 'POST' })
  );
  assert.equal(signedOut.status, 204);
  assert.match(signedOut.headers.get('Set-Cookie'), /;\s*Max-Age=0(?:;|$)/i);

  // The browser applies this expiry by deleting only its own session cookie.
  for (const [handler, path] of endpoints) {
    const unauthenticated = await handler(request(path));
    assert.equal(unauthenticated.status, 401);
    const stillActive = await handler(withCookie(browserB, path));
    assert.equal(stillActive.status, 200);
    assertPrivate(assert, stillActive);
  }
});

test('incorrect password cannot create a session', async () => {
  const response = await logIn({ body: JSON.stringify({ password: 'incorrect' }) });
  assert.equal(response.status, 401);
  assertPrivate(assert, response);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('cross-origin and Origin-less login requests are rejected before password checks', async () => {
  for (const origin of ['https://attacker.example', null]) {
    const response = await logIn({ origin });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
});

test('login accepts only JSON and enforces its body size limit', async () => {
  const plain = await logIn({ headers: { 'Content-Type': 'text/plain' } });
  assert.ok([400, 415].includes(plain.status));
  const oversized = await logIn({ body: JSON.stringify({ password: 'x'.repeat(100_000) }) });
  assert.ok([400, 413].includes(oversized.status));
});

test('missing authentication is rejected before listing or reading Google Drive', async () => {
  for (const handlerAndPath of [
    [session, '/.netlify/functions/session'],
    [list, '/.netlify/functions/list'],
    [stream, `/.netlify/functions/stream/${fileId}?v=known-version`],
  ]) {
    const [handler, path] = handlerAndPath;
    const response = await handler(request(path));
    assert.equal(response.status, 401);
    assertPrivate(assert, response);
  }
  assert.equal(driveCalls, 0);
  assert.equal(mediaCalls, 0);
});

test('tampered, duplicate, and expired session cookies cannot reach Drive', async () => {
  const [name, value] = cookie.split('=');
  const tampered = `${name}=${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  for (const invalidCookie of [tampered, `${cookie}; ${cookie}`]) {
    const response = await list(
      request('/.netlify/functions/list', { headers: { Cookie: invalidCookie } })
    );
    assert.equal(response.status, 401);
  }
  Date.now = () => originalNow() + 31 * 24 * 60 * 60 * 1000;
  const expired = await stream(authenticated(`/.netlify/functions/stream/${fileId}`));
  assert.equal(expired.status, 401);
  assert.equal(driveCalls, 0);
  assert.equal(mediaCalls, 0);
});

test('changing the shared password invalidates every browser session before Drive is queried', async () => {
  const responses = await Promise.all([logIn(), logIn()]);
  for (const response of responses) assert.equal(response.status, 200);
  const browserCookies = responses.map(sessionCookie);
  const nextPassword = 'changed-security-regression-test-passphrase';
  const differentSalt = Buffer.from('new-test-salt!!!');
  const differentHash = scryptSync(nextPassword, differentSalt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  process.env.APP_PASSWORD_HASH = `scrypt:${differentSalt.toString('base64url')}:${differentHash.toString('base64url')}`;
  for (const browserCookie of browserCookies) {
    for (const [handler, path] of [
      [session, '/.netlify/functions/session'],
      [list, '/.netlify/functions/list'],
      [stream, `/.netlify/functions/stream/${fileId}`],
    ]) {
      const response = await handler(withCookie(browserCookie, path));
      assert.equal(response.status, 401);
      assertPrivate(assert, response);
    }
  }
  assert.equal(driveCalls, 0);
  assert.equal(mediaCalls, 0);
  assert.equal((await logIn()).status, 401);
  const nextLogin = await logIn({ body: JSON.stringify({ password: nextPassword }) });
  assert.equal(nextLogin.status, 200);
  const nextSession = await session(
    withCookie(sessionCookie(nextLogin), '/.netlify/functions/session')
  );
  assert.equal(nextSession.status, 200);
});

test('rotating the signing secret invalidates every browser session and permits fresh logins', async () => {
  const responses = await Promise.all([logIn(), logIn()]);
  for (const response of responses) assert.equal(response.status, 200);
  const browserCookies = responses.map(sessionCookie);
  process.env.SESSION_SECRET = 'a-rotated-test-signing-secret-with-over-32-bytes';

  for (const browserCookie of browserCookies) {
    for (const [handler, path] of [
      [session, '/.netlify/functions/session'],
      [list, '/.netlify/functions/list'],
      [stream, `/.netlify/functions/stream/${fileId}`],
    ]) {
      const response = await handler(withCookie(browserCookie, path));
      assert.equal(response.status, 401);
      assertPrivate(assert, response);
    }
  }
  assert.equal(driveCalls, 0);
  assert.equal(mediaCalls, 0);
  const nextLogin = await logIn();
  assert.equal(nextLogin.status, 200);
  const nextSession = await session(
    withCookie(sessionCookie(nextLogin), '/.netlify/functions/session')
  );
  assert.equal(nextSession.status, 200);
});

test('missing or weak server configuration fails closed', async () => {
  for (const [key, value] of [
    ['APP_PASSWORD_HASH', ''],
    ['APP_PASSWORD_HASH', 'malformed'],
    ['SESSION_SECRET', 'short'],
  ]) {
    const previous = process.env[key];
    process.env[key] = value;
    const response = await list(authenticated('/.netlify/functions/list'));
    assert.ok(response.status >= 500);
    assertPrivate(assert, response);
    assert.equal(driveCalls, 0);
    process.env[key] = previous;
  }
});

test('cross-site authenticated requests are refused while audio requests without Origin work', async () => {
  const crossSite = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}`, { origin: 'https://attacker.example' })
  );
  assert.equal(crossSite.status, 403);
  assert.equal(driveCalls, 0);
  const audio = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}`, { origin: null })
  );
  assert.equal(audio.status, 200);
});

test('Fetch Metadata prevents cross-site requests even when no Origin header is sent', async () => {
  const response = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}`, {
      origin: null,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })
  );
  assert.equal(response.status, 403);
  assert.equal(driveCalls, 0);
});

test('HTTP login is limited to loopback development hosts', async () => {
  for (const host of ['localhost:8888', '127.0.0.1:8888', '[::1]:8888']) {
    const localOrigin = `http://${host}`;
    const response = await login(
      new Request(`${localOrigin}/api/login`, {
        method: 'POST',
        headers: { Origin: localOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
    );
    assert.equal(response.status, 200);
    const localCookie = response.headers.get('Set-Cookie');
    assert.match(localCookie, /^drive_session=/);
    assert.match(localCookie, /;\s*HttpOnly(?:;|$)/i);
    assert.doesNotMatch(localCookie, /;\s*Secure(?:;|$)/i);
  }
  const insecure = await login(
    new Request('http://player.example/api/login', {
      method: 'POST',
      headers: { Origin: 'http://player.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
  );
  assert.ok(insecure.status >= 400);
  assert.equal(insecure.headers.get('Set-Cookie'), null);
});

test('changing the allowed folder invalidates an existing session before Drive is queried', async () => {
  process.env.FOLDER_ID = 'different_allowed_folder_1234567890';
  const response = await list(authenticated('/.netlify/functions/list'));
  assert.equal(response.status, 401);
  assert.equal(driveCalls, 0);
});

test('missing or malformed folder configuration cannot be interpolated into a Drive query', async () => {
  for (const invalidId of ['', "folder' or trashed=true", 'folder/id']) {
    process.env.FOLDER_ID = invalidId;
    const newLogin = await logIn();
    assert.equal(newLogin.status, 200);
    const response = await list(
      request('/.netlify/functions/list', { headers: { Cookie: sessionCookie(newLogin) } })
    );
    assert.ok(response.status >= 500);
    assert.equal(driveCalls, 0);
  }
});

test('authenticated list requests filter by the configured folder and audio MIME', async () => {
  const response = await list(authenticated('/.netlify/functions/list'));
  assert.equal(response.status, 200);
  assertPrivate(assert, response);
  assert.match(listArgs.q, new RegExp(`'${folderId}' in parents`));
  assert.match(listArgs.q, /trashed\s*=\s*false/);
  const result = await response.json();
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].mimeType, 'audio/mpeg');
  assert.equal(result.tracks[0].id, fileId);
  assert.equal(result.tracks[0].ver, 'file-version');
});

test('unsupported methods do not call Drive', async () => {
  for (const [handler, path] of [
    [list, '/.netlify/functions/list'],
    [stream, `/.netlify/functions/stream/${fileId}`],
  ]) {
    const response = await handler(authenticated(path, { method: 'POST' }));
    assert.equal(response.status, 405);
  }
  assert.equal(driveCalls, 0);
});

test('invalid file identifiers are rejected before accessing Drive', async () => {
  for (const id of ['invalid%27id', 'invalid%2Fid', 'invalid%3Fid']) {
    const response = await stream(authenticated(`/.netlify/functions/stream/${id}`));
    assert.equal(response.status, 400);
  }
  assert.equal(driveCalls, 0);
  assert.equal(mediaCalls, 0);
});

test('known identifiers outside the allowed folder cannot be streamed', async () => {
  metadata.parents = ['different_folder'];
  const response = await stream(authenticated(`/.netlify/functions/stream/${fileId}`));
  assert.ok([403, 404].includes(response.status));
  assertPrivate(assert, response);
  assert.equal(mediaCalls, 0);
  assert.equal(tokenCalls, 0);
});

test('an empty optional Base64 setting falls back to direct service-account JSON', async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 = '';
  const response = await list(authenticated('/.netlify/functions/list'));
  assert.equal(response.status, 200);
  assert.equal(driveCalls, 1);
});

test('trashed, non-audio, and parentless files cannot be streamed even with an .mp3 name', async () => {
  for (const changes of [
    { trashed: true },
    { trashed: undefined },
    { mimeType: 'application/pdf' },
    { parents: [] },
    { parents: undefined },
  ]) {
    metadata = {
      ...metadata,
      trashed: false,
      mimeType: 'audio/mpeg',
      parents: [folderId],
      ...changes,
    };
    const response = await stream(authenticated(`/.netlify/functions/stream/${fileId}`));
    assert.ok([403, 404].includes(response.status));
  }
  assert.equal(mediaCalls, 0);
  assert.equal(tokenCalls, 0);
});

test('versioned streams override public upstream cache headers', async () => {
  const response = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}?v=file-version`)
  );
  assert.equal(response.status, 200);
  assertPrivate(assert, response);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(await response.text(), '0123456789');
});

test('a valid byte range remains seekable and private', async () => {
  const response = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}`, { headers: { Range: 'bytes=1-4' } })
  );
  assert.equal(response.status, 206);
  assert.equal(requestedRange, 'bytes=1-4');
  assert.equal(response.headers.get('Content-Range'), 'bytes 1-4/10');
  assert.equal(await response.text(), '1234');
  assertPrivate(assert, response);
});

test('malformed or multiple byte ranges are rejected without a media fetch', async () => {
  for (const range of [
    'bytes=0-1,4-5',
    'items=0-1',
    'bytes=5-1',
    'bytes=-',
    'bytes=-0',
    'bytes=0-9007199254740992',
  ]) {
    const response = await stream(
      authenticated(`/.netlify/functions/stream/${fileId}`, { headers: { Range: range } })
    );
    assert.ok([400, 416].includes(response.status));
  }
  assert.equal(mediaCalls, 0);
});

test('HEAD authenticates and checks metadata, then returns headers without an audio body', async () => {
  const response = await stream(
    authenticated(`/.netlify/functions/stream/${fileId}`, { method: 'HEAD' })
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '');
  assertPrivate(assert, response);
  assert.equal(driveCalls, 1);
  assert.equal(mediaCalls, 1);
});

test('Drive and upstream error details are not exposed to the caller', async () => {
  setDriveMock(() => {
    throw new Error('secret-private-key-test-value');
  });
  const listing = await list(authenticated('/.netlify/functions/list'));
  assert.ok(listing.status >= 500);
  assert.doesNotMatch(await listing.text(), /secret-private-key-test-value/);
  setDriveMock(() => ({
    files: {
      async get() {
        return { data: metadata };
      },
    },
    context: {
      _options: {
        auth: {
          async getAccessToken() {
            return { token: 'mock-access-token' };
          },
        },
      },
    },
  }));
  globalThis.fetch = async () => new Response('private-upstream-error-details', { status: 403 });
  const streamed = await stream(authenticated(`/.netlify/functions/stream/${fileId}`));
  assert.ok(streamed.status >= 400);
  assertPrivate(assert, streamed);
  assert.doesNotMatch(await streamed.text(), /private-upstream-error-details/);
});

test('logout requires same-origin POST and expires the HttpOnly cookie', async () => {
  const hostile = await logout(
    authenticated('/.netlify/functions/logout', {
      method: 'POST',
      origin: 'https://attacker.example',
    })
  );
  assert.equal(hostile.status, 403);
  const response = await logout(authenticated('/.netlify/functions/logout', { method: 'POST' }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.match(response.headers.get('Set-Cookie'), /;\s*Max-Age=0(?:;|$)/i);
  assertPrivate(assert, response);
});
