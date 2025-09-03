import { useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  Container,
  Stack,
  TextField,
  Typography,
  Alert,
} from '@mui/material';

const FIXED_ID = 'demo@example.com';
const FIXED_PASSWORD = 'passw0rd';

export default function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (id === FIXED_ID && pw === FIXED_PASSWORD) {
      localStorage.setItem('loggedIn', '1');
      onLoggedIn();
    } else {
      setError('IDまたはパスワードが正しくありません。');
    }
  };

  return (
    <Container maxWidth="xs" sx={{ py: 8 }}>
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>
            ログイン
          </Typography>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Box component="form" onSubmit={handleLogin}>
            <Stack spacing={2}>
              <TextField
                label="ID"
                value={id}
                onChange={(e) => setId(e.target.value)}
                autoComplete="username"
                required
                fullWidth
              />
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

              <Typography variant="body2" color="text.secondary">
                （テスト用）ID: {FIXED_ID} / PW: {FIXED_PASSWORD}
              </Typography>
            </Stack>
          </Box>
        </CardContent>
      </Card>
    </Container>
  );
}
