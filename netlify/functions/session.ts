import { requireSession } from './_auth.ts';
import { jsonResponse, methodNotAllowed } from './_http.ts';

export default async function session(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(req);
  return auth instanceof Response ? auth : jsonResponse(auth);
}
