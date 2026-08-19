import type { D1Database } from "@cloudflare/workers-types";
import type { NormalizedWeatherObservation } from "../collector/types";

export interface InsertObservationResult {
  inserted: boolean;
}

/**
 * Persist a normalized observation into weather_observations.
 *
 * Duplicate protection: the (source_id, location_id, observed_at) unique
 * constraint plus INSERT OR IGNORE makes retried runs idempotent — the same
 * observation cannot be inserted twice.
 */
export async function insertObservation(
  db: D1Database,
  obs: NormalizedWeatherObservation,
): Promise<InsertObservationResult> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO weather_observations (
        id, source_id, location_id, observed_at,
        temperature, solar_radiation, humidity, pressure,
        wind_speed, wind_direction, wind_gust,
        precipitation_rate, precipitation_total,
        uv_index, cloud_cover, visibility, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      obs.source_id + ":" + obs.location_id + ":" + obs.observed_at,
      obs.source_id,
      obs.location_id,
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
      obs.collected_at,
    )
    .run();

  return { inserted: (result.meta.changes ?? 0) > 0 };
}