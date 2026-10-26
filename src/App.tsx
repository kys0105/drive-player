import { useCallback, useEffect, useRef, useState } from 'react';
import PlayerScreen from './components/PlayerScreen';
import LoginPage from './pages/LoginPage';
import {
  Alert,
  Button,
  Container,
  CssBaseline,
  Stack,
  ThemeProvider,
  createTheme,
} from '@mui/material';
import { clearPrivateAudioCache } from './utils/cache';
import { getSession } from './utils/session';
import type { AuthSession } from './utils/session';

const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#242424', paper: '#3a3a3a' },
    primary: { main: '#8fa2ff' },
  },
});

type AuthState =
  | { status: 'checking' | 'loggingOut' }
  | { status: 'anonymous'; message?: string }
  | { status: 'authenticated'; session: AuthSession }
  | { status: 'error'; message: string; retry: 'session' | 'logout' };

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [retryCount, setRetryCount] = useState(0);
  const clearedScopesRef = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    void getSession(controller.signal)
      .then(async (session) => {
        if (controller.signal.aborted) return;
        if (!session) await clearPrivateAudioCache().catch(console.warn);
        if (!controller.signal.aborted) {
          setAuth(session ? { status: 'authenticated', session } : { status: 'anonymous' });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setAuth({
            status: 'error',
            message: 'ログイン状態を確認できません。通信状態を確認して再試行してください。',
            retry: 'session',
          });
        }
      });
    return () => controller.abort();
  }, [retryCount]);

  const cacheScope = auth.status === 'authenticated' ? auth.session.cacheScope : undefined;
  const expiresAt = auth.status === 'authenticated' ? auth.session.expiresAt : undefined;

  const handleSessionExpired = useCallback(() => {
    if (!cacheScope || clearedScopesRef.current.has(cacheScope)) return;
    clearedScopesRef.current.add(cacheScope);
    setAuth((previous) =>
      previous.status === 'authenticated' && previous.session.cacheScope === cacheScope
        ? { status: 'checking' }
        : previous
    );
    void clearPrivateAudioCache(cacheScope)
      .catch(console.warn)
      .then(() => {
        setAuth((previous) =>
          previous.status === 'checking'
            ? {
                status: 'anonymous',
                message: 'ログインの有効期限が切れました。再度ログインしてください。',
              }
            : previous
        );
      });
  }, [cacheScope]);

  useEffect(() => {
    if (!expiresAt) return;
    let timeout: number;
    const checkExpiry = () => {
      const remaining = expiresAt * 1000 - Date.now();
      if (remaining <= 0) handleSessionExpired();
      else timeout = window.setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    };
    checkExpiry();
    return () => clearTimeout(timeout);
  }, [expiresAt, handleSessionExpired]);

  useEffect(() => {
    if (!cacheScope) return;
    let controller: AbortController | undefined;
    const checkOnReturn = () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      void getSession(request.signal)
        .then((session) => {
          if (!request.signal.aborted && (!session || session.cacheScope !== cacheScope)) {
            handleSessionExpired();
          }
        })
        .catch((error) => {
          if (!request.signal.aborted) console.warn('Session recheck failed:', error);
        });
    };
    window.addEventListener('focus', checkOnReturn);
    document.addEventListener('visibilitychange', checkOnReturn);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', checkOnReturn);
      document.removeEventListener('visibilitychange', checkOnReturn);
    };
  }, [cacheScope, handleSessionExpired]);

  const handleLogout = async () => {
    if (cacheScope) clearedScopesRef.current.add(cacheScope);
    setAuth({ status: 'loggingOut' });
    const clearing = clearPrivateAudioCache(cacheScope).catch(console.warn);
    try {
      const response = await fetch('/.netlify/functions/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Logout failed');
      await clearing;
      setAuth({ status: 'anonymous' });
    } catch {
      await clearing;
      setAuth({
        status: 'error',
        message: 'ログアウトを完了できませんでした。通信状態を確認して再試行してください。',
        retry: 'logout',
      });
    }
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {auth.status === 'authenticated' ? (
        <PlayerScreen
          cacheScope={auth.session.cacheScope}
          onSessionExpired={handleSessionExpired}
          onLogout={handleLogout}
        />
      ) : auth.status === 'anonymous' ? (
        <LoginPage
          onLoggedIn={(session) => setAuth({ status: 'authenticated', session })}
          message={auth.message}
        />
      ) : (
        <Container maxWidth="xs" sx={{ py: 6 }}>
          <Stack spacing={2} role="status">
            {auth.status === 'error' ? (
              <>
                <Alert severity="error">{auth.message}</Alert>
                <Button
                  variant="contained"
                  onClick={() => {
                    if (auth.retry === 'logout') void handleLogout();
                    else {
                      setAuth({ status: 'checking' });
                      setRetryCount((value) => value + 1);
                    }
                  }}
                >
                  再試行
                </Button>
              </>
            ) : auth.status === 'loggingOut' ? (
              'ログアウト中…'
            ) : (
              'ログイン状態を確認中…'
            )}
          </Stack>
        </Container>
      )}
    </ThemeProvider>
  );
}
