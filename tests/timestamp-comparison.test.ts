import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { insertObservation } from "../src/db/observations";
import {
  upsertLatestObservation,
  loadLatestStations,
} from "../src/db/latest";
import { getStations, getHourlyAverages } from "../src/dashboard/aggregate";
import { rollupObservations } from "../src/db/rollups";
import type { NormalizedWeatherObservation } from "../src/collector/types";

/**
 * Integration tests against REAL SQLite (node:sqlite), exercising the
 * production query functions end-to-end with genuine ISO-8601 UTC
 * timestamps (as produced by `toISOString()` in the collector).
 *
 * These tests exist to prove the timestamp-comparison fix: comparing a
 * stored ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.sssZ`) directly against
 * SQLite's `datetime('now', ...)` output (`YYYY-MM-DD HH:MM:SS`) is a
 * lexicographic TEXT comparison where 'T' (0x54) > ' ' (0x20) — every
 * same-calendar-date timestamp would win the comparison regardless of its
 * actual time. The production queries therefore wrap the stored column in
 * `datetime(...)` before comparing; these tests verify that behavior
 * against a real database, not a mock.
 *
 * Skipped gracefully if the runtime does not provide `node:sqlite`.
 */

const sqliteModuleName = "node:" + "sqlite"; // dynamic specifier: no static types required
const sqlite = await import(sqliteModuleName).catch(() => null);
const DatabaseSync = sqlite?.DatabaseSync as
  | (new (path?: string) => unknown)
  | undefined;

const makeObs = (
  locationId: string,
  observedAt: string,
  precipitationRate = 0,
): NormalizedWeatherObservation => ({
  source_id: "weather-com-pws",
  location_id: locationId,
  observed_at: observedAt,
  temperature: 20,
  solar_radiation: null,
  humidity: 60,
  pressure: null,
  wind_speed: null,
  wind_direction: null,
  wind_gust: null,
  precipitation_rate: precipitationRate,
  precipitation_total: null,
  uv_index: null,
  cloud_cover: null,
  visibility: null,
  collected_at: new Date().toISOString(),
});

/**
 * Minimal D1Database adapter over node:sqlite. Supports the surface used by
 * the production functions: prepare().bind().run()/all()/first().
 */
class SqliteD1 {
  constructor(private readonly db: { prepare: (sql: string) => any }) {}

  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    const wrap = (args: unknown[]) => ({
      run: async () => {
        const info = stmt.run(...(args as never[]));
        return { meta: { changes: Number((info as { changes: number }).changes ?? 0) } };
      },
      all: async <T>() => ({ results: stmt.all(...(args as never[])) as T[] }),
      first: async <T>() => ((stmt.get(...(args as never[])) as T) ?? null),
    });
    return {
      bind: (...args: unknown[]) => wrap(args),
      run: () => wrap([]).run(),
      all: wrap([]).all,
      first: wrap([]).first,
    };
  }
}

function createMigratedDb(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const db = new DatabaseSync!(":memory:") as {
    exec: (sql: string) => void;
    prepare: (sql: string) => any;
  };
  // Apply every real migration in order, using Vite's import.meta.glob so no
  // Node-specific fs/path types are required in this Workers-targeted repo.
  type Glob = Record<string, string>;
  const glob = (import.meta as unknown as {
    glob: (p: string, o: object) => Glob;
  }).glob("../migrations/*.sql", {
    query: "?raw",
    import: "default",
    eager: true,
  });
  for (const path of Object.keys(glob).sort()) {
    db.exec(glob[path]!);
  }
  return db;
}

const d = DatabaseSync ? describe : describe.skip;

d("timestamp comparison against real SQLite", () => {
  it("filters stale observations correctly in loadLatestStations", async () => {
    const rawDb = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(rawDb) as unknown as D1Database;

    const now = Date.now();
    const iso = (minOffset: number) => new Date(now + minOffset * 60_000).toISOString();
    // The regression case: an ISO timestamp whose calendar date matches the
    // 15-minute cutoff's date but whose time is long past — under the naive
    // TEXT comparison this would incorrectly pass the freshness filter.
    const cutoff = new Date(now - 15 * 60_000);
    const cutoffDatePart = cutoff.toISOString().slice(0, 10);
    const cutoffMidnight = new Date(`${cutoffDatePart}T00:00:00.000Z`).getTime();
    const boundarySafe = cutoff.getTime() - cutoffMidnight > 2 * 60_000;

    const stations = [
      { id: "st-fresh", name: "Fresh", at: iso(-2) },
      { id: "st-30min", name: "Thirty", at: iso(-30) },
      ...(boundarySafe ? [{ id: "st-boundary", name: "Boundary", at: `${cutoffDatePart}T00:00:00.000Z` }] : []),
      { id: "st-prevday", name: "PrevDay", at: iso(-30 * 60) },
    ];

    // loadLatestStations() joins weather_locations, so the stations must
    // exist there for the latest rows to be returned.
    rawDb.exec(`INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ${stations.map((s) => `('${s.id}', 'src', 'ext-${s.id}', '${s.name}', datetime('now'), datetime('now'))`).join(",\n      ")}`);

    for (const s of stations) {
      await upsertLatestObservation(db, makeObs(s.id, s.at, 1.5));
    }

    const result = await loadLatestStations(db);
    expect(result.map((r) => r.stationId)).toEqual(["st-fresh"]);
  });

  it("flags stale stations correctly in getStations", async () => {
    const raw = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(raw) as unknown as D1Database;

    const now = Date.now();
    const iso = (minOffset: number) => new Date(now + minOffset * 60_000).toISOString();
    const cutoffDatePart = new Date(now - 15 * 60_000).toISOString().slice(0, 10);

    raw.exec(`INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('st-fresh', 'src', 'e1', 'Fresh', datetime('now'), datetime('now')),
      ('st-30min', 'src', 'e2', 'Thirty', datetime('now'), datetime('now')),
      ('st-boundary', 'src', 'e3', 'Boundary', datetime('now'), datetime('now'))`);

    await upsertLatestObservation(db, makeObs("st-fresh", iso(-2)));
    await upsertLatestObservation(db, makeObs("st-30min", iso(-30)));
    await upsertLatestObservation(db, makeObs("st-boundary", `${cutoffDatePart}T00:00:00.000Z`));

    const stations = await getStations(db, { hours: 24, staleMinutes: 15 });
    const byId = new Map(stations.map((s) => [s.id, s]));

    expect(byId.get("st-fresh")?.stale).toBe(false);
    expect(byId.get("st-30min")?.stale).toBe(true);
    // Regression: same-calendar-date stale observation was never flagged.
    expect(byId.get("st-boundary")?.stale).toBe(true);
  });

  it("bounds the dashboard aggregation window exactly in getHourlyAverages", async () => {
    const raw = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(raw) as unknown as D1Database;

    const now = Date.now();
    const iso = (minOffset: number) => new Date(now + minOffset * 60_000).toISOString();

    raw.exec(`INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('st-1h', 'src', 'e1', 'OneHour', datetime('now'), datetime('now')),
      ('st-old', 'src', 'e2', 'Older', datetime('now'), datetime('now'))`);

    // st-1h has a bucket inside the 1-hour window (the current hour).
    await insertObservation(db, makeObs("st-1h", iso(-30)));
    await rollupObservations(db);
    // st-old's bucket is 3 hours old — same calendar date as the cutoff, but
    // the hour label comparison must exclude it (naive date-only TEXT
    // comparison would include it).
    await insertObservation(db, makeObs("st-old", iso(-3 * 60)));
    await rollupObservations(db);

    const rows = await getHourlyAverages(db, { hours: 1 });
    expect(rows.map((r) => r.station_id)).toEqual(["st-1h"]);
    // Sanity: the old bucket really exists in the rollup, just outside the window.
    const allHourly = raw
      .prepare("SELECT DISTINCT location_id FROM weather_observations_hourly")
      .all() as Array<{ location_id: string }>;
    expect(allHourly.map((r) => r.location_id)).toContain("st-old");
  });

  it("bounds the hourly rollup window exactly in rollupObservations", async () => {
    const raw = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(raw) as unknown as D1Database;

    const now = Date.now();
    const iso = (minOffset: number) => new Date(now + minOffset * 60_000).toISOString();
    const cutoffDatePart = new Date(now - 24 * 60 * 60_000).toISOString().slice(0, 10);

    raw.exec(`INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('st-a', 'src', 'e1', 'A', datetime('now'), datetime('now')),
      ('st-b', 'src', 'e2', 'B', datetime('now'), datetime('now'))`);

    await insertObservation(db, makeObs("st-a", iso(-30), 2));
    // Same calendar date as the 24-hour cutoff, but ~48 hours old.
    await insertObservation(db, makeObs("st-b", `${cutoffDatePart}T00:00:00.000Z`, 5));

    await rollupObservations(db);

    const hourly = raw
      .prepare("SELECT DISTINCT location_id FROM weather_observations_hourly")
      .all() as Array<{ location_id: string }>;
    expect(hourly.map((r) => r.location_id)).toEqual(["st-a"]);
  });
});
