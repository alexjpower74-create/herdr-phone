self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
// Authenticated requests and terminal content are never cached.
self.addEventListener('push', event => {
  let payload = {}; try { payload = event.data.json(); } catch {}
  const url = typeof payload.url === 'string' && payload.url.startsWith('/#terminal=') ? payload.url : '/';
  event.waitUntil(self.registration.showNotification('Herdr', {body: payload.body === 'A turn finished' ? payload.body : 'A terminal needs you', tag: payload.tag, data:{url}, icon:'/icon.svg'}));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(async clients => {
    for (const client of clients) { if ('navigate' in client) { await client.navigate(url); return client.focus(); } }
    return self.clients.openWindow(url);
  }));
});
