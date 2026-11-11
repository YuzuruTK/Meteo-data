import { precacheAndRoute, createHandlerBoundToURL } from "workbox-precaching";
import { registerRoute, NavigationRoute } from "workbox-routing";
precacheAndRoute(self.__WB_MANIFEST);
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//],
  }),
);
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
function safeUrl(value) {
  try {
    const url = new URL(
      typeof value === "string" ? value : "/",
      self.location.origin,
    );
    return url.origin === self.location.origin && /^https?:$/.test(url.protocol)
      ? url.href
      : self.location.origin + "/";
  } catch {
    return self.location.origin + "/";
  }
}
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    const candidate = event.data?.json();
    payload = candidate && typeof candidate === "object" ? candidate : {};
  } catch {}
  const data =
    payload.data && typeof payload.data === "object" ? payload.data : {};
  const expired =
    typeof data.expiresAt === "string" &&
    Date.parse(data.expiresAt) < Date.now();
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(
        expired
          ? "Meteo Data · Aviso anterior / Earlier alert"
          : typeof payload.title === "string"
            ? payload.title
            : "Meteo Data",
        {
          body:
            typeof payload.body === "string"
              ? payload.body
              : "Abra o painel para consultar as leituras.",
          icon: "/pwa-192x192.png",
          badge: "/pwa-192x192.png",
          tag: typeof payload.tag === "string" ? payload.tag : undefined,
          renotify: false,
          data: { ...data, url: safeUrl(data.url) },
        },
      );
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        client.postMessage({ type: "meteo-notification" });
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data?.url);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        if (
          new URL(client.url).origin === self.location.origin &&
          "navigate" in client
        ) {
          const navigated = await client.navigate(target);
          if (navigated) return navigated.focus();
        }
      return self.clients.openWindow(target);
    })(),
  );
});
