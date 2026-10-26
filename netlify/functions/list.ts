import { requireSession } from './_auth.ts';
import { getDrive, getFolderId } from './_drive.ts';
import { jsonResponse, methodNotAllowed, privateResponse } from './_http.ts';

function formatTitle(name: string): string {
  const underscoreIndex = name.indexOf('_');
  if (underscoreIndex >= 0) return name.slice(0, underscoreIndex);
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 ? name.slice(0, dotIndex) : name;
}

export default async function list(req: Request): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed('GET');
  const auth = requireSession(req);
  if (auth instanceof Response) return auth;
  const folderId = getFolderId();
  if (!folderId) return privateResponse('Service unavailable', 503);

  try {
    const drive = getDrive();
    const tracks = [];
    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false and mimeType='audio/mpeg'`,
        fields: 'files(id,name,mimeType,thumbnailLink,modifiedTime,md5Checksum,size),nextPageToken',
        orderBy: 'name_natural',
        pageSize: 1000,
        pageToken,
      });
      for (const file of res.data.files ?? []) {
        if (!file.id || file.mimeType !== 'audio/mpeg') continue;
        tracks.push({
          id: file.id,
          title: formatTitle(file.name ?? 'audio'),
          mimeType: 'audio/mpeg',
          artwork: file.thumbnailLink ?? undefined,
          artist: '',
          size: file.size ? Number(file.size) : undefined,
          modifiedTime: file.modifiedTime ?? undefined,
          ver: file.md5Checksum ?? file.modifiedTime ?? '',
        });
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return jsonResponse({ tracks });
  } catch {
    return privateResponse('Unable to load tracks', 502);
  }
}
