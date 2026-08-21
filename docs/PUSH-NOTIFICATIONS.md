# Anonymous push notifications (rain alerts)

This project supports anonymous **Web Push** notifications so visitors can subscribe to rain alerts without creating an account. When rain *starts* at a monitored station, subscribers receive a browser notification. Continuous rain does **not** generate repeated alerts.

## How it works

1. The dashboard shows a **🔔 Rain Alerts** card. Clicking **Subscribe** requests browser notification permission, registers the Service Worker, creates a push subscription, and stores it on the backend (`POST /api/push-subscribe`).
2. No account is needed — the subscription is identified solely by its push endpoint URL.
3. On every scheduled collection, the Worker queries the latest precipitation rate per station and compares it with the persisted previous state (`weather_alert_state`).
4. Only when a station transitions from **dry → raining** does the Worker send a push to all subscribers (`POST` to each push service with VAPID auth).
5. Subscriptions that return **404/410** (expired/gone) are automatically deleted from D1 to prevent database growth.

## New database tables (`migrations/0002_push_subscriptions.sql`)

- `push_subscriptions` — `endpoint` (PK), `p256dh`, `auth`, `created_at`.
- `weather_alert_state` — `station_id` (PK), `raining`, `updated_at` (dedupe state).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/push/public-key` | Returns the VAPID public key used to create the subscription. |
| `POST` | `/api/push-subscribe` | Body `{ endpoint, keys: { p256dh, auth } }` — stores a subscription (idempotent). |
| `POST` | `/api/push-unsubscribe` | Body `{ endpoint }` — removes a subscription. |
| `POST` | `/api/push/test` | (Secret-protected) Sends a test notification to all subscribers. Header `x-collector-trigger: <secret>`. |

## Test trigger (send a fake notification)

To verify push delivery end-to-end without waiting for real rain, subscribe on a device (e.g. a real Android phone with Play Services), then send a test notification to all subscribers:

```bash
curl -X POST https://YOUR_WORKER.workers.dev/api/push/test \
  -H "x-collector-trigger: YOUR_TRIGGER_SECRET"
```

The response reports how many notifications were sent, how many expired subscriptions were removed, and any errors:
`{ "sent": 1, "removed": 0, "errors": [] }`

## VAPID keys

Generate a VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

This prints a public key and a private key. Store them as Worker secrets (see [SECRETS.md](SECRETS.md)):

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (optional; defaults to `mailto:admin@meteo-data.workers.dev`)

Keys are read from the environment at runtime — they are **never** hardcoded.

## Files

```
src/push/
  api.ts            HTTP handlers for subscribe/unsubscribe/public-key
  subscriptions.ts  D1 persistence for push_subscriptions
  send.ts           delivery via web-push-neo + 404/410 cleanup
  rain.ts           dry->wet detection + message building
  alerts.ts         orchestrates rain detection + sending
  vapid.ts          base64url helpers for key handling
dashboard/
  public/sw.js      Service Worker (push + notification click)
  src/push.ts       client-side subscribe/unsubscribe helpers
  src/NotificationSettings.tsx  "Rain Alerts" UI card
migrations/0002_push_subscriptions.sql
```

## Local / Android testing notes

- **Localhost**: push requires a secure context. Use `https://localhost` or Wrangler's dev preview URL. Push *delivery* to a real push service needs the deployed origin, but the subscribe flow and UI can be tested locally.
- **Android Chrome**: Open the deployed URL, allow notifications, tap **Subscribe**, then add the site to the home screen (PWA). Rain-start notifications will appear even when the site is closed.
- Notifications appear with the **🌦️ / 🌧️ / ⛈️** intensity prefix based on precipitation rate.

## Android troubleshooting ("Registration failed - push service error")

This error is thrown by the browser's `pushManager.subscribe()` and usually means the device cannot reach the push provider (FCM), **not** a problem with the VAPID key or this codebase (if subscription works on desktop, the key and backend are confirmed fine).

Common causes on Android:

1. **No Google Play Services / no signed-in Google account.** Android Chrome delivers push via FCM, which requires Google Play Services and a signed-in Google account. Android **emulators** (the log's User-Agent shows model `"K"`, the emulator identifier) frequently lack this and fail with this exact error. Test on a real device with Play Services.
2. **Browser or site not set up.** Make sure you're using **Chrome** (not a WebView or a custom browser), the site is served over **HTTPS** (it is), and notifications are allowed for the site.
3. **Network / region restrictions.** Some networks or regions can't reach FCM. Try on mobile data and in a different location.

To verify the deployment is healthy: run `curl https://<HOST>/api/push/public-key` and confirm it returns a valid 65-byte, `0x04`-prefixed key (the server validates this automatically — a misconfigured key returns a `500` with a clear message instead of a confusing browser error).
