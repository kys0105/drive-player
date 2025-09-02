// netlify/functions/_drive.ts
import { google } from 'googleapis';

type ServiceAccountJSON = {
  client_email: string;
  private_key: string;
};

export function getDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64 ?? process.env.GOOGLE_SERVICE_ACCOUNT ?? '';

  if (!raw) throw new Error('missing GOOGLE_SERVICE_ACCOUNT(_BASE64)');

  const jsonText = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');

  let sa: ServiceAccountJSON;
  try {
    sa = JSON.parse(jsonText) as ServiceAccountJSON;
  } catch {
    throw new Error('Service account JSON parse failed. Check Base64 and .env.');
  }

  // \n を実際の改行へ
  if (typeof sa.private_key === 'string') {
    sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}
