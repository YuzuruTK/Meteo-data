-- 0003_performance_indexes
-- High-priority performance improvements

CREATE INDEX IF NOT EXISTS idx_weather_observations_location_collected
  ON weather_observations (location_id, collected_at);

CREATE INDEX IF NOT EXISTS idx_weather_alert_state_station
  ON weather_alert_state (station_id);
