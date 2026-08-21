-- 0005_observation_rollups
-- Hourly and daily aggregation tables for long-term observation storage.
-- Raw observations remain in weather_observations; these rollup tables
-- provide efficient access to historical trends without scanning the full
-- raw dataset.
--
-- Rollups are maintained by an idempotent function that runs after each
-- collection cycle.  No automatic pruning of raw data is performed.

-- Hourly rollup: one row per station per hour, with AVG/MIN/MAX for each
-- numeric meteorological variable.
CREATE TABLE IF NOT EXISTS weather_observations_hourly (
  location_id TEXT NOT NULL,
  hour TEXT NOT NULL,  -- "YYYY-MM-DD HH:00" (UTC)
  temperature_avg REAL,
  temperature_min REAL,
  temperature_max REAL,
  solar_radiation_avg REAL,
  solar_radiation_min REAL,
  solar_radiation_max REAL,
  humidity_avg REAL,
  humidity_min REAL,
  humidity_max REAL,
  pressure_avg REAL,
  pressure_min REAL,
  pressure_max REAL,
  wind_speed_avg REAL,
  wind_speed_min REAL,
  wind_speed_max REAL,
  wind_direction_avg REAL,
  wind_gust_avg REAL,
  wind_gust_max REAL,
  precipitation_rate_avg REAL,
  precipitation_rate_max REAL,
  precipitation_total_sum REAL,
  uv_index_avg REAL,
  uv_index_max REAL,
  cloud_cover_avg REAL,
  visibility_avg REAL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_obs_hourly_hour
ON weather_observations_hourly(hour);

-- Daily rollup: one row per station per day, aggregated from the hourly
-- table for efficiency.
CREATE TABLE IF NOT EXISTS weather_observations_daily (
  location_id TEXT NOT NULL,
  day TEXT NOT NULL,  -- "YYYY-MM-DD" (UTC)
  temperature_avg REAL,
  temperature_min REAL,
  temperature_max REAL,
  solar_radiation_avg REAL,
  solar_radiation_max REAL,
  humidity_avg REAL,
  humidity_min REAL,
  humidity_max REAL,
  pressure_avg REAL,
  pressure_min REAL,
  pressure_max REAL,
  wind_speed_avg REAL,
  wind_speed_max REAL,
  wind_direction_avg REAL,
  wind_gust_max REAL,
  precipitation_rate_avg REAL,
  precipitation_rate_max REAL,
  precipitation_total_sum REAL,
  uv_index_avg REAL,
  uv_index_max REAL,
  cloud_cover_avg REAL,
  visibility_avg REAL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, day)
);

CREATE INDEX IF NOT EXISTS idx_obs_daily_day
ON weather_observations_daily(day);