import type { D1Database } from "@cloudflare/workers-types";

/**
 * Aggregation module: computes hourly average observations per station from
 * the D1 database. Archived from the raw `weather_observations` table and
 * joined against `weather_locations` to resolve station names.
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
}

/**
 * Compute hourly average per variable, grouped by station and hour.
 *
 * Observation timestamps are stored as ISO-8601 UTC strings; we truncate them
 * to the hour using SQLite's `strftime`, averaging each nullable column with
 * AVG (which ignores NULLs).
 */
export async function getHourlyAverages(
  db: D1Database,
  opts: AggregationOptions = {},
): Promise<HourlyAverageRow[]> {
  const hours = opts.hours ?? 24;
  const hoursClamped = Math.max(1, Math.min(24 * 30, Math.floor(hours)));

  const avgColumns = AGGREGATE_COLUMNS.map((c) => `AVG(o.${c}) AS ${c}_avg`).join(
    ", ",
  );

  const where: string[] = [
    `o.observed_at >= datetime('now', '-${hoursClamped} hours')`,
  ];
  const bindings: (string | number)[] = [];

  if (opts.station) {
    where.push("o.location_id = ?");
    bindings.push(opts.station);
  }

  const sql = `
    SELECT
      o.location_id AS station_id,
      wl.name AS station_name,
      strftime('%Y-%m-%d %H:00', o.observed_at) AS hour,
      ${avgColumns}
    FROM weather_observations o
    JOIN weather_locations wl ON wl.id = o.location_id
    WHERE ${where.join(" AND ")}
    GROUP BY o.location_id, hour
    ORDER BY hour ASC, station_name ASC
  `;

  const stmt = db.prepare(sql);
  const result = bindings.length > 0 ? stmt.bind(...bindings) : stmt;
  return result.all<HourlyAverageRow>().then((r) => r.results ?? []);
}

/**
 * List stations that have observations in the given lookback window, so the
 * dashboard can populate a selector. Falls back to all stations if there are
 * no observations in range.
 */
export async function getStations(
  db: D1Database,
  opts: { hours?: number } = {},
): Promise<StationRow[]> {
  const hours = opts.hours ?? 24;
  const hoursClamped = Math.max(1, Math.min(24 * 30, Math.floor(hours)));

  const recent = await db
    .prepare(
      `SELECT DISTINCT
         wl.id AS id,
         wl.source_id AS source_id,
         wl.name AS name
       FROM weather_observations o
       JOIN weather_locations wl ON wl.id = o.location_id
       WHERE o.observed_at >= datetime('now', '-${hoursClamped} hours')
       ORDER BY wl.name ASC, wl.id ASC`,
    )
    .all<StationRow>();

  if ((recent.results ?? []).length > 0) {
    return recent.results ?? [];
  }

  // Fallback: list every configured location, even if it has no observations yet.
  const all = await db
    .prepare(
      `SELECT id, source_id, name FROM weather_locations
       ORDER BY name ASC, id ASC`,
    )
    .all<StationRow>();

  return all.results ?? [];
}