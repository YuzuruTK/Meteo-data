import { loadEnabledSources } from "./config/config";
import { runCollection } from "./collector/collector";
import { handleApi } from "./dashboard/api";
import { handleForecastApi } from "./forecast/api";
import { getForecast } from "./forecast/open-meteo";
import { handlePushApi } from "./push/api";
import { runRainAlerts, buildPushSendOptions } from "./push/alerts";
import { getForecastAlertConfig, runForecastAlerts } from "./push/forecast";
import { sendPushNotifications } from "./push/send";
import type { Env } from "./db/types";

/**
 * Weather data collector Worker.
 *
 * Handlers:
 *  - `scheduled`: runs every 5 minutes (cron: every-5-minutes).
 *  - `fetch`: routes the public dashboard API, the protected manual trigger,
 *    push subscription management, and (via static assets) the dashboard UI.
 */

const TRIGGER_HEADER = "x-collector-trigger";

export default {
  scheduled: async (controller: ScheduledController, env: Env): Promise<void> => {
    console.log(`[worker] scheduled collection triggered (${controller.cron})`);
    const sources = loadEnabledSources();
    const run = await runCollection(sources, env);
    console.log(
      `[worker] run ${run.id} finished: ${run.status} ` +
        `(${run.requests_succeeded} ok / ${run.requests_failed} failed)`,
    );

    if (run.requests_succeeded > 0) {
      await maybeRunWeatherAlerts(env);
    }
  },

  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/api/forecast") {
      const forecastResponse = await handleForecastApi(request);
      if (forecastResponse) return forecastResponse;
    }

    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      const response = await handleApi(request, env.DB);
      if (response) return response;
    }

    if (url.pathname === "/api/push/test" && request.method === "POST") {
      return handlePushTest(request, env);
    }

    if (url.pathname.startsWith("/api/push")) {
      const pushResponse = await handlePushApi(request, {
        DB: env.DB,
        VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
      });
      if (pushResponse) return pushResponse;
    }

    if (url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method === "POST") {
      return handleTrigger(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};

/** Evaluate observation and forecast alerts after a successful collection. */
async function maybeRunWeatherAlerts(env: Env): Promise<void> {
  const pushOptions = buildPushSendOptions(env);
  if (!pushOptions) {
    console.log("[worker] VAPID keys not configured; skipping weather alerts");
    return;
  }

  const stations = await loadLatestStations(env.DB);
  const rainResult = await runRainAlerts({
    db: env.DB,
    vapid: pushOptions,
    stations,
  });
  console.log(
    `[worker] rain alerts: ${rainResult.alertsFired} fired, ` +
      `${rainResult.notificationsSent} sent, ${rainResult.notificationsRemoved} removed`,
  );

  try {
    // Uses the same cached Open-Meteo forecast already exposed by /api/forecast,
    // avoiding an external request for every alert evaluation.
    const forecast = await getForecast();
    const forecastResult = await runForecastAlerts(
      env.DB,
      pushOptions,
      forecast.hourly,
      getForecastAlertConfig(env),
    );
    console.log(
      `[worker] forecast alerts: ${forecastResult.alertsFired} fired, ` +
        `${forecastResult.notificationsSent} sent, ${forecastResult.notificationsRemoved} removed`,
    );
  } catch (error) {
    // Forecast failure must not break the observation alert pipeline or the
    // scheduled collection cycle.
    console.error("[worker] forecast alerts skipped", error);
  }
}

const STALE_MINUTES = 15;

async function loadLatestStations(
  db: Env["DB"],
): Promise<Array<{ stationId: string; stationName: string; rainRateMmH: number | null }>> {
  const res = await db
    .prepare(
      `SELECT
         wl.id AS stationId,
         wl.name AS stationName,
         o.precipitation_rate AS rainRateMmH
       FROM weather_observations o
       JOIN weather_locations wl ON wl.id = o.location_id
       WHERE o.observed_at = (
         SELECT MAX(o2.observed_at)
         FROM weather_observations o2
         WHERE o2.location_id = o.location_id
       )
         AND o.observed_at >= datetime('now', '-${STALE_MINUTES} minutes')
       ORDER BY wl.name ASC`,
    )
    .all<{ stationId: string; stationName: string; rainRateMmH: number | null }>();
  return res.results ?? [];
}

async function handlePushTest(request: Request, env: Env): Promise<Response> {
  const secret = env.COLLECTOR_TRIGGER_SECRET;
  if (secret) {
    const provided = request.headers.get(TRIGGER_HEADER);
    if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  } else {
    return new Response("Forbidden", { status: 403 });
  }

  const pushOptions = buildPushSendOptions(env);
  if (!pushOptions) {
    return Response.json({ error: "VAPID keys are not configured" }, { status: 500 });
  }

  const delivery = await sendPushNotifications(env.DB, pushOptions, {
    title: "🧪 Test notification",
    body: "This is a test push from the Meteo dashboard.",
    data: { url: "/" },
  });

  return Response.json({ sent: delivery.sent, removed: delivery.removed, errors: delivery.errors });
}

async function handleTrigger(request: Request, env: Env): Promise<Response> {
  const secret = env.COLLECTOR_TRIGGER_SECRET;
  if (secret) {
    const provided = request.headers.get(TRIGGER_HEADER);
    if (provided !== secret) return new Response("Unauthorized", { status: 401 });
  } else {
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const sources = loadEnabledSources();
  const run = await runCollection(sources, env);
  if (run.requests_succeeded > 0) await maybeRunWeatherAlerts(env);

  return Response.json({
    run_id: run.id,
    status: run.status,
    requests_attempted: run.requests_attempted,
    requests_succeeded: run.requests_succeeded,
    requests_failed: run.requests_failed,
  });
}
