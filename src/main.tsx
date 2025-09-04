// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);

// ---- Service Worker 登録（public/sw.js が前提）----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('[SW] registered:', reg.scope);
      })
      .catch((err) => {
        console.warn('[SW] register failed:', err);
      });
  });
}

// （任意）キャッシュの永続化をお願いしてみる。iOS/Safari でも効くことがある
if (navigator.storage?.persist) {
  navigator.storage.persist().then((granted) => {
    console.log('[Storage] persist granted:', granted);
  });
}
