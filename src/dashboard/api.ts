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
 */
export async function handleApi(
  request: Request,
  db: D1Database,
): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");

  if (request.method !== "GET") {
    return json({ error: "Method Not Allowed" }, 405, origin);
  }

  if (pathMatches(url, "/api/stations")) {
    const { hours } = readQuery(url);
    const stations = await getStations(db, { hours });
    return json({ stations }, 200, origin);
  }

  if (pathMatches(url, "/api/observations/aggregate")) {
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
    return json({ summaries }, 200, origin);
  }

  return null;
}