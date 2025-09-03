import { useState } from 'react';
import { Box, Button, Card, CardContent, Container, Stack, TextField, Alert } from '@mui/material';

const FIXED_PASSWORD = 'Subkayo03';

export default function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (pw === FIXED_PASSWORD) {
      localStorage.setItem('loggedIn', '1');
      onLoggedIn();
    } else {
      setError('パスワードが正しくありません。');
    }
  };

  return (
    <Container
      maxWidth="xs"
      sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}
    >
      <Card>
        <CardContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Box component="form" onSubmit={handleLogin}>
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
                required
                fullWidth
              />

              <Button type="submit" variant="contained" fullWidth>
                ログイン
              </Button>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
}
