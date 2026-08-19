-- 0001_initial_schema
-- Weather data collector schema

-- Location metadata (one row per configured location per source)
CREATE TABLE IF NOT EXISTS weather_locations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_weather_locations_source_external
  ON weather_locations (source_id, external_id);

-- Normalized meteorological observations (history retained)
CREATE TABLE IF NOT EXISTS weather_observations (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  temperature REAL,
  solar_radiation REAL,
  humidity REAL,
  pressure REAL,
  wind_speed REAL,
  wind_direction REAL,
  wind_gust REAL,
  precipitation_rate REAL,
  precipitation_total REAL,
  uv_index REAL,
  cloud_cover REAL,
  visibility REAL,
  collected_at TEXT NOT NULL,
  -- Deduplicate retries on the logical key (source, location, observed_at)
  UNIQUE (source_id, location_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_weather_observations_source_location_time
  ON weather_observations (source_id, location_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_weather_observations_collected
  ON weather_observations (collected_at);

-- One row per scheduled/manual collection run
CREATE TABLE IF NOT EXISTS collector_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,          -- success | partial | failed
  sources_attempted INTEGER NOT NULL DEFAULT 0,
  requests_attempted INTEGER NOT NULL DEFAULT 0,
  requests_succeeded INTEGER NOT NULL DEFAULT 0,
  requests_failed INTEGER NOT NULL DEFAULT 0
);

-- One row per API/location request attempt
CREATE TABLE IF NOT EXISTS collector_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,          -- success | failed
  http_status INTEGER,
  response_time_ms INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_collector_requests_run
  ON collector_requests (run_id);