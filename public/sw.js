self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || 'A new order is ready for packing.' }; }
  const title = payload.title || 'New order to pack';
  const options = {
    body: payload.body || 'A new order was assigned to you.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    tag: payload.orderId || 'new-packing-order',
    renotify: true,
    requireInteraction: true,
    vibrate: [250, 150, 250, 150, 450],
    data: { url: payload.url || '/?page=Packing' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || '/?page=Packing', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if ('focus' in client) { await client.focus(); return client.navigate(destination); }
    return self.clients.openWindow(destination);
  })());
});
