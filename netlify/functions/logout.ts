import { expiredSessionCookie } from './_auth.ts';
import { methodNotAllowed, privateResponse, rejectCrossOrigin } from './_http.ts';

export default async function logout(req: Request): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed('POST');
  const rejected = rejectCrossOrigin(req, true);
  return rejected ?? privateResponse(null, 204, { 'Set-Cookie': expiredSessionCookie(req) });
}
