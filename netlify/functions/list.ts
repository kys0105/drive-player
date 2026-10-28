import { requireSession } from './_auth.js';
import { DriveLibrary, LibraryError, libraryError } from './_library.js';
import { jsonResponse, methodNotAllowed } from './_http.js';

export default async function list(request: Request): Promise<Response> {
  if (request.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(request); if (auth instanceof Response) return auth;
  const ids = new URL(request.url).searchParams.getAll('albumId');
  if (ids.length > 1) return libraryError(new LibraryError(400, 'Invalid album ID'));
  try {
    const library = new DriveLibrary();
    const album = await library.chooseAlbum(ids[0]);
    return jsonResponse({ album, tracks: await library.tracks(album) });
  } catch (error) { return libraryError(error); }
}
