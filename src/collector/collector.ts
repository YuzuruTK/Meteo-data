import type { D1Database } from "@cloudflare/workers-types";
import { buildRequest, timeoutMsFor, DEFAULT_TIMEOUT_MS } from "./request";
import { normalizeObservation } from "./normalize";
import type {
  CollectionRun,
  NormalizedWeatherObservation,
  WeatherSourceConfig,
  WeatherSourcesConfig,
} from "./types";
import { upsertLocation } from "../db/locations";
import { insertObservation } from "../db/observations";
import { upsertLatestObservation } from "../db/latest";
import { createRun, finishRun, logRequest } from "../db/runs";
import { updateDashboardSummary } from "../dashboard/summary";
import { rollupObservations } from "../db/rollups";

/**
 * Collection orchestration.
 *
 * Runs the config-driven pipeline for all enabled sources/locations with:
 *  - controlled concurrency (default 3)
 *  - failure isolation (a failed API/location does not abort others)
 *  - run + per-request logging into D1
 *  - secret interpolation from the env bindings
 *  - timeout handling via AbortController
 *  - duplicate protection (INSERT OR IGNORE on the logical key)
 */

export interface CollectorEnv {
  DB: D1Database;
  [key: string]: unknown;
}

export interface CollectorOptions {
  now?: Date;
  concurrency?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CONCURRENCY = 3;

export async function runCollection(
  sources: WeatherSourcesConfig,
  env: CollectorEnv,
  opts: CollectorOptions = {},
): Promise<CollectionRun> {
  const now = opts.now ?? new Date();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const enabledSources = sources.filter((s) => s.enabled);
  const startedAt = now.toISOString();
  const runId = crypto.randomUUID();

  await createRun(env.DB, {
    id: runId,
    startedAt,
    sourcesAttempted: enabledSources.length,
  });

  // Flatten all (source, location) tasks for controlled concurrency.
  type Task = { source: WeatherSourceConfig; locationIndex: number };
  const tasks: Task[] = [];
  for (const source of enabledSources) {
    for (let i = 0; i < source.locations.length; i++) {
      tasks.push({ source, locationIndex: i });
    }
  }

  let requestsAttempted = 0;
  let requestsSucceeded = 0;
  let requestsFailed = 0;
  const attempts: CollectionRun["requests"] = [];

  // Process tasks with bounded concurrency, preserving order in `attempts`.
  const results = await mapWithConcurrency(tasks, concurrency, async (task) => {
    const source = task.source;
    const location = source.locations[task.locationIndex]!;
    const result = await collectOne(source, location, env, runId, fetchImpl, opts.now ?? now);
    requestsAttempted++;
    if (result.status === "success") requestsSucceeded++;
    else requestsFailed++;
    return result;
  });

  attempts.push(...results);

  const status: CollectionRun["status"] =
    requestsSucceeded > 0 && requestsFailed > 0
      ? "partial"
      : requestsSucceeded > 0
        ? "success"
        : "failed";

  const finishedAt = new Date(now.getTime() + 10).toISOString();
  await finishRun(env.DB, {
    id: runId,
    finishedAt,
    status,
    requestsAttempted,
    requestsSucceeded,
    requestsFailed,
  });

  // Maintain historical rollups (hourly + daily). Best-effort: a rollup
  // failure must not fail the collection run.
  // Emergency D1 read conservation (docs/emergency-d1-mode.md): the rollup
  // is the single largest read consumer (~17k rows/cycle). DISABLE_ROLLUPS
  // skips it entirely; absent/unset keeps default behavior unchanged.
  if (requestsSucceeded > 0 && env.DISABLE_ROLLUPS !== "true") {
    try {
      await rollupObservations(env.DB);
    } catch (rollupErr) {
      console.warn(`[collector] observation rollup failed: ${errMessage(rollupErr)}`);
    }
  }

  return {
    id: runId,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    sources_attempted: enabledSources.length,
    requests_attempted: requestsAttempted,
    requests_succeeded: requestsSucceeded,
    requests_failed: requestsFailed,
    requests: attempts,
  };
}

/**
 * Collect for one source+location: build request, fetch with timeout,
 * normalize, persist.
 */
async function collectOne(
  source: WeatherSourceConfig,
  location: WeatherSourceConfig["locations"][number],
  env: CollectorEnv,
  runId: string,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<CollectionRun["requests"][number]> {
  const requestedAt = now.toISOString();
  const start = Date.now();

  const fail = async (
    error: string,
    httpStatus?: number,
  ): Promise<CollectionRun["requests"][number]> => {
    const finishedAt = new Date().toISOString();
    const responseTimeMs = Date.now() - start;
    console.warn(
      `[collector] ${source.id} / ${location.id} failed: ${error} (http=${httpStatus ?? "-"})`,
    );
    await logRequest(env.DB, {
      id: crypto.randomUUID(),
      runId,
      sourceId: source.id,
      locationId: location.id,
      requestedAt,
      finishedAt,
      status: "failed",
      httpStatus,
      responseTimeMs,
      error,
    });
    return {
      source_id: source.id,
      location_id: location.id,
      status: "failed",
      http_status: httpStatus,
      response_time_ms: responseTimeMs,
      error,
    };
  };

  // Build a string-only context for secret interpolation (ignore non-string bindings).
  const requestContext: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      requestContext[key] = value;
    }
  }

  // 1. Build request (may throw on missing secrets/location param).
  let request;
  try {
    request = buildRequest(source.request, location, requestContext);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  // 2. Fetch with timeout.
  const controller = new AbortController();
  const timeoutMs = timeoutMsFor(source.request);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return fail(aborted ? `Request timed out after ${timeoutMs}ms` : errMessage(err));
  } finally {
    clearTimeout(timer);
  }

  const httpStatus = response.status;
  if (!response.ok) {
    // Capture the upstream error body (truncated) to aid diagnosis.
    let detail = "";
    try {
      const text = await response.text();
      if (text) {
        detail = ` - ${text.slice(0, 300)}`;
      }
    } catch {
      // ignore body read errors
    }
    return fail(`HTTP error ${httpStatus}${detail}`, httpStatus);
  }

  // 3. Parse JSON.
  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch {
    return fail("Response was not valid JSON", httpStatus);
  }

  // 4. Normalize.
  let observation: NormalizedWeatherObservation;
  try {
    observation = normalizeObservation(rawBody, source.normalization, {
      sourceId: source.id,
      locationId: location.id,
      collectedAt: requestedAt,
    });
  } catch (err) {
    return fail(
      err instanceof Error ? `Normalization failed: ${err.message}` : "Normalization failed",
      httpStatus,
    );
  }

  // 5. Upsert location metadata (enrich only where config lacks coords).
  try {
    const externalId = String(location[source.request.location_param ?? "id"] ?? location.id);
    await upsertLocation(env.DB, {
      id: location.id,
      sourceId: source.id,
      externalId,
      name: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      now: requestedAt,
    });
  } catch (err) {
    return fail(`Location upsert failed: ${errMessage(err)}`, httpStatus);
  }

  // 6. Persist observation (duplicate-safe).
  try {
    const stored = await insertObservation(env.DB, observation);
    const finishedAt = new Date().toISOString();
    const responseTimeMs = Date.now() - start;

    // Maintain the precomputed dashboard summary so the dashboard can serve
    // latest readings without scanning raw observations.
    try {
      await updateDashboardSummary(env.DB, observation, location.name, finishedAt);
    } catch (summaryErr) {
      // Summary update is best-effort; a failure here must not fail the
      // collection run.
      console.warn(
        `[collector] ${source.id} / ${location.id}: dashboard summary update failed: ${errMessage(summaryErr)}`,
      );
    }

    // Maintain the materialized latest-state table used by the rain alert
    // pipeline, so alert evaluation never scans the historical table.
    try {
      await upsertLatestObservation(env.DB, observation);
    } catch (latestErr) {
      // Latest-state update is best-effort; a failure here must not fail
      // the collection run. The next successful cycle will catch up.
      console.warn(
        `[collector] ${source.id} / ${location.id}: latest observation update failed: ${errMessage(latestErr)}`,
      );
    }

    await logRequest(env.DB, {
      id: crypto.randomUUID(),
      runId,
      sourceId: source.id,
      locationId: location.id,
      requestedAt,
      finishedAt,
      status: "success",
      httpStatus,
      responseTimeMs,
    });
    console.log(
      `[collector] ${source.id} / ${location.id}: stored (${stored.inserted ? "inserted" : "duplicate"})`,
    );
    return {
      source_id: source.id,
      location_id: location.id,
      status: "success",
      http_status: httpStatus,
      response_time_ms: responseTimeMs,
      stored: stored.inserted,
    };
  } catch (err) {
    return fail(`Database write failed: ${errMessage(err)}`, httpStatus);
  }
}

/** Bounded concurrency map; preserves input order in output. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) break;
      results[index] = await fn(items[index]!);
    }
  }

  const workersCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workersCount }, () => worker()));
  return results;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export { DEFAULT_TIMEOUT_MS };