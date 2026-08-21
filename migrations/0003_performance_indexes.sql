-- 0003_performance_indexes
-- Performance indexes for weather_observations to accelerate:
--   - latest-observation-per-station queries (dashboard aggregation, rain alerts)
--   - latest-per-collection lookups
--   - time-range scans

-- Composite index for per-station time-range queries (dashboard aggregation,
-- latest-observation-per-station lookups).
CREATE INDEX IF NOT EXISTS idx_weather_observations_location_time
ON weather_observations(location_id, observed_at);

-- Composite index for latest-per-collection lookups (rain alert station
-- gathering, stale detection).
CREATE INDEX IF NOT EXISTS idx_weather_observations_location_collected
ON weather_observations(location_id, collected_at);