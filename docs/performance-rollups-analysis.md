# Performance Analysis — Observation Rollup System

**Date:** 2026-02-09
**Scope:** Full architectural review of the aggregation pipeline (`scheduled()` → collection → rollups → dashboard summary → alerts → forecasts) with a proposed incremental design.
**Status:** Analysis only. No production code was modified as part of this document.

---

## Executive Summary

The rain-alert bottleneck fixed in PR #13 (`latest_weather_observations`) removed the alert pipeline's full-table scan. D1 analytics now points at the **rollup system** as the largest source of row reads.

Investigation found **three distinct problems**:

1. **`rollupObservations()` (src/db/rollups.ts) is non-sargable and recomputes history.**
   Its hourly step filters with `WHERE datetime(observed_at) >= datetime('now', '-24 hours')`. Wrapping the indexed column in `datetime()` prevents SQLite from using `idx_weather_observations_location_time`, forcing a **full scan of `weather_observations` (~15,443 rows)** on every 5-minute cycle — D1 reports ~17,000 rows read per execution. A genuinely 24-hour slice would be only **~1,152 rows** (4 stations × 12 obs/hour × 24 h). The query both scans the whole table *and* re-aggregates 24 h of already-processed data.

2. **The rollup tables are written but never read.**
   The dashboard endpoints `/api/observations/aggregate` (`getHourlyAverages`) and `/api/stations` (`getStations`) still aggregate the **raw** `weather_observations` table with the same non-sargable `datetime(observed_at)` pattern. The frontend polls the aggregate endpoint **every 60 seconds** per open dashboard. `weather_observations_daily` has **zero readers** anywhere in `src/` (confirmed by full-codebase search — it is only ever written).

3. **A silent historical failure gap exists.**
   Migration `0008_hourly_wind_gust_min.sql` documents that every rollup execution failed with `"table weather_observations_hourly has no column named wind_gust_min"` from the day the feature shipped until 0008 was applied — silently, because the collector wraps `rollupObservations()` in a best-effort `try/catch` (src/collector/collector.ts:105–113). Hourly/daily data older than the current 24 h window therefore does not exist and must be **backfilled** before any read-path switch.

Combined current cost estimate: **~4.9M row reads/day** from the rollup alone (288 executions × ~17k rows), plus ~**15.5k rows per request** for every dashboard aggregate poll (potential ~22M rows/day for one continuously-open dashboard). Both are reducible by **>99%** with the incremental design in §4.

---


## 1. Current Data Flow

### 1.1 High-level flow

```text
weather provider (weather.com PWS API)
    ↓  HTTP fetch, 1 source × 4 locations, every 5 min (wrangler.jsonc: "*/5 * * * *")
collector (src/collector/collector.ts — runCollection → collectOne)
    ↓
weather_observations            (raw insert, src/db/observations.ts — INSERT OR IGNORE)
    ↓  (same cycle, per observation, best-effort)
dashboard_summary               (latest per station, src/dashboard/summary.ts — O(1) upsert)
latest_weather_observations     (latest per station, src/db/latest.ts — O(1) upsert, PR #13)
    ↓  (once per run, best-effort, src/collector/collector.ts:105–113)
weather_observations_hourly     (recomputes last 24h — src/db/rollups.ts)   ⚠ hotspot
weather_observations_daily      (recomputes touched days from hourly)      ⚠ medium
    ↓
dashboard (src/dashboard/api.ts)
  /api/observations/aggregate   → aggregates RAW weather_observations      ⚠ hotspot
  /api/stations                 → aggregates RAW weather_observations      ⚠ high
  /api/summary                  → reads dashboard_summary (cheap, currently unused by frontend)
```

### 1.2 Exact per-cycle call trace (`scheduled()`)

`src/worker.ts:25–37` — cron fires every 5 minutes:

1. `loadEnabledSources()` — 1 enabled source (`weather-com-pws`, 4 locations; `src/config/weather-sources.json`).
2. `runCollection(sources, env)` — `src/collector/collector.ts:42`:
   - `createRun()` (D1 write, `collector_runs`).
   - 4 × `collectOne()` tasks with concurrency 3:
     - `buildRequest` → provider HTTP fetch → `normalizeObservation` → `validate`.
     - `upsertLocation()` (D1 write, O(1)).
     - `insertObservation()` — `src/db/observations.ts` (D1 write, O(1), dedup via unique key).
     - `updateDashboardSummary()` — `src/dashboard/summary.ts` (D1 write, O(1) upsert, best-effort).
     - `upsertLatestObservation()` — `src/db/latest.ts` (D1 write, O(1) upsert, best-effort).
     - `logRequest()` (D1 write, `collector_requests`).
   - `finishRun()`.
   - **If `requestsSucceeded > 0`: `rollupObservations(env.DB)`** — `src/collector/collector.ts:107–113`, best-effort, default window `ROLLUP_WINDOW_HOURS = 24`:
     - Hourly: `INSERT INTO weather_observations_hourly ... SELECT ... FROM weather_observations WHERE datetime(observed_at) >= datetime('now','-24 hours') GROUP BY location_id, hour` — **full table scan** (§3).
     - Daily: re-aggregates *all hourly rows of every calendar day touched* by the 24 h window (up to 2 days × 4 stations).
     - Retention: `DELETE FROM weather_observations_hourly WHERE hour < datetime('now','-180 days')`.
3. `maybeRunWeatherAlerts()` — `src/worker.ts:77` (only if any request succeeded):
   - `loadLatestStations()` — `src/db/latest.ts:62`, reads `latest_weather_observations` (4 rows) — **already fixed by PR #13**.
   - `runRainAlerts()` — `src/push/alerts.ts` → `checkAndRecordRainState()` — `src/push/rain.ts`, O(stations) reads/writes on `weather_alert_state`; push sends read `push_subscriptions`.
   - `runForecastAlerts()` — `src/push/forecast.ts`, uses the cached Open-Meteo forecast (`src/forecast/open-meteo.ts`, no D1 read of observations) and reads/writes `weather_forecast_alert_state` (one row per alert type).
4. `fetch` handler (on demand, not cron): dashboard API routes in `src/dashboard/api.ts` → `getHourlyAverages` / `getStations` / `getDashboardSummaries`; push API in `src/push/api.ts`.

### 1.3 Client-side traffic

`dashboard/src/App.tsx`:
- `fetchStations(24)` on mount (once per page load, line 128).
- `fetchAggregates(...)` polled every **60 s** per open dashboard (`AGGREGATES_REFRESH_MS = 60_000`, line 147).
- Forecast polled every 15 min (Open-Meteo, no D1 observation reads).
- **`/api/summary` is currently not called by the frontend** (verified: no reference in `dashboard/src/`) even though the backend endpoint and `dashboard_summary` table exist and are maintained.
## 2. Query Inventory

Every query that reads (or writes) `weather_observations`, `weather_observations_hourly`, `weather_observations_daily`, `dashboard_summary`, `latest_weather_observations`.

### 2.1 `weather_observations`

| # | File / Function | Purpose | Frequency | Complexity | Cost |
|---|---|---|---|---|---|
| W1 | `src/db/observations.ts` `insertObservation()` | Insert raw observation (dedup via unique key + `INSERT OR IGNORE`) | 4/cycle → 288/day | O(1) PK/index insert | Low |
| R1 | `src/db/rollups.ts` `rollupObservations()` — hourly step (lines 146–166) | Recompute hourly rollups for last 24 h | 1/cycle → 288/day | **O(total table)** — non-sargable `datetime(observed_at)` defeats `idx_weather_observations_location_time`; full scan of ~15,443 rows + index pages | **Critical** |
| R2 | `src/dashboard/aggregate.ts` `getHourlyAverages()` (lines 71–111) | `/api/observations/aggregate` — hourly AVGs, default 24 h, up to 720 h | 1 per dashboard request; polled every 60 s per open viewer | **O(total table)** — same non-sargable `datetime(o.observed_at)` filter (line 86); full scan regardless of window | **Critical** |
| R3 | `src/dashboard/aggregate.ts` `getStations()` (lines 125–153) | `/api/stations` — station list + `MAX(observed_at)` + staleness over `hours` (default 24) | 1 per dashboard page load | **O(total table)** — same non-sargable filter (line 149) | **High** |
| — | `src/dashboard/aggregate.ts` `getStations()` fallback (lines 168–173) | `weather_locations` list when no recent data | rare | O(4 rows) | Low |

*Note: R1's D1-measured cost (~17k rows) = 15,443 table rows + index/auxiliary reads. R2/R3 have the identical root cause; the fix is the same in both cases.*

### 2.2 `weather_observations_hourly`

| # | File / Function | Purpose | Frequency | Complexity | Cost |
|---|---|---|---|---|---|
| W2 | `rollupObservations()` hourly step (lines 146–166) | Upsert ≤ 4 stations × 25 hourly rows/cycle | 288/day | O(window buckets) writes | Low |
| R4 | `rollupObservations()` daily step (lines 210–230) — subquery `SELECT DISTINCT substr(hour,1,10) ... WHERE hour >= datetime('now','-24 hours')` | Find touched days | 288/day | Range scan on `idx_obs_hourly_hour` (~100 rows) | Medium (redundant: recomputes data already aggregated) |
| R5 | `rollupObservations()` daily step — main aggregation | Derive daily rows from hourly for all touched calendar days | 288/day | O(hourly rows of 1–2 days) = ~8–96 rows | Medium |
| R6 | `rollupObservations()` retention (lines 236–241) | Prune hourly rows older than 180 days | 288/day | Index range scan on `hour`; deletes nothing most days | Low |
| — | **Readers outside the rollup itself** | — | — | — | **NONE** — no `SELECT ... FROM weather_observations_hourly` exists outside `src/db/rollups.ts` (verified across `src/`, `dashboard/`, `tests/`) |

### 2.3 `weather_observations_daily`

| # | File / Function | Purpose | Frequency | Complexity | Cost |
|---|---|---|---|---|---|
| W3 | `rollupObservations()` daily step (lines 210–230) | Upsert ≤ 8 daily rows/cycle | 288/day | O(4) writes | Low |
| — | **Readers** | — | — | — | **ZERO.** Confirmed by codebase-wide search: the table appears only in `migrations/0005_observation_rollups.sql` (creation), `migrations/0008` (comment), `src/db/rollups.ts` (write target), `docs/MIGRATIONS.md`, and test mocks. **No `SELECT ... FROM weather_observations_daily` exists anywhere in production code.** It is computed 288×/day and never consumed. |

### 2.4 `dashboard_summary`

| # | File / Function | Purpose | Frequency | Complexity | Cost |
|---|---|---|---|---|---|
| W4 | `src/dashboard/summary.ts` `updateDashboardSummary()` | Mirror latest observation per station | 4/cycle (288/day) | O(1) upsert | Low |
| R7 | `src/dashboard/summary.ts` `getDashboardSummaries()` | `/api/summary` | per request (frontend currently does **not** call it) | O(4 rows) | Low |

### 2.5 `latest_weather_observations`

| # | File / Function | Purpose | Frequency | Complexity | Cost |
|---|---|---|---|---|---|
| W5 | `src/db/latest.ts` `upsertLatestObservation()` | Materialize latest state per station (with out-of-order guard) | 4/cycle | O(1) upsert | Low |
| R8 | `src/db/latest.ts` `loadLatestStations()` | Feed rain-alert pipeline with fresh stations | 1/cycle (288/day) | O(4 rows) + join `weather_locations` | Low — **fixed by PR #13 / migration 0007** |

### 2.6 Related (no observation-table reads)

| File / Function | Tables touched | Frequency | Cost |
|---|---|---|---|
| `checkAndRecordRainState()` — `src/push/rain.ts` | `weather_alert_state` | O(4)/cycle | Low |
| `sendPushNotifications()` — `src/push/send.ts` | `push_subscriptions` | on alert | Low |
| `shouldSend()`/`recordAlert()` — `src/push/forecast.ts` | `weather_forecast_alert_state` | O(≤3)/cycle | Low |
| `createRun`/`finishRun`/`logRequest` — `src/db/runs.ts` | `collector_runs`, `collector_requests` | per cycle | Low (append-only) |
| `getForecast()` — `src/forecast/open-meteo.ts` | (external cache, no D1) | per cycle | n/a |


---

## 3. D1 Read Hotspots

Operations that scan historical observations, recalculate existing aggregates, or repeat GROUP BY over already-processed data — ranked.

### Critical

**C1. `rollupObservations()` — hourly step** (`src/db/rollups.ts:146–166`)
- Full table scan of `weather_observations` on **every 5-minute cycle**: `WHERE datetime(observed_at) >= datetime('now','-24 hours')` applies a function to the indexed column, so `idx_weather_observations_location_time` (`migrations/0003`) is unusable.
- Recomputes GROUP BY over 24 h of data that was already aggregated by the previous 287 executions.
- Scales **linearly with total table growth** (~15,443 rows today, growing ~691 rows/day: 4 stations × 12 obs/h × 24 h).
- ~17,000 rows/execution × 288 = **~4.9M row reads/day**.

**C2. `getHourlyAverages()`** (`src/dashboard/aggregate.ts:71–111`, route `/api/observations/aggregate`)
- Same non-sargable predicate (line 86) → full scan of raw observations **per request**.
- Frontend polls every 60 s per open dashboard; with default 24 h window it reads ~15.5k rows to return what `weather_observations_hourly` already contains in ~96 rows.
- Scales with table growth × number of viewers.

### High

**H1. `getStations()`** (`src/dashboard/aggregate.ts:125–153`, route `/api/stations`)
- Same non-sargable predicate (line 149); computes `MAX(observed_at)` per station by scanning raw history on every page load.
- Correct replacement already exists: `latest_weather_observations` holds exactly this data (one row per station), maintained by the collector since PR #13.

### Medium

**M1. `rollupObservations()` — daily step** (`src/db/rollups.ts:210–230`)
- Bounded (hourly table is small), but **recomputes entire calendar days** (up to 2 days × 4 stations = up to 96 hourly rows re-aggregated 288×/day) from data that already passed through the hourly GROUP BY. Redundant chained recomputation, though not a table-growth hazard.

**M2. `rollupObservations()` — touched-days subquery** (`src/db/rollups.ts:221–225`)
- `SELECT DISTINCT substr(hour,1,10) ... WHERE hour >= datetime('now','-24 hours')` — re-derived every cycle instead of tracking the frontier. This one *is* sargable (`hour` format matches `datetime()` output lexicographically), so cost is a bounded index range scan.

### Low

- **L1. Retention DELETE** (`rollups.ts:236–241`) — index range scan on `hour`; deletes nothing on most days.
- **L2. `/api/summary` → `getDashboardSummaries()`** — O(4 rows); unused by the frontend today.
- **L3. All alert/forecast/latest paths** — O(stations) after PR #13.
- **L4. `insertObservation` / `updateDashboardSummary` / `upsertLatestObservation`** — O(1) writes.

**Structural observation:** the three Critical/High hotspots share one root cause (non-sargable `datetime(col)` predicates + aggregating raw history), and two of them (C2, H1) are *read-path* problems that would disappear entirely if the dashboard consumed the rollup tables it already maintains.


---


## 4. Incremental Rollup Design

### 4.1 Goal

```text
Current:  O(total observations in table)  per 5-min cycle
Target:   O(new observations)             per 5-min cycle
```

### 4.2 Question posed: can hourly aggregation be updated directly during collection?

**Yes** — the collector already maintains two materialized tables per observation (`dashboard_summary`, `latest_weather_observations`) with exactly this pattern. The rollup can join them; the only complication is that `AVG`/`MIN`/`MAX` are not trivially incremental. Two options were evaluated:

**Option A — bounded per-bucket recompute (recommended).**
When an observation is inserted, recompute only the single `(location_id, hour)` bucket it belongs to, from raw observations restricted to that one hour:

```sql
INSERT INTO weather_observations_hourly (...)
SELECT ... FROM weather_observations
WHERE location_id = ?
  AND observed_at >= ?   -- ISO hour start, e.g. '2026-02-09T13:00:00.000Z'
  AND observed_at < ?    -- ISO hour end
GROUP BY location_id, hour
ON CONFLICT(location_id, hour) DO UPDATE SET ...
```

- **Sargable:** raw ISO-8601 strings compare correctly lexicographically against each other; no `datetime()` on the column, so `idx_weather_observations_location_time` is used. Cost per call: **~12 index rows + 1 upsert** (the bucket holds at most ~12 observations at the current 5-min cadence).
- **Exactness preserved:** the bucket result is identical to the full recomputation — no drift, no sum/count accumulator columns, no schema change.
- **No schema change** → no new migration beyond a backfill; existing rollup tests keep validating column semantics.

**Option B — true O(1) incremental accumulation.**
Add `*_sum` + `*_count` columns to `weather_observations_hourly` and merge each new observation arithmetically. Rejected for now: ~25 new columns, NULL/multi-source edge cases, drift risk from `INSERT OR IGNORE` duplicates, and Option A is already O(bucket) ≈ O(new observations) in practice (bucket size is bounded by reporting cadence, not history).

### 4.3 Target architecture

```text
insert weather_observation                      (O(1), existing)
    ↓ if newly inserted (stored.inserted === true)
update hourly bucket                            (Option A: ~12 index rows, sargable)
    ↓ throttled: on hour-boundary crossing, or once per (location, day) per cycle
update daily row                                (~24 hourly rows read, sargable via PK prefix)
    ↓ (existing, unchanged)
update dashboard_summary                        (O(1), existing)
update latest_weather_observations              (O(1), existing — PR #13)
```

Details:

1. **`updateHourlyBucket(db, obs)`** — new function in `src/db/rollups.ts`. Called from `collectOne()` right after a successful `insertObservation()` (mirroring where `updateDashboardSummary` / `upsertLatestObservation` are already called, collector.ts:263–291). Best-effort try/catch like its siblings. Hour bounds computed in TypeScript from `obs.observed_at` (UTC), bounds emitted as ISO strings.
2. **`updateDailyRow(db, locationId, day)`** — recomputes `(location_id, day)` from `weather_observations_hourly WHERE location_id = ? AND substr(hour,1,10) = ?` (≤ 24 rows). Throttle: only when the hourly upsert reports it created a *new* bucket for the hour (or simply run each cycle — at 4 stations it is ~100 rows/cycle, still >99% below current cost; throttling is a refinement, not a requirement). The daily AVG weighting logic (`SUM(x_avg * observation_count) / SUM(observation_count)`) is reused unchanged.
3. **Duplicates / out-of-order arrival.** `INSERT OR IGNORE` dedup means duplicates skip the bucket update (bucket already reflects them). A late-arriving *older* observation still triggers a bucket recompute for its own hour — correct and idempotent. No out-of-order hazard exists at the bucket level because the recompute is derived, not accumulated.
4. **Self-healing.** Keep a **repair job**: the existing `rollupObservations()` logic, but with sargable bounds, executed (a) on deployment, and (b) on a low-frequency cron (e.g. hourly or daily). It heals any bucket missed by a failed best-effort update and bounds staleness. Optionally a `rollup_checkpoint` (last processed `observed_at` per location) makes the repair window explicit.
5. **Retention unchanged** — the 180-day hourly prune (L1) stays as is.

### 4.4 Read-path changes (required to get the full win)

1. **`getHourlyAverages()` → read `weather_observations_hourly`.**
   ```sql
   SELECT h.location_id AS station_id, wl.name AS station_name, h.hour, h.temperature_avg, ...
   FROM weather_observations_hourly h
   JOIN weather_locations wl ON wl.id = h.location_id
   WHERE h.hour >= ?   -- 'YYYY-MM-DD HH:00', sargable on idx_obs_hourly_hour
   ```
   Semantics shift: the endpoint currently returns raw averages including NULL-heavy buckets with different counts; the rollup returns the same AVG values (AVG over the same observations, computed by the rollup). The existing `hourly` table stores exactly the needed `*_avg` columns — the response shape is unchanged. Windows longer than 180 days exceed hourly retention (HOURLY_RETENTION_DAYS): either clamp, or fall back to a sargable raw scan for those rare requests.
2. **`getStations()` → read `latest_weather_observations`** joined with `weather_locations` (same query shape as `loadLatestStations()`, minus the freshness filter, computing `stale` from `observed_at`). Eliminates the raw-table scan per page load.
3. **Frontend unchanged** — same endpoints, same response shapes.

### 4.5 Complexity summary after refactor

| Operation | Before | After |
|---|---|---|
| Rollup write path / cycle | O(all history) ≈ 15.4k rows | O(new obs) ≈ 4 × (12 + 24) ≈ 144 rows |
| Dashboard aggregate read | O(all history) ≈ 15.4k rows/request | O(4 × hours) ≈ 96 rows/request |
| Station list read | O(all history) | O(4 rows) |
| Alerts / latest / summary | O(stations) | unchanged |


---

## 5. Migration Strategy

### 5.1 Requirements checklist

| Requirement | How it is met |
|---|---|
| No data loss | Schema change is **additive only** (a backfill); `weather_observations` is never pruned; existing rollup rows are only ever overwritten by values derived from the same raw data |
| No dashboard regressions | Read-path switch keeps identical endpoint contracts; deployed behind verification (§5.3 step 4); raw-table queries retained as a documented fallback during rollout |
| Backwards-compatible deployment | Incremental writer is deployed *alongside* (not instead of) the periodic rollup for one observation window; both paths are idempotent and converge to identical values |
| Rollback strategy | Previous worker version can be redeployed at any time: old `rollupObservations()` works unchanged on the (unchanged) schema, old read paths still query raw tables. The backfilled rollup data does not harm either version |

### 5.2 Migration `0009_backfill_rollups.sql`

One-time backfill of the historical gap created by the silent 0008-era failures (§ Exec Summary, item 3):

1. Re-run the *existing* hourly aggregation SQL with **no time bound** (`INSERT ... SELECT ... GROUP BY location_id, hour ON CONFLICT ... DO UPDATE`), populating all history from `weather_observations`. At ~15.4k rows this is a single bounded D1 migration statement — well within D1 limits, and idempotent on re-apply.
2. Re-run the daily derivation from the freshly completed hourly table (whole days), including all history.
3. No `ALTER TABLE` and no destructive statement. Existing recent-window rows get recomputed to identical values (idempotent upserts).

Note: hourly retention (180 days) is shorter than raw history age only if history exceeds 180 days; today (~13–14 days of data) everything fits. If the table ever ages past 180 days, the backfill window should be clamped to retention — daily aggregates remain the long-term record.

### 5.3 Deployment sequence

1. **Apply migration 0009** (backfill). Safe against any running version — upserts converge.
2. **Deploy Phase-1 worker**: incremental bucket updates + *keep* the existing periodic `rollupObservations()` running. Both writers are idempotent and compute from the same raw data; overlap is harmless and provides continuous parity checking.
3. **Verify parity** (48 h): compare a sample of hourly buckets/daily rows produced by both paths (ad-hoc SQL; optionally log discrepancies). D1 analytics should show the rollup query's read pattern unchanged (old path still active) while new writes appear.
4. **Deploy Phase-2 read path**: switch `getHourlyAverages()` / `getStations()` to rollup/latest tables. Verify `/api/observations/aggregate` and `/api/stations` responses against the previous implementation (same hours window, side-by-side fetch).
5. **Deploy Phase-3**: reduce periodic `rollupObservations()` to the low-frequency repair job (hourly/daily cron or guarded call), remove the 24 h recompute from the hot path.

### 5.4 Rollback

- **Phase 1 rollback:** redeploy previous worker. Periodic rollup continues to heal everything (24 h window); incremental rows are correct anyway.
- **Phase 2 rollback:** revert the two read functions to raw-table queries (kept in git history); endpoints contract-identical.
- **Data rollback:** never needed — raw table is the source of truth and is never modified or pruned; rollups are pure derived caches (`docs/MIGRATIONS.md` documents this invariant).

### 5.5 Test impact

- `tests/rollups.test.ts` — mock-based; extends naturally to the new bucket-update function (idempotency and daily-throttle cases already exist).
- `tests/timestamp-comparison.test.ts` — real-SQLite integration test; add a case proving the new bucket query is sargable in effect (only the target bucket's rows are aggregated when older rows exist) and that ISO-string bounds match the current `datetime()` semantics.
- `tests/dashboard.test.ts` — add coverage for the rollup-backed `getHourlyAverages` / latest-backed `getStations`.


---

## 6. Estimated Impact

Basis: 1 enabled source × 4 locations, cron every 5 min → 288 cycles/day, ~12 obs/hour/station → ~691 new rows/day. Table today: ~15,443 rows (~13–14 days of history). Each optimization quantified **independently**.

### 6.1 Optimization 1 — incremental rollup writes (replaces 24 h recompute)

| | Rows/day |
|---|---|
| **Current** — hourly step: ~17,000 rows/execution (D1-measured; full scan) × 288 | **~4,896,000** |
| **Current** — daily step + retention: ~100–200 rows/execution × 288 | ~40,000 |
| **After** — per insert: bucket recompute ~12 rows + 1 write × 4 inserts × 288 | ~15,400 |
| **After** — daily row recompute (unthrottled: ~24 rows × 4 × 288) | ~27,600 |
| **After** — daily row recompute (hour-boundary throttled: ~96 rows × 24) | ~2,300 |
| **After total** (throttled variant) | **~18,000–45,000** |
| **Reduction (rollup path)** | **~99%** (≈ 4.9M → ≈ 18–45k) |

### 6.2 Optimization 2 — `getHourlyAverages()` reads the hourly rollup

| | Rows/request |
|---|---|
| **Current** — full scan of raw table (non-sargable), default 24 h window | **~15,500** |
| **After** — 4 stations × 24 hourly rows + 4 join rows | **~100** |
| **Reduction** | **~99.4%** |

Daily for one continuously-open dashboard (1 request/min): ~22.3M → ~144k rows/day.

### 6.3 Optimization 3 — `getStations()` reads `latest_weather_observations`

| | Rows/request |
|---|---|
| **Current** — full scan of raw table, 24 h window | **~15,500** |
| **After** — 4 latest rows + 4 location rows | **~10** |
| **Reduction** | **~99.9%** |

Daily at, e.g., 100 page loads/day: 1.55M → ~1,000 rows/day.

### 6.4 Combined view

| Path | Current rows/day (1 viewer) | After rows/day | Reduction |
|---|---|---|---|
| Rollup writes | ~4.9M | ~18–45k | ~99% |
| Aggregate polling | ~22.3M | ~144k | ~99.4% |
| Station list | ~1.55M (at 100 loads/day) | ~1k | ~99.9% |
| Alerts / latest / summary / runs | ~low 10³ | unchanged | — |
| **Total** | **~28M+** | **~0.2M** | **>99%** |

These are conservative: the aggregate-polling saving scales with viewer count, and the current rollup cost grows linearly with table age (in 6 months the raw scan would be ~150k rows/execution ≈ 43M rows/day).

---

## Recommended Implementation Plan

### Phase 1 — Incremental rollup writes + backfill (low risk, ~1–2 days)

1. Migration `0009_backfill_rollups.sql`: unbounded (retention-clamped) hourly + daily backfill, idempotent upserts (§5.2).
2. `src/db/rollups.ts`: add `updateHourlyBucket()` (sargable, per-insert, Option A) and `updateDailyRow()` (reuse daily weighting logic; hour-boundary throttled).
3. `src/collector/collector.ts`: call them best-effort after successful `insertObservation()` (same pattern as the existing summary/latest upserts).
4. **Keep** the existing periodic `rollupObservations()` unchanged (dual-write parity period).
5. Tests: bucket idempotency, sargability, duplicate handling, backfill convergence.

- **Risk: low.** Additive, idempotent, best-effort by design; old path untouched.
- **Impact:** rollup path −99% only after Phase 3 de-scoping; Phase 1 alone adds a small write cost but establishes correctness.
- **Effort:** ~1–2 days (including tests and local verification against real SQLite).

### Phase 2 — Read-path switch (medium risk, ~0.5–1 day)

1. `getHourlyAverages()` → `weather_observations_hourly` (clamp >180-day windows or fall back to a sargable raw scan).
2. `getStations()` → `latest_weather_observations` + `weather_locations`.
3. Verify endpoint responses against current implementation before/at deploy (side-by-side fetch, same window).
4. Update `tests/dashboard.test.ts`.

- **Risk: medium.** User-visible endpoint semantics must be byte-compatible (response shape identical; AVG values derived from the same observations — spot-check NULL handling and multi-source buckets).
- **Impact:** independent −99.4% / −99.9% on the two dashboard endpoints (starts paying off immediately).
- **Effort:** ~0.5–1 day.

### Phase 3 — De-scope the hot-path recompute + hardening (low risk, ~0.5 day)

1. Convert periodic `rollupObservations()` into the bounded repair job (hourly or daily cron, sargable bounds); remove it from the 5-minute hot path.
2. Optional: `rollup_checkpoint` table for an explicit repair frontier; optional D1 analytics verification that hourly aggregation no longer appears among top read consumers.
3. Update `docs/MIGRATIONS.md` and README architecture notes.

- **Risk: low.** Pure de-scoping after Phases 1–2 are proven; repair job retains self-healing.
- **Impact:** realizes the full rollup-path reduction; bounds worst-case recovery time to the repair interval.
- **Effort:** ~0.5 day.

### Out of scope / noted for later

- **Circular wind-direction mean** — `AVG(wind_direction)` is documented in `src/db/rollups.ts:11–18` as knowingly incorrect; any rollup refactor touching daily derivation should keep this limitation intact until a dedicated fix (atan2 of sine/cosine means) is designed.
- **`/api/summary` is maintained but unused by the frontend** — either wire it up (cheapest possible "latest readings" source) or remove it in a cleanup pass.
- **Dedicated crons** — if a separate repair cron is added, `wrangler.jsonc` gains a second trigger; the handler must branch on `controller.cron`.


---

