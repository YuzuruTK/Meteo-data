/**
 * Client-side Web Push subscription helpers.
 *
 * Coordinates registration of the Service Worker, requesting browser
 * notification permission, creating/removing the push subscription, and
 * syncing it with the backend (anonymous — no account required).
 */

const PUSH_API = "/api/push";

export interface PushPublicKeyResponse {
  publicKey: string;
}

/** Convert a base64url-encoded VAPID public key into a Uint8Array. */
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/** Fetch the VAPID public key from the backend. */
async function fetchPublicKey(): Promise<string> {
  const res = await fetch(`${PUSH_API}/public-key`);
  if (!res.ok) {
    throw new Error(`Failed to load VAPID public key: ${res.status}`);
  }
  const data = (await res.json()) as PushPublicKeyResponse;
  return data.publicKey;
}

/** Is push supported (secure context + service worker + push manager)? */
export function isPushSupported(): boolean {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Register the Service Worker and return the registration. */
async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) {
    throw new Error("Service Workers are not supported in this browser");
  }
  return navigator.serviceWorker.register("/sw.js");
}

/** Get the current push subscription, if any. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await registerServiceWorker();
  return registration.pushManager.getSubscription();
}

/**
 * Subscribe the current browser to push notifications and store the
 * subscription on the backend.
 */
export async function subscribeToPush(): Promise<PushSubscription> {
  if (!isPushSupported()) {
    throw new Error("Push notifications are not supported in this browser");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted");
  }

  let registration: ServiceWorkerRegistration;
  try {
    registration = await registerServiceWorker();
  } catch (err) {
    throw new Error(
      "Service Worker registration failed — check that the site is served over HTTPS.",
    );
  }

  const publicKey = await fetchPublicKey();
  let subscription: PushSubscription;
  try {
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    const detail =
      name === "NotAllowedError"
        ? "Notification permission was denied or the system blocks notifications."
        : name === "AbortError"
          ? "The push service request was aborted — try again in a moment."
          : "Push service unavailable. On Android, this usually means the device has no Google Play Services or a signed-in Google account (emulators often fail here). Try a real device with Chrome and a Google account.";
    throw new Error(detail);
  }

  await sendSubscriptionToBackend(subscription);
  return subscription;
}

/** Send the subscription to the backend (idempotent). */
export async function sendSubscriptionToBackend(
  subscription: PushSubscription,
): Promise<void> {
  const res = await fetch(`${PUSH_API}-subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: subscription.endpoint,
      keys: {
        p256dh: subscription.getKey("p256dh")
          ? btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("p256dh")!)))
          : "",
        auth: subscription.getKey("auth")
          ? btoa(String.fromCharCode(...new Uint8Array(subscription.getKey("auth")!)))
          : "",
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to store subscription: ${res.status}`);
  }
}

/** Unsubscribe the browser and remove the subscription from the backend. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;

  const registration = await registerServiceWorker();
  const subscription = await registration.pushManager.getSubscription();

  if (subscription) {
    // Notify the backend to remove this endpoint.
    try {
      await fetch(`${PUSH_API}-unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    } catch {
      // Backend cleanup is best-effort; continue with local unsubscribe.
    }
    await subscription.unsubscribe();
  }
}