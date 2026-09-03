import type { D1Database } from "@cloudflare/workers-types";
import type { NormalizedWeatherObservation } from "../collector/types";

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
 * The system has two write paths (see docs/incremental-rollups.md):
 *
 * 1. **Incremental bucket updates** — `updateHourlyBucket()` and
 *    `updateDailyRow()` run once per newly inserted observation and recompute
 *    ONLY the single (location, hour) / (location, day) bucket the
 *    observation belongs to, with sargable bounds on
 *    `idx_weather_observations_location_time` / the hourly PK. Cost is
 *    O(bucket) (~12 rows), never O(history).
 *
 * 2. **Self-healing repair job** — `rollupObservations()` recomputes a short
 *    recent window (default `REPAIR_WINDOW_HOURS`) iterating per location and
 *    per (location, day). It runs at most once per hour (guarded by
 *    `shouldRunRollupRepair()`) and heals any bucket missed by a failed
 *    best-effort incremental update. Every statement is sargable: the
 *    previous non-sargable `WHERE datetime(observed_at) >= datetime('now',...)`
 *    full scan (docs/performance-rollups-analysis.md hotspot C1) and the
 *    `substr(hour,1,10) IN (...)` hourly-table scan were removed and are
 *    guarded against regression by EXPLAIN QUERY PLAN tests
 *    (tests/incremental-rollups.test.ts).
 *
 * The rollup is idempotent: every path recomputes buckets from the raw
 * source of truth and upserts; re-running converges to the same values.
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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * How many recent hours the periodic repair job recomputes. Short by design:
 * the incremental path keeps buckets current, so the repair only needs to
 * heal buckets missed by a failed best-effort update within the last hour.
 */
export const REPAIR_WINDOW_HOURS = 2;

/**
 * UTC minute at which the hourly repair job is allowed to run. The production
 * cron is `*\/5 * * * *`, so the :00 cycle always exists; running the repair
 * once per hour (instead of every 5 minutes) is what removes the old
 * full-recompute from the hot path.
 */
const REPAIR_MINUTE = 0;

/**
 * Whether the scheduled collection cycle at `now` should run the rollup
 * repair job. Pure function of the clock so tests can be deterministic.
 */
export function shouldRunRollupRepair(now: Date = new Date()): boolean {
  return now.getUTCMinutes() === REPAIR_MINUTE;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 'YYYY-MM-DD HH:00' UTC hour label — byte-identical to
 * `strftime('%Y-%m-%d %H:00', ts)` output, so bucket labels written by this
 * module and by the SQL aggregation always match.
 */
export function hourLabelOf(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    ` ${pad2(d.getUTCHours())}:00`
  );
}

/** 'YYYY-MM-DD' UTC calendar day of a Date. */
export function dayLabelOf(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Half-open ISO bounds [start, end) of the hour bucket containing `d`. */
function hourBounds(d: Date): { startIso: string; endIso: string } {
  const start = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
  );
  return {
    startIso: new Date(start).toISOString(),
    endIso: new Date(start + HOUR_MS).toISOString(),
  };
}

function dayStartMs(day: string): number {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid day label: ${day}`);
  return ms;
}

/** UTC calendar days covered by [startIso, endIso], inclusive of both end days. */
function touchedDays(startIso: string, endIso: string): string[] {
  const start = new Date(startIso);
  const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const end = new Date(endIso);
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days: string[] = [];
  for (let ms = first; ms <= last; ms += DAY_MS) {
    days.push(dayLabelOf(new Date(ms)));
  }
  return days;
}

/**
 * Shared hourly upsert: recompute buckets from the RAW table (source of
 * truth) and upsert. The `whereClause` MUST keep `location_id = ?` so the
 * composite index `idx_weather_observations_location_time` applies — a
 * time-only bound cannot use any index (none leads with `observed_at`) and
 * would full-scan the raw table (rejected design; see
 * docs/incremental-rollups.md).
 */
function hourlyUpsertStatement(whereClause: string): string {
  const selectColumns = [
    "location_id",
    `strftime('%Y-%m-%d %H:00', observed_at) AS hour`,
    ...HOURLY_AVG_COLUMNS.map(avgSql),
    ...HOURLY_MIN_COLUMNS.map(minSql),
    ...HOURLY_MAX_COLUMNS.map(maxSql),
    "SUM(precipitation_total) AS precipitation_total_sum",
    "COUNT(*) AS observation_count",
  ].join(",\n       ");

  const upsertSet = HOURLY_AVG_COLUMNS.map((c) => `${c}_avg = excluded.${c}_avg`)
    .concat(
      HOURLY_MIN_COLUMNS.map((c) => `${c}_min = excluded.${c}_min`),
      HOURLY_MAX_COLUMNS.map((c) => `${c}_max = excluded.${c}_max`),
      [
        "precipitation_total_sum = excluded.precipitation_total_sum",
        "observation_count = excluded.observation_count",
      ],
    )
    .join(", ");

  return `INSERT INTO weather_observations_hourly (
         location_id, hour,
         ${HOURLY_AVG_COLUMNS.map((c) => `${c}_avg`).join(", ")},
         ${HOURLY_MIN_COLUMNS.map((c) => `${c}_min`).join(", ")},
         ${HOURLY_MAX_COLUMNS.map((c) => `${c}_max`).join(", ")},
         precipitation_total_sum, observation_count
       )
       SELECT ${selectColumns}
       FROM weather_observations
       ${whereClause}
       GROUP BY location_id, hour
       ON CONFLICT(location_id, hour) DO UPDATE SET
         ${upsertSet}`;
}

/** Daily upsert derived from the hourly table (weighted AVG by count). */
function dailyFromHourlyStatement(whereClause: string): string {
  const dailyAvgExpr = DAILY_AVG_COLUMNS.map(
    (c) =>
      `CASE WHEN SUM(observation_count) = 0 THEN NULL
            ELSE SUM(${c}_avg * observation_count) / SUM(observation_count)
       END AS ${c}_avg`,
  ).join(",\n       ");

  const selectColumns = [
    "location_id",
    `substr(hour, 1, 10) AS day`,
    dailyAvgExpr,
    ...DAILY_MIN_COLUMNS.map((c) => `MIN(${c}_min) AS ${c}_min`),
    ...DAILY_MAX_COLUMNS.map((c) => `MAX(${c}_max) AS ${c}_max`),
    "SUM(precipitation_total_sum) AS precipitation_total_sum",
    "SUM(observation_count) AS observation_count",
  ].join(",\n       ");

  return dailyUpsertStatement(
    "FROM weather_observations_hourly",
    selectColumns,
    whereClause,
  );
}

/**
 * Daily upsert derived directly from the RAW table. Used only for days whose
 * hourly buckets may have been pruned by retention (late arrivals older than
 * HOURLY_RETENTION_DAYS) so a complete daily row is never truncated to the
 * surviving buckets. Still sargable: `location_id = ?` + ISO bounds hit
 * idx_weather_observations_location_time (≤ ~288 rows per day).
 */
function dailyFromRawStatement(whereClause: string): string {
  const selectColumns = [
    "location_id",
    `strftime('%Y-%m-%d', observed_at) AS day`,
    ...DAILY_AVG_COLUMNS.map(avgSql),
    ...DAILY_MIN_COLUMNS.map(minSql),
    ...DAILY_MAX_COLUMNS.map(maxSql),
    "SUM(precipitation_total) AS precipitation_total_sum",
    "COUNT(*) AS observation_count",
  ].join(",\n       ");

  return dailyUpsertStatement(
    "FROM weather_observations",
    selectColumns,
    whereClause,
  );
}

function dailyUpsertStatement(
  fromClause: string,
  selectColumns: string,
  whereClause: string,
): string {
  const upsertSet = DAILY_AVG_COLUMNS.map((c) => `${c}_avg = excluded.${c}_avg`)
    .concat(
      DAILY_MIN_COLUMNS.map((c) => `${c}_min = excluded.${c}_min`),
      DAILY_MAX_COLUMNS.map((c) => `${c}_max = excluded.${c}_max`),
      [
        "precipitation_total_sum = excluded.precipitation_total_sum",
        "observation_count = excluded.observation_count",
      ],
    )
    .join(", ");

  return `INSERT INTO weather_observations_daily (
         location_id, day,
         ${DAILY_AVG_COLUMNS.map((c) => `${c}_avg`).join(", ")},
         ${DAILY_MIN_COLUMNS.map((c) => `${c}_min`).join(", ")},
         ${DAILY_MAX_COLUMNS.map((c) => `${c}_max`).join(", ")},
         precipitation_total_sum, observation_count
       )
       SELECT ${selectColumns}
       ${fromClause}
       ${whereClause}
       GROUP BY location_id, day
       ON CONFLICT(location_id, day) DO UPDATE SET
         ${upsertSet}`;
}

/**
 * Incremental hourly bucket update: recompute ONLY the single
 * (location_id, hour) bucket the observation belongs to, directly from the
 * raw table. Called by the collector once per NEWLY inserted observation.
 *
 * Sargability: bounds are ISO strings computed in TypeScript (all stored
 * timestamps are `toISOString()` output, so ISO-vs-ISO lexicographic
 * comparison is exact); the `location_id = ?` equality plus range lets SQLite
 * use `idx_weather_observations_location_time` — EXPLAIN QUERY PLAN shows
 * `SEARCH weather_observations USING INDEX idx_weather_observations_location_time`
 * (~12 index rows at the 5-minute cadence), never a full scan. Guarded by
 * tests/incremental-rollups.test.ts.
 *
 * Idempotent and late-arrival-safe: the bucket is DERIVED from the raw source
 * of truth (not accumulated), so a late/out-of-order observation simply
 * recomputes its own bucket to the correct value.
 */
export async function updateHourlyBucket(
  db: D1Database,
  obs: NormalizedWeatherObservation,
): Promise<HourlyBucketUpdate> {
  const observed = new Date(obs.observed_at);
  if (Number.isNaN(observed.getTime())) {
    throw new Error(`Invalid observed_at: ${obs.observed_at}`);
  }
  const { startIso, endIso } = hourBounds(observed);
  const hour = hourLabelOf(observed);
  const day = hour.slice(0, 10);

  await db
    .prepare(
      hourlyUpsertStatement(
        "WHERE location_id = ? AND observed_at >= ? AND observed_at < ?",
      ),
    )
    .bind(obs.location_id, startIso, endIso)
    .run();

  return { hour, day };
}

export interface HourlyBucketUpdate {
  /** 'YYYY-MM-DD HH:00' label of the bucket that was updated. */
  hour: string;
  /** 'YYYY-MM-DD' UTC calendar day of the bucket. */
  day: string;
}

/**
 * Incremental daily row update: recompute ONLY the (location_id, day) row
 * affected by a new observation.
 *
 * Retention guard (A3): when every hourly bucket of `day` is guaranteed to
 * still exist (day at/after the retention cutoff), the row is derived from
 * the hourly table — a sargable PK-prefix scan of ≤24 rows
 * (`location_id = ? AND hour >= ? AND hour < ?`). For older late arrivals
 * the hourly buckets may have been pruned; deriving from the never-pruned
 * raw table keeps the daily row exact instead of truncating it (still
 * sargable via idx_weather_observations_location_time, ≤ ~288 rows).
 */
export async function updateDailyRow(
  db: D1Database,
  locationId: string,
  day: string,
  now: Date = new Date(),
): Promise<void> {
  const startMs = dayStartMs(day);
  const nextDay = dayLabelOf(new Date(startMs + DAY_MS));
  const retentionStartMs = now.getTime() - HOURLY_RETENTION_DAYS * DAY_MS;

  if (startMs >= retentionStartMs) {
    await db
      .prepare(
        dailyFromHourlyStatement(
          "WHERE location_id = ? AND hour >= ? AND hour < ?",
        ),
      )
      .bind(locationId, `${day} 00:00`, `${nextDay} 00:00`)
      .run();
  } else {
    await db
      .prepare(
        dailyFromRawStatement(
          "WHERE location_id = ? AND observed_at >= ? AND observed_at < ?",
        ),
      )
      .bind(
        locationId,
        new Date(startMs).toISOString(),
        new Date(startMs + DAY_MS).toISOString(),
      )
      .run();
  }
}

/**
 * Rollup REPAIR job: recompute a short recent window as defense-in-depth for
 * the best-effort incremental updates. Runs at most once per hour (guarded by
 * `shouldRunRollupRepair()`); the 5-minute hot path only performs O(bucket)
 * incremental updates.
 *
 * Every statement is sargable (EXPLAIN QUERY PLAN verified in
 * tests/incremental-rollups.test.ts):
 *
 * - Hourly (A1): iterates PER LOCATION with `location_id = ? AND
 *   observed_at >= ?`. A time-only bound cannot use any index (none leads
 *   with `observed_at`) and would full-scan the raw table — that monolithic
 *   form is rejected.
 * - Daily (A2): touched days are computed in TypeScript from the window
 *   bounds; each (location, day) pair is recomputed with bounds on the
 *   hourly PK. The previous `substr(hour,1,10) IN (SELECT DISTINCT ...)`
 *   form full-scanned the hourly table and is rejected.
 * - Retention: unchanged; sargable on idx_obs_hourly_hour.
 */
export async function rollupObservations(
  db: D1Database,
  windowHours: number = ROLLUP_WINDOW_HOURS,
  now: Date = new Date(),
): Promise<{ hourlyRows: number; dailyRows: number }> {
  const hours = Math.max(1, Math.min(24 * 30, Math.floor(windowHours)));
  const startIso = new Date(now.getTime() - hours * HOUR_MS).toISOString();

  const locations = await db
    .prepare("SELECT id FROM weather_locations")
    .all<{ id: string }>();
  const locationIds = (locations.results ?? []).map((r) => r.id);

  let hourlyRows = 0;
  for (const locationId of locationIds) {
    const res = await db
      .prepare(
        hourlyUpsertStatement("WHERE location_id = ? AND observed_at >= ?"),
      )
      .bind(locationId, startIso)
      .run();
    hourlyRows += res.meta.changes ?? 0;
  }

  // A2: daily derivation for the calendar days touched by the window. Days
  // are computed in TypeScript (no DISTINCT subquery); each statement is a
  // sargable PK-prefix scan of ≤24 hourly rows. Daily AVG columns are
  // weighted by observation_count so daily averages remain exact even when
  // hourly buckets contain different numbers of observations.
  let dailyRows = 0;
  for (const day of touchedDays(startIso, now.toISOString())) {
    const nextDay = dayLabelOf(new Date(dayStartMs(day) + DAY_MS));
    for (const locationId of locationIds) {
      const res = await db
        .prepare(
          dailyFromHourlyStatement(
            "WHERE location_id = ? AND hour >= ? AND hour < ?",
          ),
        )
        .bind(locationId, `${day} 00:00`, `${nextDay} 00:00`)
        .run();
      dailyRows += res.meta.changes ?? 0;
    }
  }

  // Retention: prune hourly aggregates older than HOURLY_RETENTION_DAYS.
  // This runs after the daily rollup so the daily table is always derived
  // before any hourly rows are removed. Only `weather_observations_hourly`
  // is affected — raw observations and daily aggregates are never deleted.
  // The cutoff is computed from the injected `now` (deterministic, consistent
  // with the repair window) and bound as an hour label — sargable on
  // idx_obs_hourly_hour (EXPLAIN: SEARCH ... USING INDEX idx_obs_hourly_hour).
  const retentionCutoff = new Date(now.getTime() - HOURLY_RETENTION_DAYS * DAY_MS);
  await db
    .prepare(`DELETE FROM weather_observations_hourly WHERE hour < ?`)
    .bind(hourLabelOf(retentionCutoff))
    .run();

  return { hourlyRows, dailyRows };
}