import { requireSession } from './_auth.js';
import { DriveLibrary, libraryError } from './_library.js';
import { jsonResponse, methodNotAllowed } from './_http.js';

export default async function albums(request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(request);
  if (auth instanceof Response) return auth;
  try { return jsonResponse(await new DriveLibrary().albums()); } catch (error) { return libraryError(error); }
}
