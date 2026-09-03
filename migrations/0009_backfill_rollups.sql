-- 0009_backfill_rollups
-- One-time idempotent backfill of the hourly and daily rollup tables.
--
-- Why it is needed: every rollup execution failed silently between the day
-- the feature shipped and migration 0008 (missing wind_gust_min column;
-- see 0008 and docs/performance-rollups-analysis.md), so historical
-- hourly/daily aggregates outside the recent window do not exist. The
-- incremental rollup model (updateHourlyBucket / updateDailyRow /
-- rollupObservations repair, see docs/incremental-rollups.md) only maintains
-- recent buckets, so history must be backfilled once.
--
-- Properties:
--   - Zero schema change (no ALTER TABLE): pure data backfill.
--   - Idempotent: re-applying converges to the same values (upserts).
--   - Raw `weather_observations` is never modified — it remains the source
--     of truth; rollups are pure derived caches.
--   - One-time cost (~15k rows as of 2026-02): acceptable for a migration;
--     no recurring query in production ever scans unbounded history.
--
-- Applies AFTER the code deploy or BEFORE it — both orders are safe, because
-- every rollup writer recomputes buckets from the same raw data with
-- idempotent upserts.

-- 1. Hourly backfill: aggregate the FULL raw history per (location, hour).
INSERT INTO weather_observations_hourly (
  location_id, hour,
  temperature_avg, temperature_min, temperature_max,
  solar_radiation_avg, solar_radiation_min, solar_radiation_max,
  humidity_avg, humidity_min, humidity_max,
  pressure_avg, pressure_min, pressure_max,
  wind_speed_avg, wind_speed_min, wind_speed_max,
  wind_direction_avg,
  wind_gust_avg, wind_gust_min, wind_gust_max,
  precipitation_rate_avg, precipitation_rate_max,
  precipitation_total_sum,
  uv_index_avg, uv_index_max,
  cloud_cover_avg,
  visibility_avg,
  observation_count
)
SELECT
  location_id,
  strftime('%Y-%m-%d %H:00', observed_at) AS hour,
  AVG(temperature) AS temperature_avg,
  MIN(temperature) AS temperature_min,
  MAX(temperature) AS temperature_max,
  AVG(solar_radiation) AS solar_radiation_avg,
  MIN(solar_radiation) AS solar_radiation_min,
  MAX(solar_radiation) AS solar_radiation_max,
  AVG(humidity) AS humidity_avg,
  MIN(humidity) AS humidity_min,
  MAX(humidity) AS humidity_max,
  AVG(pressure) AS pressure_avg,
  MIN(pressure) AS pressure_min,
  MAX(pressure) AS pressure_max,
  AVG(wind_speed) AS wind_speed_avg,
  MIN(wind_speed) AS wind_speed_min,
  MAX(wind_speed) AS wind_speed_max,
  AVG(wind_direction) AS wind_direction_avg,
  AVG(wind_gust) AS wind_gust_avg,
  MIN(wind_gust) AS wind_gust_min,
  MAX(wind_gust) AS wind_gust_max,
  AVG(precipitation_rate) AS precipitation_rate_avg,
  MAX(precipitation_rate) AS precipitation_rate_max,
  SUM(precipitation_total) AS precipitation_total_sum,
  AVG(uv_index) AS uv_index_avg,
  MAX(uv_index) AS uv_index_max,
  AVG(cloud_cover) AS cloud_cover_avg,
  AVG(visibility) AS visibility_avg,
  COUNT(*) AS observation_count
FROM weather_observations
GROUP BY location_id, hour
ON CONFLICT(location_id, hour) DO UPDATE SET
  temperature_avg = excluded.temperature_avg,
  temperature_min = excluded.temperature_min,
  temperature_max = excluded.temperature_max,
  solar_radiation_avg = excluded.solar_radiation_avg,
  solar_radiation_min = excluded.solar_radiation_min,
  solar_radiation_max = excluded.solar_radiation_max,
  humidity_avg = excluded.humidity_avg,
  humidity_min = excluded.humidity_min,
  humidity_max = excluded.humidity_max,
  pressure_avg = excluded.pressure_avg,
  pressure_min = excluded.pressure_min,
  pressure_max = excluded.pressure_max,
  wind_speed_avg = excluded.wind_speed_avg,
  wind_speed_min = excluded.wind_speed_min,
  wind_speed_max = excluded.wind_speed_max,
  wind_direction_avg = excluded.wind_direction_avg,
  wind_gust_avg = excluded.wind_gust_avg,
  wind_gust_min = excluded.wind_gust_min,
  wind_gust_max = excluded.wind_gust_max,
  precipitation_rate_avg = excluded.precipitation_rate_avg,
  precipitation_rate_max = excluded.precipitation_rate_max,
  precipitation_total_sum = excluded.precipitation_total_sum,
  uv_index_avg = excluded.uv_index_avg,
  uv_index_max = excluded.uv_index_max,
  cloud_cover_avg = excluded.cloud_cover_avg,
  visibility_avg = excluded.visibility_avg,
  observation_count = excluded.observation_count;

-- 2. Daily backfill: derive the FULL history from the freshly completed
--    hourly table, covering COMPLETE calendar days (weighted AVG by
--    observation_count — same derivation as the production rollup writer).
INSERT INTO weather_observations_daily (
  location_id, day,
  temperature_avg, temperature_min, temperature_max,
  solar_radiation_avg, solar_radiation_max,
  humidity_avg, humidity_min, humidity_max,
  pressure_avg, pressure_min, pressure_max,
  wind_speed_avg, wind_speed_max,
  wind_direction_avg,
  wind_gust_max,
  precipitation_rate_avg, precipitation_rate_max,
  precipitation_total_sum,
  uv_index_avg, uv_index_max,
  cloud_cover_avg,
  visibility_avg,
  observation_count
)
SELECT
  location_id,
  substr(hour, 1, 10) AS day,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(temperature_avg * observation_count) / SUM(observation_count)
  END AS temperature_avg,
  MIN(temperature_min) AS temperature_min,
  MAX(temperature_max) AS temperature_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(solar_radiation_avg * observation_count) / SUM(observation_count)
  END AS solar_radiation_avg,
  MAX(solar_radiation_max) AS solar_radiation_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(humidity_avg * observation_count) / SUM(observation_count)
  END AS humidity_avg,
  MIN(humidity_min) AS humidity_min,
  MAX(humidity_max) AS humidity_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(pressure_avg * observation_count) / SUM(observation_count)
  END AS pressure_avg,
  MIN(pressure_min) AS pressure_min,
  MAX(pressure_max) AS pressure_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(wind_speed_avg * observation_count) / SUM(observation_count)
  END AS wind_speed_avg,
  MAX(wind_speed_max) AS wind_speed_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(wind_direction_avg * observation_count) / SUM(observation_count)
  END AS wind_direction_avg,
  MAX(wind_gust_max) AS wind_gust_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(precipitation_rate_avg * observation_count) / SUM(observation_count)
  END AS precipitation_rate_avg,
  MAX(precipitation_rate_max) AS precipitation_rate_max,
  SUM(precipitation_total_sum) AS precipitation_total_sum,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(uv_index_avg * observation_count) / SUM(observation_count)
  END AS uv_index_avg,
  MAX(uv_index_max) AS uv_index_max,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(cloud_cover_avg * observation_count) / SUM(observation_count)
  END AS cloud_cover_avg,
  CASE WHEN SUM(observation_count) = 0 THEN NULL
       ELSE SUM(visibility_avg * observation_count) / SUM(observation_count)
  END AS visibility_avg,
  SUM(observation_count) AS observation_count
FROM weather_observations_hourly
GROUP BY location_id, day
ON CONFLICT(location_id, day) DO UPDATE SET
  temperature_avg = excluded.temperature_avg,
  temperature_min = excluded.temperature_min,
  temperature_max = excluded.temperature_max,
  solar_radiation_avg = excluded.solar_radiation_avg,
  solar_radiation_max = excluded.solar_radiation_max,
  humidity_avg = excluded.humidity_avg,
  humidity_min = excluded.humidity_min,
  humidity_max = excluded.humidity_max,
  pressure_avg = excluded.pressure_avg,
  pressure_min = excluded.pressure_min,
  pressure_max = excluded.pressure_max,
  wind_speed_avg = excluded.wind_speed_avg,
  wind_speed_max = excluded.wind_speed_max,
  wind_direction_avg = excluded.wind_direction_avg,
  wind_gust_max = excluded.wind_gust_max,
  precipitation_rate_avg = excluded.precipitation_rate_avg,
  precipitation_rate_max = excluded.precipitation_rate_max,
  precipitation_total_sum = excluded.precipitation_total_sum,
  uv_index_avg = excluded.uv_index_avg,
  uv_index_max = excluded.uv_index_max,
  cloud_cover_avg = excluded.cloud_cover_avg,
  visibility_avg = excluded.visibility_avg,
  observation_count = excluded.observation_count;

-- 3. Retention clamp: hourly aggregates are a cache with a 180-day retention
--    (see HOURLY_RETENTION_DAYS in src/db/rollups.ts). The daily rows derived
--    above remain the permanent long-term record. Running the clamp here —
--    AFTER the daily backfill — keeps the hourly table within its documented
--    bound instead of leaving rows that production would prune on the next
--    repair run.
DELETE FROM weather_observations_hourly
WHERE hour < datetime('now', '-180 days');