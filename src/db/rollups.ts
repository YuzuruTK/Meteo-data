import type { D1Database } from "@cloudflare/workers-types";

/**
 * Observation retention and aggregation.
 *
 * Maintains `weather_observations_hourly` and `weather_observations_daily`
 * rollup tables so historical analytics do not have to scan the raw dataset.
 * Raw observations remain untouched; the only pruning performed is the
 * retention of hourly aggregates (see HOURLY_RETENTION_DAYS below).
 *
 * KNOWN LIMITATION — wind direction averaging:
 *
 * `wind_direction_avg` is computed with a simple arithmetic mean (`AVG()`).
 * This is not mathematically correct for circular variables: e.g. for
 * 359° + 1° the correct mean is 0°, but `AVG()` yields 180°. A future fix
 * should use a circular mean based on sine/cosine components
 * (atan2(mean(sin θ), mean(cos θ))). The limitation is documented here on
 * purpose; the schema and queries are intentionally left unchanged for now.
 *
 * The rollup is idempotent: it recomputes a bounded recent window (default
 * 24 hours) and upserts into the rollup tables on every call.  Re-running is
 * safe and converges to the same values.
 *
 * Daily values are derived from the hourly table.  Daily AVG columns are
 * weighted by observation count so the average remains accurate even when
 * hourly buckets contain different numbers of observations.
 */

/** How many recent hours to (re)roll-up on each run. */
export const ROLLUP_WINDOW_HOURS = 24;

/**
 * How many days of hourly aggregates to keep.
 *
 * Retention policy: hourly rollups are an optimization cache; keeping them
 * forever would make the D1 database grow unbounded. After the daily rollup
 * is generated, hourly aggregates older than this many days are deleted.
 * Raw observations (`weather_observations`) and daily aggregates
 * (`weather_observations_daily`) are never pruned, so historical data can
 * always be re-derived if needed.
 */
export const HOURLY_RETENTION_DAYS = 180;

const HOURLY_AVG_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_direction",
  "wind_gust",
  "precipitation_rate",
  "uv_index",
  "cloud_cover",
  "visibility",
] as const;

const HOURLY_MIN_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_gust",
] as const;

const HOURLY_MAX_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_gust",
  "precipitation_rate",
  "uv_index",
] as const;

const DAILY_AVG_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_direction",
  "precipitation_rate",
  "uv_index",
  "cloud_cover",
  "visibility",
] as const;

const DAILY_MIN_COLUMNS = ["temperature", "humidity", "pressure"] as const;

const DAILY_MAX_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_gust",
  "precipitation_rate",
  "uv_index",
] as const;

function avgSql(col: string): string {
  return `AVG(${col}) AS ${col}_avg`;
}

function minSql(col: string): string {
  return `MIN(${col}) AS ${col}_min`;
}

function maxSql(col: string): string {
  return `MAX(${col}) AS ${col}_max`;
}

/**
 * Roll up raw observations into the hourly table and then derive the daily
 * table from the hourly rows within the same window. Idempotent.
 */
export async function rollupObservations(
  db: D1Database,
  windowHours: number = ROLLUP_WINDOW_HOURS,
): Promise<{ hourlyRows: number; dailyRows: number }> {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(windowHours)));

  const hourlySelectColumns = [
    "location_id",
    `strftime('%Y-%m-%d %H:00', observed_at) AS hour`,
    ...HOURLY_AVG_COLUMNS.map(avgSql),
    ...HOURLY_MIN_COLUMNS.map(minSql),
    ...HOURLY_MAX_COLUMNS.map(maxSql),
    "SUM(precipitation_total) AS precipitation_total_sum",
    "COUNT(*) AS observation_count",
  ].join(",\n       ");

  const hourlyUpsertSet = HOURLY_AVG_COLUMNS.map(
    (c) => `${c}_avg = excluded.${c}_avg`,
  )
    .concat(
      HOURLY_MIN_COLUMNS.map((c) => `${c}_min = excluded.${c}_min`),
      HOURLY_MAX_COLUMNS.map((c) => `${c}_max = excluded.${c}_max`),
      ["precipitation_total_sum = excluded.precipitation_total_sum"],
    )
    .join(", ");

  const hourly = await db
    .prepare(
      `INSERT INTO weather_observations_hourly (
         location_id, hour,
         ${HOURLY_AVG_COLUMNS.map((c) => `${c}_avg`).join(", ")},
         ${HOURLY_MIN_COLUMNS.map((c) => `${c}_min`).join(", ")},
         ${HOURLY_MAX_COLUMNS.map((c) => `${c}_max`).join(", ")},
         precipitation_total_sum, observation_count
       )
       SELECT ${hourlySelectColumns}
       FROM weather_observations
       -- datetime() normalizes the stored ISO-8601 UTC string before
       -- comparison; a raw lexicographic ISO-vs-datetime() comparison is
       -- wrong on the same calendar date ('T' > ' ' in ASCII).
       WHERE datetime(observed_at) >= datetime('now', '-${hours} hours')
       GROUP BY location_id, hour
       ON CONFLICT(location_id, hour) DO UPDATE SET
         ${hourlyUpsertSet},
         observation_count = excluded.observation_count`,
    )
    .run();

  // Build the daily rollup from the hourly table, weighting AVG columns by
  // observation_count so daily averages remain exact.
  //
  // Daily rollup correctness: the hourly recomputation is intentionally
  // bounded to the recent window, but the daily rollup must always cover the
  // **complete** calendar day for any day that has at least one hourly bucket
  // inside the window.  Otherwise a partial-day window would overwrite a
  // previously-complete daily aggregate with truncated data.
  //
  // Strategy:
  //   1. Find the distinct calendar days touched by the recent hourly window.
  //   2. Re-aggregate ALL hourly rows for those entire days.
  const dailyAvgExpr = DAILY_AVG_COLUMNS.map(
    (c) =>
      `CASE WHEN SUM(observation_count) = 0 THEN NULL
            ELSE SUM(${c}_avg * observation_count) / SUM(observation_count)
       END AS ${c}_avg`,
  ).join(",\n       ");

  const dailySelectColumns = [
    "location_id",
    `substr(hour, 1, 10) AS day`,
    dailyAvgExpr,
    ...DAILY_MIN_COLUMNS.map((c) => `MIN(${c}_min) AS ${c}_min`),
    ...DAILY_MAX_COLUMNS.map((c) => `MAX(${c}_max) AS ${c}_max`),
    "SUM(precipitation_total_sum) AS precipitation_total_sum",
    "SUM(observation_count) AS observation_count",
  ].join(",\n       ");

  const dailyUpsertSet = DAILY_AVG_COLUMNS.map(
    (c) => `${c}_avg = excluded.${c}_avg`,
  )
    .concat(
      DAILY_MIN_COLUMNS.map((c) => `${c}_min = excluded.${c}_min`),
      DAILY_MAX_COLUMNS.map((c) => `${c}_max = excluded.${c}_max`),
      [
        "precipitation_total_sum = excluded.precipitation_total_sum",
        "observation_count = excluded.observation_count",
      ],
    )
    .join(", ");

  const daily = await db
    .prepare(
      `INSERT INTO weather_observations_daily (
         location_id, day,
         ${DAILY_AVG_COLUMNS.map((c) => `${c}_avg`).join(", ")},
         ${DAILY_MIN_COLUMNS.map((c) => `${c}_min`).join(", ")},
         ${DAILY_MAX_COLUMNS.map((c) => `${c}_max`).join(", ")},
         precipitation_total_sum, observation_count
       )
       SELECT ${dailySelectColumns}
       FROM weather_observations_hourly
       WHERE substr(hour, 1, 10) IN (
         SELECT DISTINCT substr(hour, 1, 10)
         FROM weather_observations_hourly
         WHERE hour >= datetime('now', '-${hours} hours')
       )
       GROUP BY location_id, day
       ON CONFLICT(location_id, day) DO UPDATE SET
         ${dailyUpsertSet}`,
    )
    .run();

  // Retention: prune hourly aggregates older than HOURLY_RETENTION_DAYS.
  // This runs after the daily rollup so the daily table is always derived
  // before any hourly rows are removed. Only `weather_observations_hourly`
  // is affected — raw observations and daily aggregates are never deleted.
  await db
    .prepare(
      `DELETE FROM weather_observations_hourly
       WHERE hour < datetime('now', '-${HOURLY_RETENTION_DAYS} days')`,
    )
    .run();

  return {
    hourlyRows: hourly.meta.changes ?? 0,
    dailyRows: daily.meta.changes ?? 0,
  };
}