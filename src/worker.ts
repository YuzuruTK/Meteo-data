import { loadEnabledSources } from "./config/config";
import { runCollection } from "./collector/collector";
import { handleApi } from "./dashboard/api";
import { handlePushApi } from "./push/api";
import { runRainAlerts, buildPushSendOptions } from "./push/alerts";
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

    // Public dashboard API.
    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      const response = await handleApi(request, env.DB);
      if (response) {
        return response;
      }
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

/** Load the latest precipitation rate + name for every station. */
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
       WHERE o.collected_at = (
         SELECT MAX(collected_at) FROM weather_observations
       )
       ORDER BY wl.name ASC`,
    )
    .all<{ stationId: string; stationName: string; rainRateMmH: number | null }>();
  return res.results ?? [];
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