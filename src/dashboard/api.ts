import type { D1Database } from "@cloudflare/workers-types";
import { getHourlyAverages, getPrecipitationSamples, getStations } from "./aggregate";
import { AGGREGATE_COLUMNS } from "./aggregate";
import { getDashboardSummaries } from "./summary";
import {
  COMPARISON_LOOKBACK_MINUTES,
  COMPARISON_TOLERANCE_MINUTES,
  getWeatherSourceComparisons,
} from "../db/comparisons";
import {
  EFFECTIVE_SOURCE_PRIORITY,
  EFFECTIVE_SOURCE_MAX_AGE_MINUTES,
  type EffectiveCurrentLocation,
  EFFECTIVE_VALUE_LIMITS,
  getEffectiveCurrentValues,
} from "../db/effective-current";

function clampHours(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return undefined;
  return Math.min(n, 24 * 30);
}

function readQuery(url: URL): { hours?: number; station?: string; stations?: string[] } {
  const hours = clampHours(url.searchParams.get("hours"));
  const stationValues = Array.from(new Set(
    url.searchParams.getAll("station").map((value) => value.trim()).filter(Boolean),
  ));
  const stations = stationValues.length > 0 ? stationValues : undefined;
  const station = stations?.length === 1 ? stations[0] : undefined;
  return { hours, station, stations };
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
 * when `readOnlyEmergency` is true, the raw-observation endpoints are
 * answered with a 503 maintenance response WITHOUT touching D1.
 */
export async function handleApi(
  request: Request,
  db: D1Database,
  emergency: { readOnlyEmergency?: boolean } = {},
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
    const stations = await getStations(db, { hours });
    return json({ stations }, 200, origin);
  }

  if (pathMatches(url, "/api/observations/aggregate")) {
    if (emergency.readOnlyEmergency) return emergencyResponse();
    const { hours, station, stations } = readQuery(url);
    const aggregates = await getHourlyAverages(db, { hours, station, stations });
    return json(
      {
        columns: AGGREGATE_COLUMNS,
        rows: aggregates,
        filters: {
          hours: hours ?? 24,
          station: station ?? null,
          stations: stations ?? (station ? [station] : null),
        },
      },
      200,
      origin,
    );
  }

  if (pathMatches(url, "/api/observations/precipitation")) {
    if (emergency.readOnlyEmergency) return emergencyResponse();
    const { hours, station, stations } = readQuery(url);
    const samples = await getPrecipitationSamples(db, { hours, station, stations });
    return json(
      {
        samples,
        filters: {
          hours: hours ?? 24,
          station: station ?? null,
          stations: stations ?? (station ? [station] : null),
        },
      },
      200,
      origin,
    );
  }

  if (pathMatches(url, "/api/quality/comparisons")) {
    if (emergency.readOnlyEmergency) return emergencyResponse();
    const comparisons = await getWeatherSourceComparisons(db);
    return json(
      {
        comparisons,
        filters: {
          time_tolerance_minutes: COMPARISON_TOLERANCE_MINUTES,
          lookback_minutes: COMPARISON_LOOKBACK_MINUTES,
          excluded_variables: ["precipitation_total", "precipitation_rate"],
        },
      },
      200,
      origin,
    );
  }

  if (pathMatches(url, "/api/summary")) {
    const summaries = await getDashboardSummaries(db);
    let effectiveCurrent: EffectiveCurrentLocation[] = [];
    try {
      effectiveCurrent = await getEffectiveCurrentValues(db);
    } catch (error) {
      // Keep the existing summaries contract available if the additive
      // cross-source read fails; the fallback result is best-effort.
      console.warn("[dashboard] effective current values unavailable", error);
    }
    return json(
      {
        summaries,
        effective_current: effectiveCurrent,
        effective_current_policy: {
          source_priority: EFFECTIVE_SOURCE_PRIORITY,
          max_age_minutes: EFFECTIVE_SOURCE_MAX_AGE_MINUTES,
          physical_limits: EFFECTIVE_VALUE_LIMITS,
          excluded_variables: ["precipitation_rate", "precipitation_total"],
        },
      },
      200,
      origin,
    );
  }

  return null;
}