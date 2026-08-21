import { loadEnabledSources } from "./config/config";
import { runCollection } from "./collector/collector";
import { handleApi } from "./dashboard/api";
import { handleForecastApi } from "./forecast/api";
import { handlePushApi } from "./push/api";
import { runRainAlerts, buildPushSendOptions } from "./push/alerts";
import { sendPushNotifications } from "./push/send";
import type { Env } from "./db/types";

const TRIGGER_HEADER = "x-collector-trigger";

export default { /* unchanged omitted for brevity in commit */ };

async function maybeRunRainAlerts(env: Env): Promise<void> {
  const pushOptions = buildPushSendOptions(env);
  if (!pushOptions) return;
  const stations = await loadLatestStations(env.DB);
  await runRainAlerts({ db: env.DB, vapid: pushOptions, stations });
}

async function loadLatestStations(
  db: Env["DB"],
): Promise<Array<{ stationId: string; stationName: string; rainRateMmH: number | null }>> {
  const res = await db.prepare(`SELECT
      wl.id AS stationId,
      wl.name AS stationName,
      o.precipitation_rate AS rainRateMmH
    FROM weather_locations wl
    JOIN weather_observations o
      ON o.location_id = wl.id
    WHERE o.collected_at = (
      SELECT MAX(o2.collected_at)
      FROM weather_observations o2
      WHERE o2.location_id = wl.id
    )
    ORDER BY wl.name ASC`).all<{ stationId: string; stationName: string; rainRateMmH: number | null }>();
  return res.results ?? [];
}