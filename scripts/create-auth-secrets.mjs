import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('パスワードを表示しないため、対話型ターミナルで実行してください。');
  }
  let existing = '';
  try {
    existing = await readFile('.env', 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (/^[\t ]*(?:APP_PASSWORD_HASH|SESSION_SECRET)[\t ]*=[\t ]*\S+/m.test(existing)) {
    throw new Error(
      '.env に認証設定があります。更新する場合は該当する2行を削除して再実行してください。'
    );
  }

  const silent = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const input = createInterface({ input: process.stdin, output: silent, terminal: true });
  let password;
  let confirmation;
  try {
    process.stdout.write('新しいパスワード（16文字以上、入力は非表示）: ');
    password = await input.question('');
    process.stdout.write('\n確認のためもう一度: ');
    confirmation = await input.question('');
    process.stdout.write('\n');
  } finally {
    input.close();
  }
  if (password.length < 16 || Buffer.byteLength(password) > 1024) {
    throw new Error('パスワードは16文字以上、UTF-8で1024バイト以下にしてください。');
  }
  const first = Buffer.from(password);
  const second = Buffer.from(confirmation);
  if (first.length !== second.length || !timingSafeEqual(first, second)) {
    throw new Error('パスワードが一致しません。');
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const values = [
    `APP_PASSWORD_HASH=scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`,
    `SESSION_SECRET=${randomBytes(32).toString('base64url')}`,
    '',
  ].join('\n');
  // Preserve Drive settings and replace only empty authentication placeholders.
  const cleaned = existing.replace(
    /^[\t ]*(?:APP_PASSWORD_HASH|SESSION_SECRET)[\t ]*=[\t ]*\r?$/gm,
    ''
  );
  if (cleaned !== existing) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile('.env', `${cleaned.trimEnd()}\n${values}`, { mode: 0o600 });
  } else {
    await appendFile('.env', `${existing.endsWith('\n') || !existing ? '' : '\n'}${values}`, {
      mode: 0o600,
    });
  }
  console.log('APP_PASSWORD_HASH と SESSION_SECRET を .env に保存しました（値は表示しません）。');
  console.log('Netlifyにも同名の環境変数を登録して、再デプロイしてください（設定方法はREADME参照）。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
