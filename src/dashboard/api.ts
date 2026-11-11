import type { D1Database } from "@cloudflare/workers-types";
import { getHourlyAverages, getStations } from "./aggregate";
import { AGGREGATE_COLUMNS } from "./aggregate";
import { getDashboardSummaries } from "./summary";

function clampHours(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return Math.min(n, 24 * 30);
}

function readQuery(url: URL): { hours?: number; station?: string } {
  const hours = clampHours(url.searchParams.get("hours"));
  const station = url.searchParams.get("station")?.trim() || undefined;
  return { hours, station };
}

/** Allowed origins for the dashboard API. */
const ALLOWED_ORIGINS =
  /^https?:\/\/localhost(:\d+)?$|^https:\/\/meteo-data-collector\.workers\.dev$/;

function json(body: unknown, status = 200, origin?: string | null): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (origin && ALLOWED_ORIGINS.test(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function pathMatches(url: URL, path: string): boolean {
  return url.pathname === path;
}

/**
 * Route an API request. Returns a Response for recognized endpoints, or null
 * if the path is not handled by the dashboard API.
 *
 * `emergency` carries the D1 read-conservation flags (docs/emergency-d1-mode.md):
 * when `readOnlyEmergency` is true, the two expensive raw-scan endpoints are
 * answered with a 503 maintenance response WITHOUT touching D1.
 */
export async function handleApi(
  request: Request,
  db: D1Database,
  emergency: {
    readOnlyEmergency?: boolean;
    rainAvailable?: boolean;
    alertReason?: string;
  } = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");

  if (request.method !== "GET") {
    return json({ error: "Method Not Allowed" }, 405, origin);
  }

  const emergencyResponse = (): Response =>
    json(
      {
        maintenance: true,
        message: "Temporarily disabled due to database quota exhaustion",
      },
      503,
      origin,
    );

  if (pathMatches(url, "/api/stations")) {
    if (emergency.readOnlyEmergency) return emergencyResponse();
    const { hours } = readQuery(url);
    const stations =
      url.searchParams.get("includeInactive") === "true"
        ? (
            await db
              .prepare(
                `SELECT w.id,w.source_id,w.name,l.observed_at AS last_observed_at,
          CASE WHEN l.observed_at IS NULL OR datetime(l.observed_at)<datetime('now','-15 minutes') THEN 1 ELSE 0 END AS stale
          FROM weather_locations w LEFT JOIN latest_weather_observations l ON l.location_id=w.id ORDER BY w.name`,
              )
              .all()
          ).results
        : await getStations(db, { hours });
    return json({ stations }, 200, origin);
  }

  if (pathMatches(url, "/api/observations/aggregate")) {
    if (emergency.readOnlyEmergency) return emergencyResponse();
    const { hours, station } = readQuery(url);
    const aggregates = await getHourlyAverages(db, { hours, station });
    return json(
      {
        columns: AGGREGATE_COLUMNS,
        rows: aggregates,
        filters: { hours: hours ?? 24, station: station ?? null },
      },
      200,
      origin,
    );
  }

  if (pathMatches(url, "/api/summary")) {
    const summaries = await getDashboardSummaries(db);
    const events = emergency.rainAvailable
      ? (
          await db
            .prepare(
              `SELECT s.station_id,e.id,e.observed_at AS observedAt,e.detected_at AS detectedAt
      FROM weather_alert_state s JOIN rain_events e ON e.id=s.last_event_id
      WHERE s.raining=1 AND s.episode_started_observed_at=e.observed_at`,
            )
            .all<{
              station_id: string;
              id: string;
              observedAt: string;
              detectedAt: string;
            }>()
        ).results
      : [];
    return json(
      {
        summaries: summaries.map((s) => ({
          ...s,
          rainEvent: events.find((e) => e.station_id === s.location_id) ?? null,
        })),
        meta: {
          serverTime: new Date().toISOString(),
          staleAfterMinutes: 15,
          alerting: {
            rainAvailable: emergency.rainAvailable ?? false,
            reason: emergency.alertReason,
          },
        },
      },
      200,
      origin,
    );
  }

  return null;
}
