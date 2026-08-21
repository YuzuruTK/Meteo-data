import type { D1Database } from "@cloudflare/workers-types";
import type { NormalizedWeatherObservation } from "../collector/types";

/**
 * Precomputed dashboard summary maintenance.
 *
 * After each successful observation insert the collector calls
 * `updateDashboardSummary` to keep the `dashboard_summary` table in sync with
 * the latest values per station.  The table is a 1:1 mirror of the most recent
 * observation for every location, keyed by `location_id`.
 */

export interface DashboardSummaryRow {
  location_id: string;
  station_name: string;
  observed_at: string;
  temperature: number | null;
  solar_radiation: number | null;
  humidity: number | null;
  pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gust: number | null;
  precipitation_rate: number | null;
  precipitation_total: number | null;
  uv_index: number | null;
  cloud_cover: number | null;
  visibility: number | null;
  updated_at: string;
}

/**
 * Upsert the latest observation into `dashboard_summary`.  Called by the
 * collector after a successful insert, regardless of whether the observation
 * was newly inserted or deduplicated (we still want the latest values).
 */
export async function updateDashboardSummary(
  db: D1Database,
  obs: NormalizedWeatherObservation,
  stationName: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO dashboard_summary (
         location_id, station_name, observed_at,
         temperature, solar_radiation, humidity, pressure,
         wind_speed, wind_direction, wind_gust,
         precipitation_rate, precipitation_total,
         uv_index, cloud_cover, visibility, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(location_id) DO UPDATE SET
         station_name = excluded.station_name,
         observed_at = excluded.observed_at,
         temperature = excluded.temperature,
         solar_radiation = excluded.solar_radiation,
         humidity = excluded.humidity,
         pressure = excluded.pressure,
         wind_speed = excluded.wind_speed,
         wind_direction = excluded.wind_direction,
         wind_gust = excluded.wind_gust,
         precipitation_rate = excluded.precipitation_rate,
         precipitation_total = excluded.precipitation_total,
         uv_index = excluded.uv_index,
         cloud_cover = excluded.cloud_cover,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`,
    )
    .bind(
      obs.location_id,
      stationName,
      obs.observed_at,
      obs.temperature,
      obs.solar_radiation,
      obs.humidity,
      obs.pressure,
      obs.wind_speed,
      obs.wind_direction,
      obs.wind_gust,
      obs.precipitation_rate,
      obs.precipitation_total,
      obs.uv_index,
      obs.cloud_cover,
      obs.visibility,
      now,
    )
    .run();
}

/**
 * Read all dashboard summaries, ordered by station name.
 */
export async function getDashboardSummaries(
  db: D1Database,
): Promise<DashboardSummaryRow[]> {
  const result = await db
    .prepare(
      `SELECT
         location_id, station_name, observed_at,
         temperature, solar_radiation, humidity, pressure,
         wind_speed, wind_direction, wind_gust,
         precipitation_rate, precipitation_total,
         uv_index, cloud_cover, visibility, updated_at
       FROM dashboard_summary
       ORDER BY station_name ASC`,
    )
    .all<DashboardSummaryRow>();
  return result.results ?? [];
}