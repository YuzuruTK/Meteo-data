import type { D1Database } from "@cloudflare/workers-types";

/**
 * Aggregation module: computes hourly average observations per station from
 * the D1 database.
 *
 * READ-PATH OPTIMIZATION (perf/read-path-rollup-tables):
 *
 * Both queries previously aggregated the raw `weather_observations` table
 * with a non-sargable `datetime(observed_at)` predicate, forcing a full
 * table scan (~15.4k+ rows) on every request — see
 * docs/performance-rollups-analysis.md §3 (hotspots C2 and H1).
 *
 * They now read from the materialized tables maintained by the collector:
 *   - `getHourlyAverages()`  → `weather_observations_hourly`  (~rows read:
 *     stations × hours instead of the full raw history)
 *   - `getStations()`        → `latest_weather_observations`  (one row per
 *     station instead of a full raw-history scan)
 *
 * Rollup generation (src/db/rollups.ts) and the schema are unchanged.
 */

/** All numeric meteorological columns that can be aggregated. */
export const AGGREGATE_COLUMNS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_direction",
  "wind_gust",
  "precipitation_rate",
  "precipitation_total",
  "uv_index",
  "cloud_cover",
  "visibility",
] as const;

export type AggregateColumn = (typeof AGGREGATE_COLUMNS)[number];

/** One hourly-average row for a single station. */
export interface HourlyAverageRow {
  station_id: string;
  station_name: string;
  /** Hour bucket label, e.g. "2025-01-01 14:00". */
  hour: string;
  temperature_avg: number | null;
  solar_radiation_avg: number | null;
  humidity_avg: number | null;
  pressure_avg: number | null;
  wind_speed_avg: number | null;
  wind_direction_avg: number | null;
  wind_gust_avg: number | null;
  precipitation_rate_avg: number | null;
  precipitation_total_avg: number | null;
  uv_index_avg: number | null;
  cloud_cover_avg: number | null;
  visibility_avg: number | null;
}

export interface AggregationOptions {
  /** Number of recent hours to include. Defaults to 24. */
  hours?: number;
  /** Filter to a single station (weather_locations.id). */
  station?: string;
}

export interface StationRow {
  id: string;
  source_id: string;
  name: string;
  /** ISO-8601 timestamp of the most recent observation for this station. */
  last_observed_at: string | null;
  /** True when the most recent observation is older than the stale threshold. */
  stale: boolean;
}

/**
 * Compute hourly average per variable, grouped by station and hour.
 *
 * Reads the materialized `weather_observations_hourly` rollup (maintained by
 * the collector after each collection cycle, see src/db/rollups.ts) instead
 * of scanning raw observations. The window filter compares the `hour` column
 * directly against `strftime('%Y-%m-%d %H:00', ...)` output — same text
 * format, sargable on `idx_obs_hourly_hour`.
 *
 * `precipitation_total_avg` is derived as
 * `precipitation_total_sum / observation_count`, matching the raw
 * `AVG(precipitation_total)` semantics when the value is present in every
 * observation of the bucket. If some bucket rows lack `precipitation_total`,
 * this differs slightly from a raw AVG, which ignores NULL rows — a
 * documented, accepted trade-off of the rollup schema (see
 * docs/performance-rollups-analysis.md §4.4).
 */
export async function getHourlyAverages(
  db: D1Database,
  opts: AggregationOptions = {},
): Promise<HourlyAverageRow[]> {
  const hours = opts.hours ?? 24;
  const hoursClamped = Math.max(1, Math.min(24 * 30, Math.floor(hours)));

  const where: string[] = [
    // `hour` is stored as "YYYY-MM-DD HH:00" (UTC) and strftime() emits the
    // same format, so this is a correct lexicographic range comparison AND a
    // sargable index range scan on idx_obs_hourly_hour. (Comparing a stored
    // ISO-8601 string against datetime() output lexicographically would be
    // wrong — 'T' > ' ' — which is why the raw-table queries wrapped the
    // column in datetime(); the rollup's hour format needs no such wrap.)
    `h.hour >= strftime('%Y-%m-%d %H:00', 'now', '-${hoursClamped} hours')`,
  ];
  const bindings: (string | number)[] = [];

  if (opts.station) {
    where.push("h.location_id = ?");
    bindings.push(opts.station);
  }

  const sql = `
    SELECT
      h.location_id AS station_id,
      wl.name AS station_name,
      h.hour,
      h.temperature_avg AS temperature_avg,
      h.solar_radiation_avg AS solar_radiation_avg,
      h.humidity_avg AS humidity_avg,
      h.pressure_avg AS pressure_avg,
      h.wind_speed_avg AS wind_speed_avg,
      h.wind_direction_avg AS wind_direction_avg,
      h.wind_gust_avg AS wind_gust_avg,
      h.precipitation_rate_avg AS precipitation_rate_avg,
      CASE WHEN h.observation_count = 0 THEN NULL
           ELSE h.precipitation_total_sum / h.observation_count
      END AS precipitation_total_avg,
      h.uv_index_avg AS uv_index_avg,
      h.cloud_cover_avg AS cloud_cover_avg,
      h.visibility_avg AS visibility_avg
    FROM weather_observations_hourly h
    JOIN weather_locations wl ON wl.id = h.location_id
    WHERE ${where.join(" AND ")}
    ORDER BY h.hour ASC, station_name ASC
  `;

  const stmt = db.prepare(sql);
  const result = bindings.length > 0 ? stmt.bind(...bindings) : stmt;
  return result.all<HourlyAverageRow>().then((r) => r.results ?? []);
}

/** Default stale threshold in minutes. */
export const DEFAULT_STALE_MINUTES = 15;


/**
 * List stations that have observations in the given lookback window, so the
 * dashboard can populate a selector. Falls back to all stations if there are
 * no observations in range.
 *
 * Each station includes `last_observed_at` (the most recent observation
 * timestamp) and a `stale` flag that is true when the latest observation is
 * older than `staleMinutes` (default 15).
 *
 * Reads the materialized `latest_weather_observations` table (one row per
 * station, maintained by the collector after every successful insert — see
 * src/db/latest.ts and migration 0007) instead of computing MAX(observed_at)
 * over the raw history. The table only carries rows for stations that have
 * at least one observation, so "no rows in the window" falls back to the
 * configured location list exactly as before.
 */
export async function getStations(
  db: D1Database,
  opts: { hours?: number; staleMinutes?: number } = {},
): Promise<StationRow[]> {
  const hours = opts.hours ?? 24;
  const hoursClamped = Math.max(1, Math.min(24 * 30, Math.floor(hours)));
  const staleMinutes = opts.staleMinutes ?? DEFAULT_STALE_MINUTES;

  const recent = await db
    .prepare(
      `SELECT
         wl.id AS id,
         wl.source_id AS source_id,
         wl.name AS name,
         l.observed_at AS last_observed_at,
         CASE
           -- datetime() normalizes the stored ISO-8601 UTC string before
           -- comparison; a raw lexicographic ISO-vs-datetime() comparison
           -- would never flag a same-day observation as stale (see
           -- docs/MIGRATIONS.md and tests/timestamp-comparison.test.ts).
           WHEN datetime(l.observed_at) < datetime('now', '-${staleMinutes} minutes') THEN 1
           ELSE 0
         END AS stale
       FROM latest_weather_observations l
       JOIN weather_locations wl ON wl.id = l.location_id
       WHERE datetime(l.observed_at) >= datetime('now', '-${hoursClamped} hours')
       ORDER BY wl.name ASC, wl.id ASC`,
    )
    .all<{ id: string; source_id: string; name: string; last_observed_at: string | null; stale: number }>();

  const results = (recent.results ?? []).map((r) => ({
    id: r.id,
    source_id: r.source_id,
    name: r.name,
    last_observed_at: r.last_observed_at,
    stale: r.stale === 1,
  }));

  if (results.length > 0) {
    return results;
  }

  // Fallback: list every configured location, even if it has no observations yet.
  const all = await db
    .prepare(
      `SELECT id, source_id, name FROM weather_locations
       ORDER BY name ASC, id ASC`,
    )
    .all<{ id: string; source_id: string; name: string }>();

  return (all.results ?? []).map((r) => ({
    id: r.id,
    source_id: r.source_id,
    name: r.name,
    last_observed_at: null,
    stale: false,
  }));
}
