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

// Cache the build's actual same-origin resources, rather than development source URLs.
if ('serviceWorker' in navigator) {
  const cacheShell = () => {
    const urls = new Set<string>([
      ...Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'), element => element.src),
      ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]'), element => element.href),
      ...performance.getEntriesByType('resource').map(entry => entry.name),
    ]);
    navigator.serviceWorker.controller?.postMessage({ type: 'CACHE_SHELL', urls: [...urls] });
  };
  navigator.serviceWorker.addEventListener('controllerchange', cacheShell);
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then(async (reg) => {
        await navigator.serviceWorker.ready;
        cacheShell();
        void reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn('[SW] register failed:', err);
      });
  });
}

// Persistent storage is requested only after a user explicitly saves a track.
