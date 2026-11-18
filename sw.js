self.addEventListener('push', event => {
  const { title, body } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, tag: 'ruangsemester-h1' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL('/#tugas', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.length) {
      await windows[0].navigate(target);
      return windows[0].focus();
    }
    return self.clients.openWindow(target);
  })());
});
