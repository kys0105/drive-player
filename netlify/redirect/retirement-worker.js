/* Retirement-only worker for the old Netlify origin. No application or API cache. */
const DESTINATION = 'https://drive-player-yumosin-house-studio.vercel.app/';

function privateCache(name) {
  return name === 'audio-v1' || name.startsWith('audio-private-') ||
    name.startsWith('drive-private-') || name.startsWith('drive-shell-');
}

async function removeLegacyCaches() {
  try {
    const names = (await caches.keys()).filter(privateCache);
    const results = await Promise.allSettled(names.map(name => caches.delete(name)));
    return results.every(result => result.status === 'fulfilled');
  } catch { return false; }
}

// Old supported workers serialize this message after pending private writes.
// Wait for their acknowledgement before taking over, with a bound for old versions.
async function stopPreviousWrites() {
  const previous = self.registration.active;
  if (!previous) return;
  await new Promise(resolve => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timeout); channel.port1.close(); resolve(); };
    const timeout = setTimeout(finish, 2_000);
    channel.port1.onmessage = finish;
    try { previous.postMessage({ type: 'CLEAR_PRIVATE_AUDIO' }, [channel.port2]); }
    catch { finish(); }
  });
}

self.addEventListener('install', event => {
  event.waitUntil((async () => { await stopPreviousWrites().catch(() => {}); await self.skipWaiting(); })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await self.clients.claim().catch(() => {});
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true }).catch(() => []);
    await removeLegacyCaches();
    await self.registration.unregister().catch(() => {});
    await Promise.allSettled(windows.map(async client => {
      if (new URL(client.url).origin !== self.location.origin) return;
      try { await client.navigate(DESTINATION); }
      catch {
        // Navigating within the old origin reaches the server's 302 on browsers
        // that cannot navigate a WindowClient directly to another origin.
        await client.navigate(new URL('/', self.location.origin).href).catch(() => {});
      }
    }));
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  event.respondWith(new Response(null, {
    status: 302,
    headers: { Location: DESTINATION, 'Cache-Control': 'no-store' },
  }));
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CLEAR_PRIVATE_AUDIO') return;
  event.waitUntil(removeLegacyCaches().then(cleared => event.ports?.[0]?.postMessage({ cleared })));
});
