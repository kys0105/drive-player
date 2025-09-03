import { useEffect, useState } from 'react';
import PlayerScreen from './components/PlayerScreen';
import LoginPage from './pages/LoginPage';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(localStorage.getItem('loggedIn') === '1');
  }, []);

  const theme = createTheme({
    palette: {
      mode: 'dark',
      background: {
        default: '#242424',
        paper: '#3a3a3a',
      },
      primary: { main: '#8fa2ff' },
    },
  });

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {loggedIn ? (
        <PlayerScreen />
      ) : (
        <LoginPage onLoggedIn={() => setLoggedIn(true)} />
      )}
    </ThemeProvider>
  );
}
