import { useCallback, useEffect, useRef, useState } from 'react';
import PlayerScreen from './components/PlayerScreen';
import LoginPage from './pages/LoginPage';
import { clearPrivateAudioCache } from './utils/cache';
import { clearLocalSession, getSession, isLocallyLoggedOut, loadOfflineSession, mergeStoredSession, OFFLINE_SESSION_KEY } from './utils/session';
import type { AuthSession } from './utils/session';
import { clearStoredLyrics } from './lyrics';

type AuthState =
  | { status: 'checking' | 'loggingOut' }
  | { status: 'anonymous'; message?: string }
  | { status: 'authenticated'; session: AuthSession }
  | { status: 'error'; message: string };

function initialState(): AuthState {
  if (isLocallyLoggedOut()) return { status: 'anonymous' };
  const cached = loadOfflineSession();
  return cached ? { status: 'authenticated', session: cached } : { status: 'checking' };
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>(initialState);
  const authRef = useRef(auth);
  authRef.current = auth;
  const requestRef = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  const loggingOutRef = useRef(false);

  const invalidate = useCallback((message = 'ログインが無効になりました。もう一度ログインしてください。') => {
    epoch.current++;
    requestRef.current?.abort();
    setAuth({ status: 'anonymous', message });
    clearLocalSession();
    void Promise.allSettled([clearPrivateAudioCache(), clearStoredLyrics()]);
  }, []);

  const revalidate = useCallback(async () => {
    if (isLocallyLoggedOut()) return;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    const expected = epoch.current;
    const timeout = window.setTimeout(() => request.abort(), 8_000);
    try {
      const session = await getSession(request.signal);
      if (request.signal.aborted || expected !== epoch.current) return;
      if (!session) { invalidate(authRef.current.status === 'authenticated' ? undefined : ''); return; }
      setAuth({ status: 'authenticated', session });
    } catch {
      if (requestRef.current !== request || expected !== epoch.current || isLocallyLoggedOut()) return;
      const cached = loadOfflineSession();
      if (cached) setAuth({ status: 'authenticated', session: cached });
      else setAuth({ status: 'error', message: 'オンラインでログイン状態を確認してください。保存済み音源の利用許可は、最後の確認から30日間です。端末の日時も確認してください。' });
    } finally { clearTimeout(timeout); }
  }, [invalidate]);

  useEffect(() => {
    // An offline logout stays blocked until an explicit password login. A delayed
    // logout request here could otherwise clear a Cookie issued by a new login.
    if (!isLocallyLoggedOut()) void revalidate();
    const checkOnReturn = () => {
      if (document.visibilityState !== 'hidden') void revalidate();
    };
    const interval = window.setInterval(checkOnReturn, 60_000);
    window.addEventListener('online', checkOnReturn);
    window.addEventListener('focus', checkOnReturn);
    document.addEventListener('visibilitychange', checkOnReturn);
    return () => {
      requestRef.current?.abort(); clearInterval(interval);
      window.removeEventListener('online', checkOnReturn);
      window.removeEventListener('focus', checkOnReturn);
      document.removeEventListener('visibilitychange', checkOnReturn);
    };
  }, [revalidate]);

  useEffect(() => {
    const handleRevocation = () => {
      epoch.current++;
      requestRef.current?.abort();
      clearLocalSession();
      if (!loggingOutRef.current) setAuth(authRef.current.status === 'authenticated'
        ? { status: 'anonymous', message: 'この端末のログインを終了しました。' }
        : { status: 'anonymous' });
      void clearStoredLyrics();
    };
    const message = (event: MessageEvent) => { if (event.data?.type === 'AUTH_REVOKED') handleRevocation(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== OFFLINE_SESSION_KEY) return;
      const cached = loadOfflineSession();
      if (!cached) handleRevocation();
      else setAuth(previous => ({ status: 'authenticated', session: mergeStoredSession(previous.status === 'authenticated' ? previous.session : null, cached) }));
    };
    navigator.serviceWorker?.addEventListener('message', message);
    window.addEventListener('storage', storage);
    return () => { navigator.serviceWorker?.removeEventListener('message', message); window.removeEventListener('storage', storage); };
  }, []);

  const currentSession = auth.status === 'authenticated' ? auth.session : null;
  useEffect(() => {
    if (!currentSession?.offlineUntil) return;
    const deadline = currentSession.offlineUntil;
    let timer: number;
    const check = () => {
      if (!loadOfflineSession()) {
        setAuth({ status: 'error', message: '保存済み音源の利用期限が切れたか、端末の日時が変更されています。オンラインで確認してください。' });
        void revalidate();
      } else timer = window.setTimeout(check, Math.min(Math.max(0, deadline - Date.now()), 60_000));
    };
    timer = window.setTimeout(check, Math.min(Math.max(0, deadline - Date.now()), 60_000));
    return () => clearTimeout(timer);
  }, [currentSession, revalidate]);

  const handleLogout = useCallback(async () => {
    epoch.current++;
    requestRef.current?.abort();
    loggingOutRef.current = true;
    setAuth({ status: 'loggingOut' });
    const clearing = Promise.allSettled([clearPrivateAudioCache(), clearStoredLyrics()]);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5_000);
    let serverCleared = false;
    try {
      serverCleared = (await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal })).ok;
    } catch { /* Local revocation remains effective until the next explicit login. */ }
    finally { clearTimeout(timeout); }
    await clearing;
    loggingOutRef.current = false;
    setAuth({ status: 'anonymous', message: serverCleared ? 'ログアウトし、この端末に保存した音源と歌詞を削除しました。' : 'この端末からログアウトし、保存した音源と歌詞を削除しました。次にオンラインでログインしてください。' });
  }, []);

  if (auth.status === 'authenticated') return <PlayerScreen key={auth.session.cacheScope} session={auth.session} cacheScope={auth.session.cacheScope} onSessionExpired={invalidate} onLogout={() => { void handleLogout(); }} />;
  if (auth.status === 'anonymous') return <LoginPage message={auth.message} onLoggedIn={session => { epoch.current++; setAuth({ status: 'authenticated', session }); }} />;
  return <main className="auth-screen"><section className="auth-card" role="status">
    <h1>SetagayaGenico</h1>
    <p>{auth.status === 'error' ? auth.message : auth.status === 'checking' ? 'ログインを確認しています…' : 'ログアウトしています…'}</p>
    {auth.status === 'error' && <><button type="button" className="auth-primary" onClick={() => { setAuth({ status: 'checking' }); void revalidate(); }}>オンラインで確認</button><button type="button" onClick={() => setAuth({ status: 'anonymous' })}>ログイン画面へ</button></>}
  </section></main>;
}
