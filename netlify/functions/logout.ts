import { expiredSessionCookie } from './_auth.js';
import { methodNotAllowed, privateResponse, rejectCrossOrigin } from './_http.js';

export default async function logout(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const rejected = rejectCrossOrigin(req, true);
  return rejected ?? privateResponse(null, 204, { 'Set-Cookie': expiredSessionCookie(req) });
}
