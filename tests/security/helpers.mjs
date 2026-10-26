import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const driveMockKey = Symbol.for('drive-player.security.mockDrive');

/** Bundle the production entry point, replacing only the external Drive client. */
export async function loadFunction(name) {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: [`netlify/functions/${name}.ts`],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [
      {
        name: 'mock-google-drive',
        setup(buildContext) {
          buildContext.onResolve({ filter: /^googleapis$/ }, () => ({
            path: 'drive-mock',
            namespace: 'security-test',
          }));
          buildContext.onLoad({ filter: /.*/, namespace: 'security-test' }, () => ({
            contents:
              "export const google = { auth: { JWT: class {} }, drive() { return globalThis[Symbol.for('drive-player.security.mockDrive')](); } };",
            loader: 'js',
          }));
        },
      },
    ],
  });
  const encoded = Buffer.from(
    `${result.outputFiles[0].text}\n//# sourceURL=security-bundle-${name}.mjs`
  ).toString('base64');
  const module = await import(`data:text/javascript;base64,${encoded}`);
  return module.default;
}

export function setDriveMock(factory) {
  globalThis[driveMockKey] = factory;
}

export function clearDriveMock() {
  delete globalThis[driveMockKey];
}

export function request(path, { origin = 'https://player.example', ...init } = {}) {
  const headers = new Headers(init.headers);
  if (origin !== null) headers.set('Origin', origin);
  return new Request(`https://player.example${path}`, { ...init, headers });
}

export function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  if (!header) throw new Error('The login response did not set a session cookie');
  return header.split(';')[0];
}

export function assertPrivate(assert, response) {
  const control = response.headers.get('cache-control') || '';
  assert.match(control, /(?:^|,)\s*private(?:,|$)/);
  assert.match(control, /(?:^|,)\s*no-store(?:,|$)/);
  assert.doesNotMatch(control, /(?:^|,)\s*public(?:,|$)/);
}
