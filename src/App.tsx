import { useEffect, useState } from 'react';
import PlayerScreen from './components/PlayerScreen';
import LoginPage from './pages/LoginPage';
import { CssBaseline } from '@mui/material';

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    setLoggedIn(localStorage.getItem('loggedIn') === '1');
  }, []);

  return (
    <>
      <CssBaseline />
      {loggedIn ? (
        <>
          <PlayerScreen />
        </>
      ) : (
        <LoginPage onLoggedIn={() => setLoggedIn(true)} />
      )}
    </>
  );
}
