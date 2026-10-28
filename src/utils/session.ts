export type AuthSession = {
  authenticated: true;
  expiresAt: number;
  cacheScope: string;
  /** Milliseconds, from a successful online validation; independent of Cookie expiry. */
  verifiedAt?: number;
  offlineUntil?: number;
  offline?: boolean;
};

export const OFFLINE_SESSION_KEY = 'drive-player.offline-session.v3';
const CLOCK_KEY = 'drive-player.last-clock.v3';
const LOGGED_OUT_KEY = 'drive-player.logged-out.v3';
export const OFFLINE_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
let authGeneration = 0;
let memorySession: AuthSession | null = null;
let memoryClock = 0;
let memoryPersisted = true;
let storageAvailable = true;
let memoryLoggedOut = false;

function storageGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { storageAvailable = false; return null; }
}

export function isLocallyLoggedOut(): boolean {
  if (memoryLoggedOut) return true;
  const stored = storageGet(LOGGED_OUT_KEY);
  // A successful online login may be valid in memory while writes/removals are
  // blocked by private browsing or exhausted browser storage.
  return !(memorySession && (!memoryPersisted || !storageAvailable)) && stored === 'true';
}

export function clearLocalSession(): void {
  authGeneration++;
  memorySession = null;
  memoryLoggedOut = true;
  memoryClock = 0;
  try {
    localStorage.removeItem(OFFLINE_SESSION_KEY);
    localStorage.removeItem(CLOCK_KEY);
    localStorage.setItem(LOGGED_OUT_KEY, 'true');
  } catch { storageAvailable = false; }
}

/** An offline UX allowance, not protection against the owner of an unlocked device. */
export function loadOfflineSession(now = Date.now()): AuthSession | null {
  if (isLocallyLoggedOut()) return null;
  try {
    const raw = storageGet(OFFLINE_SESSION_KEY);
    const fallback = !memoryPersisted || !storageAvailable;
    const useMemory = Boolean(memorySession && fallback);
    const session: AuthSession | null = useMemory ? memorySession : raw ? JSON.parse(raw) : null;
    const storedClock = storageGet(CLOCK_KEY);
    const clock = useMemory ? memoryClock : Number(storedClock ?? 0);
    if (!session || session.authenticated !== true || typeof session.cacheScope !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(session.cacheScope) ||
        !Number.isFinite(session.expiresAt) || !Number.isFinite(session.verifiedAt) ||
        !Number.isFinite(session.offlineUntil) || !Number.isFinite(clock) || clock < 0 || !session.verifiedAt || !session.offlineUntil ||
        session.offlineUntil > session.verifiedAt + OFFLINE_MILLISECONDS ||
        session.offlineUntil <= now || now < session.verifiedAt - 1000 || now < clock - 1000) return null;
    memoryClock = Math.max(now, clock, memoryClock);
    try { localStorage.setItem(CLOCK_KEY, String(memoryClock)); } catch { storageAvailable = false; }
    return { ...session, offline: true };
  } catch { return null; }
}

export async function readSession(response: Response, signal?: AbortSignal, expectedGeneration = authGeneration): Promise<AuthSession> {
  const value: unknown = await response.json();
  if (signal?.aborted || expectedGeneration !== authGeneration) throw new DOMException('Aborted', 'AbortError');
  if (typeof value !== 'object' || value === null ||
      !('authenticated' in value) || value.authenticated !== true ||
      !('expiresAt' in value) || typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) || value.expiresAt * 1000 <= Date.now() ||
      !('cacheScope' in value) || typeof value.cacheScope !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(value.cacheScope)) throw new Error('Invalid session response');
  const now = Date.now();
  const serverTime = 'serverTime' in value && typeof value.serverTime === 'number' && Number.isFinite(value.serverTime)
    ? value.serverTime * 1000 : now;
  const serverDeadline = 'offlineUntil' in value && typeof value.offlineUntil === 'number' && Number.isFinite(value.offlineUntil)
    ? value.offlineUntil * 1000 : serverTime + OFFLINE_MILLISECONDS;
  const deadline = Math.min(serverDeadline, serverTime + OFFLINE_MILLISECONDS);
  if (deadline <= now || serverTime > now + 5 * 60 * 1000) throw new Error('端末の日時を確認してください。');
  const session: AuthSession = {
    authenticated: true, expiresAt: value.expiresAt, cacheScope: value.cacheScope,
    verifiedAt: serverTime, offlineUntil: deadline, offline: false,
  };
  memorySession = session;
  memoryClock = now;
  memoryLoggedOut = false;
  try {
    localStorage.setItem(OFFLINE_SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(CLOCK_KEY, String(now));
    localStorage.removeItem(LOGGED_OUT_KEY);
    memoryPersisted = true;
  } catch { memoryPersisted = false; storageAvailable = false; }
  // The worker validates the HttpOnly Cookie itself, never a posted client lease.
  navigator.serviceWorker?.controller?.postMessage({ type: 'SYNC_SESSION' });
  return session;
}

export async function getSession(signal?: AbortSignal): Promise<AuthSession | null> {
  const expectedGeneration = authGeneration;
  const response = await fetch('/api/session', { credentials: 'same-origin', cache: 'no-store', signal });
  if (signal?.aborted || expectedGeneration !== authGeneration) throw new DOMException('Aborted', 'AbortError');
  if (response.status === 401) { clearLocalSession(); return null; }
  if (!response.ok) throw new Error('Session check failed');
  return readSession(response, signal, expectedGeneration);
}
