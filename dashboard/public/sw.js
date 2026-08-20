/* Service Worker for Meteo Data Dashboard
 *
 * Handles Web Push events and notification clicks. The `injectManifest`
 * strategy (via vite-plugin-pwa) prepends a precache manifest at the
 * `self.__WB_MANIFEST` placeholder below; push handling is added after.
 */

import { precacheAndRoute } from "workbox-precaching";

// Injected by vite-plugin-pwa at build time.
self.__WB_MANIFEST;
precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Display a notification when a push event arrives. */
self.addEventListener("push", (event) => {
  let data = { title: "Meteo Alert", body: "A weather alert was received." };
  try {
    const parsed = event.data ? event.data.json() : null;
    if (parsed) {
      data = { title: parsed.title ?? data.title, body: parsed.body ?? data.body };
    }
  } catch {
    // Ignore malformed payloads; fall back to the defaults.
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      data: { url: "/" },
    }),
  );
});

/** Open the dashboard when the notification is clicked. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});