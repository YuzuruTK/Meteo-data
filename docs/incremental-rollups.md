# Incremental Rollups — Performance Analysis

**Date:** 2026-03-09
**Related:** docs/performance-rollups-analysis.md (initial discovery), docs/emergency-d1-mode.md (interim conservation flags)

## Summary

Before this change the rollup system was the single largest D1 read consumer in the
system — **~4.93M rows/day** — because it full-scanned the raw `weather_observations`
table on every 5-minute cycle (288×/day) with a non-sargable `datetime(observed_at) >=
datetime('now', ...)` predicate. After the incremental refactor the rollup pipeline
cost is **~51k rows/day** — a **~99.0% reduction** — bounded to the size of buckets
affected by new observations, never by the total historical size.

## Architecture

The system now has two write paths:

1. **Incremental bucket updates** (hot path, per-observation, every 5 minutes):
   - `updateHourlyBucket(db, obs)` — recompute ONLY the single `(location, hour)`
     bucket the new observation belongs to. Sargable via
     `idx_weather_observations_location_time` (EXPLAIN: `SEARCH ... USING INDEX`).
     Cost: ~12 index rows per call.
   - `updateDailyRow(db, locationId, day)` — recompute ONLY the `(location, day)`
     row the observation affects. For recent days (within 180-day retention),
     derived from the hourly table via a PK-prefix scan (≤24 rows). For older
     late arrivals (A3 guard), derived from the raw table (≤288 rows, still
     sargable via the same index).
   - Only runs for genuinely new rows (`stored.inserted === true` from INSERT OR
     IGNORE); duplicates skip the bucket update — no double-counting.
   - Best-effort: a failure does not fail the collection; the repair job heals.

2. **Self-healing repair job** (at most once per hour, guard `:00` UTC cycle):
   - `rollupObservations(db, windowHours, now)` — iterates PER LOCATION (A1)
     instead of a time-only bound (which cannot use any index and would full-scan
     the raw table — that monolithic form is **rejected**). Sargable hourly upserts
     per location via `idx_weather_observations_location_time`.
   - Daily step (A2) iterates per `(location, day)` touched by the window,
     computed in TypeScript. The previous `substr(hour,1,10) IN (SELECT DISTINCT ...)`
     form full-scanned the hourly table and is **rejected**.
   - Retention unchanged; sargable on `idx_obs_hourly_hour`.
## Index usage (verified via EXPLAIN QUERY PLAN)

Every production statement was confirmed against real SQLite (`node:sqlite`):

| Statement | EXPLAIN QUERY PLAN result |
|---|---|
| `updateHourlyBucket` | `SEARCH weather_observations USING INDEX idx_weather_observations_location_time` |
| `updateDailyRow` (recent day, from hourly) | `SEARCH weather_observations_hourly USING INDEX sqlite_autoindex..._1` (PK) |
| `updateDailyRow` (pruned day A3, from raw) | `SEARCH weather_observations USING INDEX idx_weather_observations_location_time` |
| Repair hourly per location (A1) | `SEARCH weather_observations USING INDEX idx_weather_observations_location_time` |
| Repair daily per (location, day) (A2) | `SEARCH weather_observations_hourly USING INDEX sqlite_autoindex..._1` (PK) |
| Retention DELETE | `SEARCH weather_observations_hourly USING INDEX idx_obs_hourly_hour` |

## Read cost comparison

### Before (production, observed via D1 analytics)

| Component | Rows/execution | Frequency | Rows/day |
|---|---|---|---|
| `rollupObservations()` hourly step — full scan (non-sargable `datetime(observed_at)` predicate) | ~17,000 | 288/day | **~4,896,000** |
| `rollupObservations()` daily step + retention | ~100–200 | 288/day | ~40,000 |
| **Total (rollup writes)** | | | **~4,936,000** |

### After (projected, validated via EXPLAIN)

| Component | Rows/execution | Frequency | Rows/day |
|---|---|---|---|
| Incremental hourly (4 inserts × ~12 rows) | ~48 | 288/day | ~13,824 |
| Incremental daily (4 × ~24 hourly rows) | ~96 | 288/day | ~27,648 |
| Repair hourly (4 locations × 2h × ~12 rows) | ~96 | 24/day | ~2,304 |
| Repair daily (4 locations × 2 days × ~24 rows) | ~192 | 24/day | ~4,608 |
| Retention DELETE | ~0 (rarely hits) | 24/day | ~0 |
| **Total (rollup writes)** | **~144** (avg/cycle) | | **~51,000** |
| **Reduction** | | | **~99.0%** |

## Rejected designs (kept for reference)

These forms were evaluated during review and **rejected** because EXPLAIN QUERY PLAN
showed they produce full scans:

1. **Repair hourly with time-only bound** (`WHERE observed_at >= ?` without
   `location_id = ?`): no index leads with `observed_at`, so it scans the raw table.
2. **Daily derivation with `substr(hour,1,10) IN (SELECT DISTINCT ...)`** from the
   hourly table: the outer query scans the hourly table completely.

Both are permanently guarded against regressions by the EXPLAIN QUERY PLAN
assertions in `tests/incremental-rollups.test.ts`.

## Verification post-deploy

1. Watch D1 analytics (Rows Read) for the Worker's scheduled function — within
   24 hours the rollup's read consumption should drop from ~4.9M/day to under
   ~100k/day.
2. Compare a sample of rollup rows from the incremental path vs. a manual full
   recomputation:
   ```sql
   SELECT * FROM weather_observations_hourly ORDER BY location_id, hour;
   -- vs
   SELECT location_id, strftime('%Y-%m-%d %H:00', observed_at) AS hour,
          AVG(temperature), ... FROM weather_observations
   WHERE location_id = '...' AND observed_at >= 'YYYY-MM-DDTHH:00:00.000Z'
     AND observed_at < 'YYYY-MM-DDTHH:00:00.000Z'
   GROUP BY location_id, hour;
   ```
3. Confirm no new `SCAN weather_observations` patterns appear in D1 analytics.