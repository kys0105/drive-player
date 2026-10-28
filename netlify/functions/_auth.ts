import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { privateResponse, rejectCrossOrigin } from './_http.ts';

export const SESSION_SECONDS = 30 * 24 * 60 * 60;

type AuthConfig = { passwordHash: string; salt: Buffer; hash: Buffer; secret: string };
export type Session = { authenticated: true; expiresAt: number; cacheScope: string };

/** An offline lease is renewed by a successful server check, not by playback. */
export function sessionDetails(session: Session) {
  const serverTime = Math.floor(Date.now() / 1000);
  return { ...session, serverTime, offlineUntil: serverTime + SESSION_SECONDS };
}

function configuration(): AuthConfig | null {
  const passwordHash = process.env.APP_PASSWORD_HASH ?? '';
  const secret = process.env.SESSION_SECRET ?? '';
  const match = /^scrypt:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/.exec(passwordHash);
  if (!match || Buffer.byteLength(secret) < 32) return null;
  const salt = Buffer.from(match[1], 'base64url');
  const hash = Buffer.from(match[2], 'base64url');
  if (salt.toString('base64url') !== match[1] || hash.toString('base64url') !== match[2]) {
    return null;
  }
  return { passwordHash, salt, hash, secret };
}

function localHttp(req: Request): boolean {
  const url = new URL(req.url);
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function cookieName(req: Request): string {
  return localHttp(req) ? 'drive_session' : '__Host-drive_session';
}

function signature(body: string, config: AuthConfig): Buffer {
  return createHmac('sha256', config.secret)
    .update(
      `drive-player-session-v1\0${config.passwordHash}\0${process.env.FOLDER_ID ?? ''}\0${body}`
    )
    .digest();
}

function transportAllowed(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || localHttp(req);
}

export async function passwordMatches(password: string): Promise<boolean> {
  const config = configuration();
  if (!config || Buffer.byteLength(password) > 1024) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      config.salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
  return timingSafeEqual(actual, config.hash);
}

export function authUnavailable(req: Request): Response | null {
  if (!configuration() || !transportAllowed(req)) {
    return privateResponse('Authentication is not configured', 503);
  }
  return null;
}

export function requireSession(req: Request): Session | Response {
  const rejected = rejectCrossOrigin(req) ?? authUnavailable(req);
  if (rejected) return rejected;
  const config = configuration()!;
  const cookies = (req.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${cookieName(req)}=`));
  if (cookies.length !== 1) return privateResponse('Authentication required', 401);
  const token = cookies[0].slice(cookieName(req).length + 1);
  if (token.length > 2048) return privateResponse('Authentication required', 401);
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return privateResponse('Authentication required', 401);
  const provided = Buffer.from(match[2], 'base64url');
  const expected = signature(match[1], config);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return privateResponse('Authentication required', 401);
  }
  try {
    const payload = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > now ||
      payload.exp <= now ||
      payload.exp - payload.iat !== SESSION_SECONDS ||
      typeof payload.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/.test(payload.nonce)
    ) {
      return privateResponse('Authentication required', 401);
    }
    return { authenticated: true, expiresAt: payload.exp, cacheScope: payload.nonce };
  } catch {
    return privateResponse('Authentication required', 401);
  }
}

export function issueSession(req: Request): { session: Session; cookie: string } {
  const config = configuration();
  if (!config || !transportAllowed(req)) throw new Error('Authentication unavailable');
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_SECONDS;
  const nonce = randomBytes(16).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iat, exp, nonce })).toString('base64url');
  const token = `${body}.${signature(body, config).toString('base64url')}`;
  const secure = localHttp(req) ? '' : '; Secure';
  return {
    session: { authenticated: true, expiresAt: exp, cacheScope: nonce },
    cookie: `${cookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`,
  };
}

export function expiredSessionCookie(req: Request): string {
  const secure = localHttp(req) ? '' : '; Secure';
  return `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure}`;
}
