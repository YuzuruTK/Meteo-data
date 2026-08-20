-- 0002_push_subscriptions
-- Anonymous browser push notifications for weather rain alerts

-- One row per browser push subscription (anonymous, no user accounts)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Persistent rain state per station, so alerts fire only on a dry -> rain
-- transition (no repeated notifications while rain continues).
CREATE TABLE IF NOT EXISTS weather_alert_state (
  station_id TEXT PRIMARY KEY,
  raining INTEGER NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);