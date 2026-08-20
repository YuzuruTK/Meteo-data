import type { D1Database } from "@cloudflare/workers-types";

/**
 * Rain-start detection for weather alerts.
 *
 * Uses the `weather_alert_state` table to remember the last known raining
 * status per station. A notification is emitted only on a dry -> rain
 * transition, so continuous rain never produces repeated alerts.
 */

export interface RainAlertMessage {
  title: string;
  body: string;
}

export interface RainCheckResult {
  /** Stations that just started raining (dry -> wet) and should be alerted. */
  alerts: Array<{ stationId: string; stationName: string; message: RainAlertMessage }>;
  /** All stations whose state was updated in this pass. */
  updated: number;
}

/**
 * Classify a precipitation rate (mm/h) into a rain intensity bucket used for
 * the notification copy.
 */
export function rainBucket(rateMmH: number): "light" | "moderate" | "heavy" {
  if (rateMmH < 2.5) return "light";
  if (rateMmH < 10) return "moderate";
  return "heavy";
}

/** Build the human-readable alert message for a station. */
export function buildRainMessage(
  stationName: string,
  rateMmH: number,
): RainAlertMessage {
  const bucket = rainBucket(rateMmH);
  const prefix =
    bucket === "light"
      ? "🌦️ Light rain started"
      : bucket === "moderate"
        ? "🌧️ Moderate rain started"
        : "⛈️ Heavy rain detected";
  const intensity =
    bucket === "light"
      ? "Light rain"
      : bucket === "moderate"
        ? "Moderate rain"
        : "Heavy rain";
  return {
    title: prefix,
    body: `${intensity} in ${stationName}.`,
  };
}

/**
 * Given the current observation state, persist the latest raining status and
 * return which stations crossed the dry -> wet threshold. Idempotent across
 * repeated runs while rain continues.
 */
export async function checkAndRecordRainState(
  db: D1Database,
  now: string,
  stations: Array<{
    stationId: string;
    stationName: string;
    rainRateMmH: number | null;
  }>,
): Promise<RainCheckResult> {
  const alerts: RainCheckResult["alerts"] = [];
  let updated = 0;

  for (const station of stations) {
    const raining = station.rainRateMmH !== null && station.rainRateMmH > 0;

    // Read previous state (transactionally per station).
    const previous = await db
      .prepare(
        `SELECT raining FROM weather_alert_state WHERE station_id = ?`,
      )
      .bind(station.stationId)
      .first<{ raining: number }>();

    const wasRaining = previous ? previous.raining === 1 : false;

    if (raining && !wasRaining) {
      alerts.push({
        stationId: station.stationId,
        stationName: station.stationName,
        message: buildRainMessage(station.stationName, station.rainRateMmH ?? 0),
      });
    }

    // Persist the new state.
    await db
      .prepare(
        `INSERT INTO weather_alert_state (station_id, raining, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(station_id) DO UPDATE SET raining = excluded.raining, updated_at = excluded.updated_at`,
      )
      .bind(station.stationId, raining ? 1 : 0, now)
      .run();

    updated++;
  }

  return { alerts, updated };
}