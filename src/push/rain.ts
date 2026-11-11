import type { D1Database } from "@cloudflare/workers-types";
import {
  evaluateRainTransition,
  type RainSample,
  type RainState,
} from "./transition";
import { FRESH_MS } from "../../shared/weather";
export { RAIN_THRESHOLD_MM_H } from "../../shared/weather";
export interface RainAlertMessage {
  title: string;
  body: string;
}
export interface RainCheckResult {
  alerts: Array<{
    stationId: string;
    stationName: string;
    message: RainAlertMessage;
  }>;
  updated: number;
}
export function rainBucket(rate: number): "light" | "moderate" | "heavy" {
  return rate < 2.5 ? "light" : rate < 10 ? "moderate" : "heavy";
}
export function buildRainMessage(name: string, rate: number): RainAlertMessage {
  const label = {
    light: "Light rain",
    moderate: "Moderate rain",
    heavy: "Heavy rain",
  }[rainBucket(rate)];
  return { title: `${label} detected`, body: `${label} in ${name}.` };
}
/** The winning state CAS and its event are committed in the same D1 batch. */
export async function checkAndRecordRainState(
  db: D1Database,
  now: string,
  stations: RainSample[],
  mode = "live",
): Promise<RainCheckResult> {
  const result: RainCheckResult = { alerts: [], updated: 0 };
  // Retry the entire small station set so a batch always groups simultaneous events.
  for (let attempt = 0; attempt < 3; attempt++) {
    const batchId = crypto.randomUUID();
    const writes = [];
    const candidates: Array<{
      sample: RainSample;
      event: boolean;
      index: number;
    }> = [];
    writes.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO push_batches(id,created_at,mode) VALUES (?,?,?)",
        )
        .bind(batchId, now, mode),
    );
    for (const sample of stations) {
      const previous = await db
        .prepare("SELECT * FROM weather_alert_state WHERE station_id=?")
        .bind(sample.stationId)
        .first<RainState>();
      const next = evaluateRainTransition(previous, sample, Date.parse(now));
      if (!next.state || next.state === previous) continue;
      const s = next.state,
        token = crypto.randomUUID();
      const index = writes.length;
      writes.push(
        db
          .prepare(
            `INSERT INTO weather_alert_state(station_id,raining,updated_at,last_processed_observed_at,last_valid_observed_at,dry_since_observed_at,dry_sample_count,episode_started_observed_at,last_event_id,version,transition_token)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(station_id) DO UPDATE SET
        raining=excluded.raining,updated_at=excluded.updated_at,last_processed_observed_at=excluded.last_processed_observed_at,
        last_valid_observed_at=excluded.last_valid_observed_at,dry_since_observed_at=excluded.dry_since_observed_at,
        dry_sample_count=excluded.dry_sample_count,episode_started_observed_at=excluded.episode_started_observed_at,
        last_event_id=excluded.last_event_id,version=excluded.version,transition_token=excluded.transition_token
        WHERE weather_alert_state.version=?`,
          )
          .bind(
            sample.stationId,
            s.raining,
            now,
            s.last_processed_observed_at,
            s.last_valid_observed_at,
            s.dry_since_observed_at,
            s.dry_sample_count,
            s.episode_started_observed_at,
            s.last_event_id,
            s.version,
            token,
            previous?.version ?? -1,
          ),
      );
      if (next.event)
        writes.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO rain_events(id,station_id,station_name,observed_at,detected_at,rate_mm_h,batch_id,expires_at)
        SELECT ?,?,?,?,?,?,?,? FROM weather_alert_state WHERE station_id=? AND transition_token=?`,
            )
            .bind(
              s.last_event_id,
              sample.stationId,
              sample.stationName,
              s.last_processed_observed_at,
              now,
              sample.rainRateMmH,
              batchId,
              new Date(
                Date.parse(s.last_processed_observed_at!) + FRESH_MS,
              ).toISOString(),
              sample.stationId,
              token,
            ),
        );
      candidates.push({ sample, event: next.event, index });
    }
    if (!candidates.length) return result;
    // Empty batches are terminal. Existing batches stay immutable after this transaction.
    writes.push(
      db
        .prepare(
          "UPDATE push_batches SET prepared=1 WHERE id=? AND NOT EXISTS (SELECT 1 FROM rain_events WHERE batch_id=?)",
        )
        .bind(batchId, batchId),
    );
    const results = await db.batch(writes);
    let conflict = false;
    for (const c of candidates) {
      if (!results[c.index]?.meta.changes) {
        conflict = true;
        continue;
      }
      result.updated++;
      if (c.event)
        result.alerts.push({
          stationId: c.sample.stationId,
          stationName: c.sample.stationName,
          message: buildRainMessage(
            c.sample.stationName,
            c.sample.rainRateMmH!,
          ),
        });
    }
    // A concurrent winner owns the event; a later cron will evaluate any newer sample.
    if (!conflict || result.alerts.length) break;
  }
  return result;
}
