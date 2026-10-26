export type AuthSession = {
  authenticated: true;
  expiresAt: number;
  cacheScope: string;
};

export async function readSession(response: Response): Promise<AuthSession> {
  const value: unknown = await response.json();
  if (
    typeof value !== 'object' ||
    value === null ||
    !('authenticated' in value) ||
    value.authenticated !== true ||
    !('expiresAt' in value) ||
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt) ||
    value.expiresAt * 1000 <= Date.now() ||
    !('cacheScope' in value) ||
    typeof value.cacheScope !== 'string' ||
    !value.cacheScope
  ) {
    throw new Error('Invalid session response');
  }
  return { authenticated: true, expiresAt: value.expiresAt, cacheScope: value.cacheScope };
}

export async function getSession(signal?: AbortSignal): Promise<AuthSession | null> {
  const response = await fetch('/.netlify/functions/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Session check failed');
  return readSession(response);
}
