import { loadEnabledSources } from "./config/config";
import { runCollection } from "./collector/collector";
import { handleApi } from "./dashboard/api";
import { handleForecastApi } from "./forecast/api";
import { handlePushApi } from "./push/api";
import { runRainAlerts, buildPushSendOptions } from "./push/alerts";
import { sendPushNotifications } from "./push/send";
import type { Env } from "./db/types";

/**
 * Weather data collector Worker.
 *
 * Handlers:
 *  - `scheduled`: runs every 5 minutes (cron: every-5-minutes).
 *  - `fetch`: routes the public dashboard API, the protected manual trigger,
 *    push subscription management, and (via static assets) the dashboard UI.
 *
 * The scheduled handler awaits the collection directly (not only waitUntil)
 * so Cloudflare can track completion and surface failures.
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

    // After a successful collection, evaluate rain alerts.
    if (run.requests_succeeded > 0) {
      await maybeRunRainAlerts(env);
    }
  },

  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    // Forecast API (Open-Meteo). Independent of observations; handles its own
    // caching and graceful degradation.
    if (url.pathname === "/api/forecast") {
      const forecastResponse = await handleForecastApi(request);
      if (forecastResponse) {
        return forecastResponse;
      }
    }

    // Public dashboard API.
    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      const response = await handleApi(request, env.DB);
      if (response) {
        return response;
      }
    }

    // Secret-protected push test trigger.
    if (url.pathname === "/api/push/test" && request.method === "POST") {
      return handlePushTest(request, env);
    }

    // Push subscription management endpoints.
    if (url.pathname.startsWith("/api/push")) {
      const pushResponse = await handlePushApi(request, {
        DB: env.DB,
        VAPID_PUBLIC_KEY: env.VAPID_PUBLIC_KEY,
      });
      if (pushResponse) {
        return pushResponse;
      }
    }

    // Unrecognized /api route.
    if (url.pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    // Authenticated manual collection trigger (POST with secret header).
    if (request.method === "POST") {
      return handleTrigger(request, env);
    }

    // Any other GET is handled by static assets (dashboard SPA).
    return env.ASSETS.fetch(request);
  },
};

/** Run rain alerts after collection if VAPID is configured. */
async function maybeRunRainAlerts(env: Env): Promise<void> {
  const pushOptions = buildPushSendOptions(env);
  if (!pushOptions) {
    console.log("[worker] VAPID keys not configured; skipping rain alerts");
    return;
  }

  // Gather the latest rain rate per station from the last observations.
  const stations = await loadLatestStations(env.DB);
  const result = await runRainAlerts({
    db: env.DB,
    vapid: pushOptions,
    stations,
  });
  console.log(
    `[worker] rain alerts: ${result.alertsFired} fired, ` +
      `${result.notificationsSent} sent, ${result.notificationsRemoved} removed`,
  );
}

/** Stale threshold in minutes — stations whose latest observation is older
 * than this are excluded from rain alerts. */
const STALE_MINUTES = 15;

/** Load the latest precipitation rate + name for every station.
 *
 * Uses a latest-observation-per-station query so that stations whose most
 * recent observation arrived in a different collection batch are never
 * omitted.  The correlated subquery on `observed_at` picks the single most
 * recent row for each `location_id`.
 *
 * Stations whose latest observation is older than `STALE_MINUTES` are
 * excluded from the result set so stale data never triggers a rain alert.
 */
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

/**
 * Secret-protected test trigger: sends a sample notification to every stored
 * subscription so the push pipeline can be verified end-to-end without waiting
 * for real rain. Uses the same `x-collector-trigger` secret as the manual
 * collection trigger.
 */
async function handlePushTest(request: Request, env: Env): Promise<Response> {
  const secret = env.COLLECTOR_TRIGGER_SECRET;
  if (secret) {
    const provided = request.headers.get(TRIGGER_HEADER);
    if (provided !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    return new Response("Forbidden", { status: 403 });
  }

  const pushOptions = buildPushSendOptions(env);
  if (!pushOptions) {
    return Response.json(
      { error: "VAPID keys are not configured" },
      { status: 500 },
    );
  }

  const delivery = await sendPushNotifications(
    env.DB,
    pushOptions,
    {
      title: "🧪 Test notification",
      body: "This is a test push from the Meteo dashboard.",
      data: { url: "/" },
    },
  );

  return Response.json({
    sent: delivery.sent,
    removed: delivery.removed,
    errors: delivery.errors,
  });
}

/** Handle the authenticated manual collection trigger. */
async function handleTrigger(request: Request, env: Env): Promise<Response> {
  const secret = env.COLLECTOR_TRIGGER_SECRET;
  if (secret) {
    const provided = request.headers.get(TRIGGER_HEADER);
    if (provided !== secret) {
      return new Response("Unauthorized", { status: 401 });
    }
  } else {
    // If no secret is configured, do not expose a trigger endpoint.
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const sources = loadEnabledSources();
  const run = await runCollection(sources, env);

  if (run.requests_succeeded > 0) {
    await maybeRunRainAlerts(env);
  }

  return Response.json({
    run_id: run.id,
    status: run.status,
    requests_attempted: run.requests_attempted,
    requests_succeeded: run.requests_succeeded,
    requests_failed: run.requests_failed,
  });
}