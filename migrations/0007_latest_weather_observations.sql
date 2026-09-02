-- 0007_latest_weather_observations
-- Materialized latest-state table for the rain alert pipeline.
--
-- The alert system only needs the newest observation per station. Previously
-- `loadLatestStations()` computed `MAX(observed_at)` with a correlated
-- subquery, which D1 planned as a full SCAN of weather_observations on every
-- alert evaluation (~15k rows read per run regardless of staleness).
--
-- This table holds exactly one row per station and is maintained by the
-- collector after every successful observation insert (see
-- src/db/latest.ts), so alert evaluation reads a handful of rows instead of
-- the full historical table.
CREATE TABLE IF NOT EXISTS latest_weather_observations (
  location_id TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  precipitation_rate REAL,
  temperature REAL,
  humidity REAL,
  updated_at TEXT NOT NULL
);

-- One-time backfill: seed each station's latest existing observation so the
-- alert pipeline is fully populated immediately after migration (it would
-- otherwise self-heal within one 5-minute collection cycle, but backfilling
-- avoids a window where no station appears fresh). `INSERT OR IGNORE` keeps
-- the migration idempotent-safe on re-application.
INSERT OR IGNORE INTO latest_weather_observations (
  location_id, observed_at, precipitation_rate, temperature, humidity, updated_at
)
SELECT
  o.location_id,
  o.observed_at,
  o.precipitation_rate,
  o.temperature,
  o.humidity,
  o.collected_at
FROM weather_observations o
WHERE o.observed_at = (
  SELECT MAX(o2.observed_at)
  FROM weather_observations o2
  WHERE o2.location_id = o.location_id
);