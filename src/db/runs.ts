import type { D1Database } from "@cloudflare/workers-types";
import type { CollectionRun } from "../collector/types";

export interface CreateRunInput {
  id: string;
  startedAt: string;
  sourcesAttempted: number;
}

/** Insert the run header (status unknown until finished). */
export async function createRun(
  db: D1Database,
  input: CreateRunInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collector_runs
        (id, started_at, status, sources_attempted, requests_attempted, requests_succeeded, requests_failed)
       VALUES (?, ?, ?, ?, 0, 0, 0)`,
    )
    .bind(input.id, input.startedAt, "running", input.sourcesAttempted)
    .run();
}

export interface FinishRunInput {
  id: string;
  finishedAt: string;
  status: "success" | "partial" | "failed";
  requestsAttempted: number;
  requestsSucceeded: number;
  requestsFailed: number;
}

/** Finalize a run with summary counters. */
export async function finishRun(db: D1Database, input: FinishRunInput): Promise<void> {
  await db
    .prepare(
      `UPDATE collector_runs
       SET finished_at = ?, status = ?,
           requests_attempted = ?, requests_succeeded = ?, requests_failed = ?
       WHERE id = ?`,
    )
    .bind(
      input.finishedAt,
      input.status,
      input.requestsAttempted,
      input.requestsSucceeded,
      input.requestsFailed,
      input.id,
    )
    .run();
}

export interface LogRequestInput {
  id: string;
  runId: string;
  sourceId: string;
  locationId: string;
  requestedAt: string;
  finishedAt: string;
  status: "success" | "failed";
  httpStatus?: number;
  responseTimeMs: number;
  error?: string;
}

/** Record a per-request attempt. Never logs secrets (nothing here is sensitive). */
export async function logRequest(db: D1Database, input: LogRequestInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO collector_requests
        (id, run_id, source_id, location_id, requested_at, finished_at, status, http_status, response_time_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.runId,
      input.sourceId,
      input.locationId,
      input.requestedAt,
      input.finishedAt,
      input.status,
      input.httpStatus ?? null,
      input.responseTimeMs,
      input.error ?? null,
    )
    .run();
}

/** Load a run summary from the DB (for tests/debug). */
export async function getRun(db: D1Database, id: string): Promise<CollectionRun | null> {
  const row = await db
    .prepare(`SELECT * FROM collector_runs WHERE id = ?`)
    .bind(id)
    .first();
  if (!row) return null;

  const reqs = await db
    .prepare(`SELECT * FROM collector_requests WHERE run_id = ? ORDER BY requested_at`)
    .bind(id)
    .all();

  return {
    id: row.id as string,
    started_at: row.started_at as string,
    finished_at: (row.finished_at as string) ?? undefined,
    status: row.status as CollectionRun["status"],
    sources_attempted: Number(row.sources_attempted),
    requests_attempted: Number(row.requests_attempted),
    requests_succeeded: Number(row.requests_succeeded),
    requests_failed: Number(row.requests_failed),
    requests: reqs.results.map((r) => ({
      source_id: r.source_id as string,
      location_id: r.location_id as string,
      status: r.status as "success" | "failed",
      http_status: r.http_status === null ? undefined : Number(r.http_status),
      response_time_ms: Number(r.response_time_ms),
      error: (r.error as string) ?? undefined,
    })),
  };
}