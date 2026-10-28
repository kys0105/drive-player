import type { Config } from '@netlify/functions';
import { authUnavailable, issueSession, passwordMatches, sessionDetails } from './_auth.js';
import { jsonResponse, methodNotAllowed, privateResponse, rejectCrossOrigin } from './_http.js';

async function readPassword(req: Request): Promise<string | null> {
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || !req.body) {
    return null;
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    );
    return typeof data?.password === 'string' && Buffer.byteLength(data.password) <= 1024
      ? data.password
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export default async function login(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const rejected = rejectCrossOrigin(req, true) ?? authUnavailable(req);
  if (rejected) return rejected;
  const password = await readPassword(req);
  if (password === null) return privateResponse('Invalid login request', 400);
  try {
    if (!(await passwordMatches(password))) return privateResponse('Invalid password', 401);
    const { session, cookie } = issueSession(req);
    return jsonResponse(sessionDetails(session), 200, { 'Set-Cookie': cookie });
  } catch {
    return privateResponse('Unable to sign in', 503);
  }
}

export const config: Config = {
  path: '/api/login',
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip', 'domain'],
    windowSize: 60,
    windowLimit: 10,
  },
};
