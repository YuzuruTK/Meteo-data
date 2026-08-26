-- 0006_forecast_alert_state
-- Persistent state for forecast-driven push notifications.
-- One row per alert category; the event key/fingerprint prevents repeated
-- notifications across the five-minute Worker schedule.
CREATE TABLE IF NOT EXISTS weather_forecast_alert_state (
  alert_type TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_time TEXT,
  fingerprint TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
