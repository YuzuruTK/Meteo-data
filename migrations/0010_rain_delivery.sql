-- Additive: existing subscriptions and rain states remain intact.
ALTER TABLE weather_alert_state ADD COLUMN last_processed_observed_at TEXT;
ALTER TABLE weather_alert_state ADD COLUMN last_valid_observed_at TEXT;
ALTER TABLE weather_alert_state ADD COLUMN dry_since_observed_at TEXT;
ALTER TABLE weather_alert_state ADD COLUMN dry_sample_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE weather_alert_state ADD COLUMN episode_started_observed_at TEXT;
ALTER TABLE weather_alert_state ADD COLUMN last_event_id TEXT;
ALTER TABLE weather_alert_state ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE weather_alert_state ADD COLUMN transition_token TEXT;
ALTER TABLE push_subscriptions ADD COLUMN id TEXT;
UPDATE push_subscriptions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX push_subscription_id ON push_subscriptions(id);
ALTER TABLE push_subscriptions ADD COLUMN control_hash TEXT;
ALTER TABLE push_subscriptions ADD COLUMN preferences TEXT NOT NULL DEFAULT '{"stationScope":"all","stationIds":[],"rainStart":true,"rainForecast":true,"temperatureForecast":true,"locale":"en"}';
ALTER TABLE push_subscriptions ADD COLUMN test_at TEXT;
CREATE TRIGGER push_subscription_assign_id AFTER INSERT ON push_subscriptions WHEN NEW.id IS NULL
BEGIN UPDATE push_subscriptions SET id = lower(hex(randomblob(16))) WHERE endpoint = NEW.endpoint; END;
CREATE TABLE push_batches (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, mode TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', prepared INTEGER NOT NULL DEFAULT 0);
CREATE INDEX push_batch_prepare ON push_batches(mode, prepared, created_at);
CREATE TABLE rain_events (
 id TEXT PRIMARY KEY, station_id TEXT NOT NULL, station_name TEXT NOT NULL, observed_at TEXT NOT NULL,
 detected_at TEXT NOT NULL, rate_mm_h REAL NOT NULL, batch_id TEXT NOT NULL REFERENCES push_batches(id), expires_at TEXT NOT NULL,
 UNIQUE(station_id, observed_at)
);
CREATE INDEX rain_event_batch ON rain_events(batch_id);
CREATE INDEX rain_event_station ON rain_events(station_id, observed_at);
CREATE INDEX rain_event_expiry ON rain_events(expires_at);
CREATE TABLE push_deliveries (
 batch_id TEXT NOT NULL REFERENCES push_batches(id), subscription_id TEXT NOT NULL,
 event_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT NOT NULL, expires_at TEXT NOT NULL, lease_token TEXT, lease_until TEXT, accepted_at TEXT, error TEXT,
 PRIMARY KEY(batch_id, subscription_id)
);
CREATE INDEX push_delivery_due ON push_deliveries(status, next_attempt_at);
CREATE INDEX push_delivery_subscription ON push_deliveries(subscription_id);
CREATE INDEX push_delivery_expiry ON push_deliveries(expires_at);
