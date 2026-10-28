import { requireSession, sessionDetails } from './_auth.js';
import { jsonResponse, methodNotAllowed } from './_http.js';

export default async function session(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(req);
  return auth instanceof Response ? auth : jsonResponse(sessionDetails(auth));
}
