// Service worker for the Messaging panel's Web Push demo.
//
// Web Push needs a service worker: the browser hands the push event to *this*
// script, not to the page, so notifications arrive even with the tab closed.
// Vite serves `public/` at the site root, so this registers as `/sw.js` with
// root scope — which is what `pushManager.subscribe()` requires.
//
// backlex sends the payload `{ title, body, url, data }` (see docs/push-messaging.md).

self.addEventListener("push", (event) => {
  // A push with no body still wakes the worker — show something rather than
  // letting the browser render its own "This site has been updated" notice.
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = payload.title || "backlex";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      data: { url: payload.url || "/", ...(payload.data || {}) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  // Focus an already-open tab on this origin instead of piling up new ones.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if (win.url.includes(new URL(url, self.location.origin).pathname) && "focus" in win) {
          return win.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
