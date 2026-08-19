import { loadEnabledSources } from "./config/config";
import { runCollection } from "./collector/collector";
import { handleApi } from "./dashboard/api";
import type { Env } from "./db/types";

/**
 * Weather data collector Worker.
 *
 * Handlers:
 *  - `scheduled`: runs every 5 minutes (cron: every-5-minutes).
 *  - `fetch`: routes the public dashboard API, the protected manual trigger,
 *    and (via static assets) the dashboard UI.
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
  },

  fetch: async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url);

    // Public read-only dashboard API.
    if (url.pathname.startsWith("/api/")) {
      const response = await handleApi(request, env.DB);
      if (response) {
        return response;
      }
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

/** Handle the authenticated manual collection trigger (unchanged behavior). */
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
  return Response.json({
    run_id: run.id,
    status: run.status,
    requests_attempted: run.requests_attempted,
    requests_succeeded: run.requests_succeeded,
    requests_failed: run.requests_failed,
  });
}