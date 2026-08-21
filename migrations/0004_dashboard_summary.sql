-- 0004_dashboard_summary
-- Precomputed latest-observation summary per station so the dashboard
-- "latest readings" cards can be served with a single lightweight query
-- instead of computing AVG/MIN/MAX over raw observations on every request.
--
-- Updated by the collector after each successful observation insert.

CREATE TABLE IF NOT EXISTS dashboard_summary (
  location_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
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
  updated_at TEXT NOT NULL
);