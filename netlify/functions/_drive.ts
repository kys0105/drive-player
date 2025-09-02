import { google } from 'googleapis';

export function getDrive() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT!;
  const sa = JSON.parse(raw);

  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  return google.drive({ version: 'v3', auth });
}
