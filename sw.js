// Service worker de Two : affiche les notifications push, même site fermé.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: "Two", body: "Nouveau message" };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.some((w) => w.focused && w.visibilityState === "visible")) return;
      await self.registration.showNotification(data.title || "Two", {
        body: data.body || "",
        icon: "./icon-192.png",
        badge: "./icon-192.png",
        tag: data.tag,
        renotify: true,
        data: { peerId: data.peerId },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const peerId = event.notification.data?.peerId;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (windows.length) {
        await windows[0].focus();
        windows[0].postMessage({ type: "open-conversation", peerId });
      } else {
        await self.clients.openWindow(self.registration.scope + (peerId ? `?open=${encodeURIComponent(peerId)}` : ""));
      }
    })(),
  );
});
