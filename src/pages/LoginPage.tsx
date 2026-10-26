import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Box, Button, Card, CardContent, Container, Stack, TextField, Alert } from '@mui/material';
import { readSession } from '../utils/session';
import type { AuthSession } from '../utils/session';

type Props = { onLoggedIn: (session: AuthSession) => void; message?: string };

export default function LoginPage({ onLoggedIn, message }: Props) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
        signal: controller.signal,
      });
      if (response.status === 401) {
        setError('パスワードが正しくありません。');
      } else if (response.status === 429) {
        setError('ログインの試行回数が多すぎます。しばらく待ってからお試しください。');
      } else if (response.status === 503) {
        setError('ログインを利用できません。管理者にサーバーの設定を確認してください。');
      } else if (!response.ok) {
        setError('ログインできませんでした。しばらく待ってからお試しください。');
      } else {
        const session = await readSession(response);
        if (!controller.signal.aborted) {
          setPw('');
          onLoggedIn(session);
        }
      }
    } catch {
      if (!controller.signal.aborted)
        setError('サーバーに接続できません。通信状態を確認してください。');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  };

  return (
    <Container
      maxWidth="xs"
      sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}
    >
      <Card>
        <CardContent>
          {message && (
            <Alert severity="info" sx={{ mb: 2 }}>
              {message}
            </Alert>
          )}
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Box component="form" onSubmit={handleLogin} aria-busy={pending}>
            <Stack spacing={2} alignItems="center">
              <Box sx={{ display: 'flex', justifyContent: 'center' }}>
                <img src="/animals.svg" alt="animals" style={{ maxWidth: '150px' }} />
              </Box>

              <TextField
                label="パスワード"
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="current-password"
                disabled={pending}
                required
                fullWidth
              />

              <Button type="submit" variant="contained" fullWidth disabled={pending}>
                {pending ? 'ログイン中…' : 'ログイン'}
              </Button>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
}
