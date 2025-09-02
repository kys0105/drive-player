import type { Handler } from '@netlify/functions';
import { getDrive } from './_drive';

export const handler: Handler = async (event) => {
  const folderId = event.queryStringParameters?.folderId || process.env.FOLDER_ID;
  if (!folderId) return { statusCode: 400, body: 'folderId required' };

  const drive = getDrive();
  const q = [
    `'${folderId}' in parents`,
    "(mimeType='audio/mpeg' or mimeType='audio/mp4' or mimeType='audio/x-m4a')",
    'trashed=false',
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    orderBy: 'name_natural',
    pageSize: 200,
  });

  const tracks = (res.data.files ?? []).map((f) => ({
    id: f.id,
    title: f.name,
    mimeType: f.mimeType,
    size: f.size,
    modifiedTime: f.modifiedTime,
  }));

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tracks }),
  };
};
