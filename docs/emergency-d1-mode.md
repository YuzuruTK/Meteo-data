# Emergency D1 Read-Conservation Mode

## Purpose

The production D1 database exhausted its daily **read** quota. INSERTs still
work; SELECT-heavy operations fail. This patch provides three independent
feature flags that eliminate the largest sources of D1 reads **immediately**,
while guaranteeing that incoming weather observations continue to be
collected and stored.

This is a temporary conservation measure, **not** an architectural fix. The
permanent fixes are tracked in `docs/performance-rollups-analysis.md`
(Phase 2 already shipped in PR #14; incremental rollups are Phase 1/3).

## Flags

All flags are Worker environment variables (settable via `wrangler.toml`
`[vars]` or the dashboard: Workers → Settings → Variables). Every flag
defaults to **disabled**; when absent or anything other than the exact
string `"true"`, behavior is identical to before this patch.

| Flag | Effect | Reads removed |
|---|---|---|
| `DISABLE_ROLLUPS=true` | Skips `rollupObservations()` after each collection cycle. Collection itself is **not** skipped. | ~17,000 rows / 5 min ≈ **~4.9M rows/day** (the single largest consumer; full raw-table scan) |
| `DISABLE_ALERTS=true` | `maybeRunWeatherAlerts()` returns immediately: no latest-station read, no rain/forecast alert state reads/writes, no push evaluation. | ~tens of rows / 5 min (small, but nonzero and quota-safe) |
| `READ_ONLY_EMERGENCY=true` | `/api/observations/aggregate` and `/api/stations` return HTTP 503 with `{ "maintenance": true, "message": "Temporarily disabled due to database quota exhaustion" }` **without touching D1**. | ~15,400 rows per dashboard request (~100 rows/s per viewer at 60 s polling) ≈ up to **~0.9M rows/hour** while the dashboard is open |

Notes:

- `/api/summary` and `/api/forecast` are intentionally left enabled: the
  summary endpoint reads the tiny precomputed `dashboard_summary` table and
  the forecast endpoint is served from a cached Open-Meteo response, so both
  are already read-cheap.
- `insertObservation()`, `updateDashboardSummary()` and
  `upsertLatestObservation()` remain active (write-path, O(1) each) —
  observation collection and storage are preserved by design.
- `DISABLE_ROLLUPS` means hourly/daily rollup tables stop being updated.
  After re-enabling, the next rollup run recomputes the last 24 h and the
  daily step re-reads touched days, so gaps heal automatically for recent
  data; for longer outages see the analysis doc for a backfill approach.

## What is intentionally preserved

- `scheduled()` → `runCollection()` → `insertObservation()` — weather
  collection continues every 5 minutes.
- Run/request logging (`createRun`, `logRequest`) — writes only, small.
- All push subscription writes.

## Deployment steps

1. Deploy the patched Worker revision (this branch) — flags default off, so
   deployment alone changes nothing.
2. Activate conservation mode (any subset, as needed):

   ```bash
   # via wrangler vars
   npx wrangler deploy   # after adding the flags to wrangler.toml [vars]

   # or via the dashboard
   # Workers & Pages → meteo-data-collector → Settings → Variables → add:
   #   DISABLE_ROLLUPS = true
   #   DISABLE_ALERTS = true
   #   READ_ONLY_EMERGENCY = true
   ```

3. Verify:
   - collection runs still log successes in Worker logs;
   - `GET /api/observations/aggregate` returns 503 JSON;
   - D1 metrics show reads collapsing to near-write-only levels.

## Rollback steps

1. Remove the flags (or set them to `"false"`) and redeploy. There is no
   schema change and no migration, so rollback is a plain redeploy — the
   pre-patch revision works at any time.
2. After re-enabling rollups, the next scheduled cycle rebuilds the last
   24 h of hourly/daily aggregates automatically.
3. Recommended order when leaving emergency mode:
   1. `READ_ONLY_EMERGENCY` off (the read-path PR #14 already makes these
      endpoints ~99% cheaper),
   2. `DISABLE_ALERTS` off,
   3. `DISABLE_ROLLUPS` off last, and watch D1 read metrics for one cycle.

## Tests

`tests/emergency-mode.test.ts` covers:

- `DISABLE_ROLLUPS=true` skips rollups while collection still succeeds;
- rollups still run when the flag is absent (default unchanged);
- `READ_ONLY_EMERGENCY=true` returns the 503 maintenance body for both
  endpoints using a DB stub that throws on any access (proves zero D1 reads);
- with the flag absent the endpoints still query the database.
