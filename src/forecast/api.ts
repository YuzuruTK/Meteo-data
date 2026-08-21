import { getForecast } from "./open-meteo";

/** Allowed origins for the dashboard API (mirrors src/dashboard/api.ts). */
const ALLOWED_ORIGINS =
  /^https?:\/\/localhost(:\d+)?$|^https:\/\/meteo-data-collector\.workers\.dev$/;

function json(body: unknown, status = 200, origin?: string | null): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "max-age=600", // client-side soft cache for 10 minutes
  };
  if (origin && ALLOWED_ORIGINS.test(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Handle GET /api/forecast. Returns a Response, or null if the path does not
 * match this handler (so the caller can fall through to other routes).
 *
 * Graceful degradation: if Open-Meteo is unavailable, returns a 502 with an
 * error body. The frontend treats a non-2xx response as "no forecast" and
 * proceeds without forecast overlays.
 */
export async function handleForecastApi(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");

  if (url.pathname !== "/api/forecast") {
    return null;
  }

  if (request.method !== "GET") {
    return json({ error: "Method Not Allowed" }, 405, origin);
  }

  try {
    const forecast = await getForecast();
    return json(forecast, 200, origin);
  } catch (error) {
    console.error("[forecast] failed to fetch Open-Meteo forecast", error);
    return json(
      { error: "Forecast temporarily unavailable" },
      502,
      origin,
    );
  }
}