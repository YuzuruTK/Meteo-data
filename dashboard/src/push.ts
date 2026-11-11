import type { PushPreferences } from "../../shared/weather";
export type { PushPreferences };
const TOKEN = "meteo-push-control";
function token(create = false) {
  let value = localStorage.getItem(TOKEN);
  if (!value && create) {
    value = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    localStorage.setItem(TOKEN, value);
  }
  return value;
}
export function isPushSupported() {
  return (
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
async function registration() {
  await navigator.serviceWorker.register("/sw.js");
  return await navigator.serviceWorker.ready;
}
export async function getExistingSubscription() {
  return isPushSupported()
    ? (await registration()).pushManager.getSubscription()
    : null;
}
async function request(path: string, body: unknown) {
  const auth = token();
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`push-${res.status}`);
  return res.json();
}
export async function subscriptionStatus(sub: PushSubscription) {
  return await request("/api/push/status", sub.toJSON());
}
export async function subscribeToPush(preferences: PushPreferences) {
  // Keep permission request in the original click's user activation.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("permission-denied");
  const controlToken = token(true);
  const reg = await registration();
  const response = await fetch("/api/push/public-key");
  if (!response.ok) throw new Error("service-unavailable");
  const { publicKey } = await response.json();
  const raw = atob(publicKey.replace(/-/g, "+").replace(/_/g, "/"));
  const key = Uint8Array.from(raw, (c: string) => c.charCodeAt(0));
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    }));
  const result = await request("/api/push-subscribe", {
    ...sub.toJSON(),
    version: 2,
    controlToken,
    preferences,
  });
  return result;
}
export async function savePreferences(preferences: PushPreferences) {
  const sub = await getExistingSubscription();
  if (!sub) throw new Error("subscription-missing");
  return request("/api/push/preferences", {
    endpoint: sub.endpoint,
    preferences,
  });
}
export async function unsubscribeFromPush() {
  const sub = await getExistingSubscription();
  if (!sub) return;
  await request("/api/push-unsubscribe", { endpoint: sub.endpoint });
  const removed = await sub.unsubscribe();
  if (!removed) throw new Error("local-unsubscribe-pending");
}
export async function testDevice() {
  const sub = await getExistingSubscription();
  if (!sub) throw new Error("subscription-missing");
  return request("/api/push/test-device", { endpoint: sub.endpoint });
}
