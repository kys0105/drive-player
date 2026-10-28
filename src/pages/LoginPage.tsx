import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { readSession } from '../utils/session';
import type { AuthSession } from '../utils/session';

export default function LoginPage({ onLoggedIn, message }: { onLoggedIn: (session: AuthSession) => void; message?: string }) {
  const [password, setPassword] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function login(event: FormEvent) {
    event.preventDefault(); if (pending) return; const controller = new AbortController(); request.current = controller; setPending(true); setError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.status === 401) setError('パスワードが正しくありません。');
      else if (response.status === 429) setError('ログインの試行回数が多すぎます。1分ほど待ってからお試しください。');
      else if (response.status === 503) setError('ログインを利用できません。管理者に設定を確認してください。');
      else if (!response.ok) setError('ログインできませんでした。しばらく待ってからお試しください。');
      else { const session = await readSession(response, controller.signal); if (!controller.signal.aborted) { setPassword(''); onLoggedIn(session); } }
    } catch { if (!controller.signal.aborted) setError('サーバーに接続できません。通信状態を確認してください。'); }
    finally { if (!controller.signal.aborted) setPending(false); }
  }
  return <main className="login-screen"><div className="login-card"><div className="login-mark"><Icon name="music" fill size={42} /></div><p className="login-brand">SetagayaGenico</p><h1>あなたの音楽を、<br />いつもそばに。</h1><p className="login-caption">共有されたパスワードでログインしてください。</p>{message && <p className="login-message" role="status">{message}</p>}{error && <p className="login-error" role="alert">{error}</p>}<form onSubmit={login} aria-busy={pending}><label htmlFor="password">パスワード</label><input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required disabled={pending} /><button type="submit" disabled={pending || !password}>{pending ? 'ログイン中…' : 'ログイン'}</button></form><p className="login-footnote">保存した曲は、有効期限内なら圏外でも再生できます。</p></div></main>;
}
