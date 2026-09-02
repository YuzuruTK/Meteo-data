import type { D1Database } from "@cloudflare/workers-types";
import type { NormalizedWeatherObservation } from "../collector/types";

/**
 * Materialized latest-state table for the rain alert pipeline
 * (`latest_weather_observations`).
 *
 * This table holds exactly one row per station and mirrors the most recent
 * observation for every location. It is maintained by the collector after
 * each successful observation insert, so the alert pipeline never has to
 * scan the full historical `weather_observations` table — a D1 row-read
 * hotspot that scaled with total history size (see migration 0007).
 */

/** Upsert the latest observation for a station into the latest-state table. */
export async function upsertLatestObservation(
  db: D1Database,
  obs: NormalizedWeatherObservation,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO latest_weather_observations (
         location_id, observed_at, precipitation_rate, temperature, humidity, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(location_id) DO UPDATE SET
         observed_at = excluded.observed_at,
         precipitation_rate = excluded.precipitation_rate,
         temperature = excluded.temperature,
         humidity = excluded.humidity,
         updated_at = excluded.updated_at
       -- Guard against out-of-order arrival: a late-arriving older
       -- observation must never overwrite a newer one.
       WHERE excluded.observed_at >= latest_weather_observations.observed_at`,
    )
    .bind(
      obs.location_id,
      obs.observed_at,
      obs.precipitation_rate,
      obs.temperature,
      obs.humidity,
      obs.collected_at,
    )
    .run();
}

export interface LatestStation {
  stationId: string;
  stationName: string;
  rainRateMmH: number | null;
}

/** Minutes after which a latest observation is considered stale for alerts. */
export const STALE_MINUTES = 15;

/**
 * Load stations with a fresh (non-stale) latest observation, ordered by name.
 *
 * Reads exclusively from the materialized `latest_weather_observations`
 * table — a constant number of rows (one per station) instead of a full
 * scan of the historical observation table.
 */
export async function loadLatestStations(
  db: D1Database,
): Promise<LatestStation[]> {
  const res = await db
    .prepare(
      `SELECT
         wl.id AS stationId,
         wl.name AS stationName,
         l.precipitation_rate AS rainRateMmH
       FROM latest_weather_observations l
       JOIN weather_locations wl
         ON wl.id = l.location_id
       WHERE l.observed_at >= datetime('now', '-${STALE_MINUTES} minutes')
       ORDER BY wl.name ASC`,
    )
    .all<LatestStation>();
  return res.results ?? [];
}
