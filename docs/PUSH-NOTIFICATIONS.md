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
  send.ts           delivery via web-push + 404/410 cleanup
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