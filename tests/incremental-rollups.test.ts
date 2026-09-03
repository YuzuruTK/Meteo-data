import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { insertObservation } from "../src/db/observations";
import {
  updateDailyRow,
  updateHourlyBucket,
  rollupObservations,
  shouldRunRollupRepair,
  REPAIR_WINDOW_HOURS,
  dayLabelOf,
} from "../src/db/rollups";
import type { NormalizedWeatherObservation } from "../src/collector/types";

/**
 * INCREMENTAL ROLLUP TESTS (perf/incremental-rollups).
 *
 * Two test families, both against REAL SQLite (node:sqlite) with every
 * migration applied:
 *
 * 1. Sargability guards (EXPLAIN QUERY PLAN): every statement prepared by the
 *    incremental/repair writers MUST use index searches (`SEARCH ... USING
 *    INDEX`) and MUST NOT full-scan `weather_observations` or
 *    `weather_observations_hourly`. The rejected designs (time-only repair
 *    bound; `substr(hour,1,10) IN (SELECT DISTINCT ...)`) are documented in
 *    docs/incremental-rollups.md and are permanently locked out by these
 *    tests.
 *
 * 2. Correctness: incremental bucket updates converge EXACTLY to the full
 *    recomputation, handle late arrivals, duplicates, hour/day boundaries,
 *    multiple stations, NULL metrics, and the retention guard (A3).
 *
 * Skipped gracefully if the runtime does not provide `node:sqlite`.
 */

const sqliteModuleName = "node:" + "sqlite"; // dynamic specifier: no static types required
const sqlite = await import(sqliteModuleName).catch(() => null);
const DatabaseSync = sqlite?.DatabaseSync as
  | (new (path?: string) => unknown)
  | undefined;

type RawValues = Partial<
  Record<
    | "temperature"
    | "solar_radiation"
    | "humidity"
    | "pressure"
    | "wind_speed"
    | "wind_direction"
    | "wind_gust"
    | "precipitation_rate"
    | "precipitation_total"
    | "uv_index"
    | "cloud_cover"
    | "visibility",
    number | null
  >
>;

const makeObs = (
  locationId: string,
  observedAt: string,
  values: RawValues = {},
): NormalizedWeatherObservation =>
  ({
    source_id: "weather-com-pws",
    location_id: locationId,
    observed_at: observedAt,
    temperature: null,
    solar_radiation: null,
    humidity: null,
    pressure: null,
    wind_speed: null,
    wind_direction: null,
    wind_gust: null,
    precipitation_rate: null,
    precipitation_total: null,
    uv_index: null,
    cloud_cover: null,
    visibility: null,
    collected_at: new Date().toISOString(),
    ...values,
  }) as NormalizedWeatherObservation;

/**
 * Minimal D1Database adapter over node:sqlite. Supports the surface used by
 * the production functions: prepare().bind().run()/all()/first().
 */
export class SqliteD1 {
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

/** Records every SQL string prepared through it (for EXPLAIN assertions). */
class RecordingD1 {
  statements: string[] = [];
  constructor(private readonly inner: { prepare: (sql: string) => unknown }) {}

  prepare(sql: string) {
    this.statements.push(sql);
    return this.inner.prepare(sql);
  }
}

export function createMigratedDb(): {
  exec: (sql: string) => void;
  prepare: (sql: string) => any;
} {
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
  }) as Glob;
  for (const file of Object.keys(glob).sort()) {
    db.exec(glob[file]!);
  }
  return db;
}

/** EXPLAIN QUERY PLAN details for a captured SQL statement. */
function explainPlans(
  raw: { prepare: (sql: string) => { all: () => unknown[] } },
  sql: string,
): string[] {
  const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail: string;
  }>;
  return rows.map((r) => r.detail);
}

/** No statement may full-scan the observation history or the hourly rollup. */
function assertNoScans(details: string[], label: string): void {
  for (const detail of details) {
    expect(
      detail.includes("SCAN weather_observations"),
      `${label} must not SCAN weather_observations: ${detail}`,
    ).toBe(false);
    expect(
      detail.includes("SCAN weather_observations_hourly"),
      `${label} must not SCAN weather_observations_hourly: ${detail}`,
    ).toBe(false);
  }
}

const BASE = new Date("2025-06-03T09:40:00.000Z");
const iso = (minOffset: number) =>
  new Date(BASE.getTime() + minOffset * 60_000).toISOString();

const d = DatabaseSync ? describe : describe.skip;

d("rollup sargability guards (EXPLAIN QUERY PLAN)", () => {
  it("updateHourlyBucket searches idx_weather_observations_location_time", async () => {
    const raw = createMigratedDb();
    const rec = new RecordingD1(new SqliteD1(raw));

    const obs = makeObs("loc-1", "2025-06-02T12:07:00.000Z", { temperature: 20 });
    await updateHourlyBucket(rec as unknown as D1Database, obs);

    expect(rec.statements).toHaveLength(1);
    const details = rec.statements.flatMap((s) => explainPlans(raw, s));
    assertNoScans(details, "updateHourlyBucket");
    expect(
      details.some((d) =>
        d.includes(
          "SEARCH weather_observations USING INDEX idx_weather_observations_location_time",
        ),
      ),
      `expected SEARCH via idx_weather_observations_location_time, got: ${details.join(" | ")}`,
    ).toBe(true);
  });

  it("updateDailyRow (recent day) searches the hourly primary key", async () => {
    const raw = createMigratedDb();
    const rec = new RecordingD1(new SqliteD1(raw));

    await updateDailyRow(rec as unknown as D1Database, "loc-1", "2025-06-02", BASE);

    const details = rec.statements.flatMap((s) => explainPlans(raw, s));
    assertNoScans(details, "updateDailyRow(hourly)");
    expect(
      details.some(
        (d) =>
          d.includes("SEARCH weather_observations_hourly") &&
          (d.includes("sqlite_autoindex_weather_observations_hourly_1") ||
            d.includes("PRIMARY KEY")),
      ),
      `expected SEARCH via the hourly PK, got: ${details.join(" | ")}`,
    ).toBe(true);
  });

  it("updateDailyRow (pruned day, A3 fallback) stays sargable on the raw table", async () => {
    const raw = createMigratedDb();
    const rec = new RecordingD1(new SqliteD1(raw));

    const oldDay = dayLabelOf(new Date(BASE.getTime() - 200 * 86_400_000));
    await updateDailyRow(rec as unknown as D1Database, "loc-1", oldDay, BASE);

    const details = rec.statements.flatMap((s) => explainPlans(raw, s));
    assertNoScans(details, "updateDailyRow(raw)");
    expect(
      details.some((d) =>
        d.includes(
          "SEARCH weather_observations USING INDEX idx_weather_observations_location_time",
        ),
      ),
      `expected SEARCH via idx_weather_observations_location_time, got: ${details.join(" | ")}`,
    ).toBe(true);
  });

  it("rollupObservations repair performs no full scans (A1 per-location + A2 per-day)", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;
    const rec = new RecordingD1(new SqliteD1(raw));

    raw.exec(
      `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now')),
      ('loc-2', 'src', 'e2', 'Beta', datetime('now'), datetime('now'))`,
    );
    await insertObservation(db, makeObs("loc-1", iso(-90), { temperature: 20 }));
    await insertObservation(db, makeObs("loc-2", iso(-30), { temperature: 25 }));

    await rollupObservations(rec as unknown as D1Database, REPAIR_WINDOW_HOURS, BASE);

    expect(rec.statements.length).toBeGreaterThan(2);
    const details = rec.statements.flatMap((s) => explainPlans(raw, s));
    assertNoScans(details, "rollupObservations");
    // A1: hourly repair per location.
    expect(
      details.some((d) =>
        d.includes(
          "SEARCH weather_observations USING INDEX idx_weather_observations_location_time",
        ),
      ),
    ).toBe(true);
    // A2: daily derivation per (location, day) via the hourly PK.
    expect(
      details.some(
        (d) =>
          d.includes("SEARCH weather_observations_hourly") &&
          (d.includes("sqlite_autoindex_weather_observations_hourly_1") ||
            d.includes("PRIMARY KEY")),
      ),
    ).toBe(true);
    // Retention DELETE stays sargable on the hour index.
    expect(
      details.some((d) =>
        d.includes(
          "SEARCH weather_observations_hourly USING INDEX idx_obs_hourly_hour",
        ),
      ),
    ).toBe(true);
  });
});

/** Run the full incremental write path for one observation (collector parity). */
async function insertIncrementally(
  db: D1Database,
  obs: NormalizedWeatherObservation,
  now: Date,
): Promise<boolean> {
  const stored = await insertObservation(db, obs);
  // Mirror the collector guard: only genuinely new rows update the buckets.
  if (stored.inserted) {
    const bucket = await updateHourlyBucket(db, obs);
    await updateDailyRow(db, obs.location_id, bucket.day, now);
  }
  return stored.inserted;
}

d("incremental rollup correctness", () => {
  it("converges EXACTLY to the full recomputation (parity, 2 stations, NULLs, day boundary)", async () => {
    const rawA = createMigratedDb();
    const rawB = createMigratedDb();
    const dbA = new SqliteD1(rawA) as unknown as D1Database;
    const dbB = new SqliteD1(rawB) as unknown as D1Database;

    // Stations are registered (the collector upserts them before inserting).
    for (const raw of [rawA, rawB]) {
      raw.exec(
        `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
        ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now')),
        ('loc-2', 'src', 'e2', 'Beta', datetime('now'), datetime('now'))`,
      );
    }

    const offsets = [
      -1390, -1330, -1270, -1215, -1150, -1090, -1030, -970, -910, -850,
      -790, -730, -670, -610, -550, -490, -430, -370, -310, -250, -190,
      -130, -70, -10,
    ];

    const seeds: Array<{ loc: string; at: string; v: RawValues }> = [];
    offsets.forEach((min, i) => {
      seeds.push({
        loc: "loc-1",
        at: iso(min),
        v: {
          temperature: 15 + (i % 7),
          humidity: i % 2 === 0 ? 55 + i : null,
          pressure: 1010 + (i % 3),
          wind_speed: i % 4 === 0 ? 12.5 : null,
          precipitation_total: i % 5 === 0 ? 1.5 : 0,
        },
      });
    });
    offsets.slice(0, 12).forEach((min, i) => {
      seeds.push({
        loc: "loc-2",
        at: iso(min),
        v: { temperature: 25 + (i % 5), humidity: 50 },
      });
    });

    // Path A: per-observation incremental updates (as the collector does).
    for (const s of seeds) {
      await insertIncrementally(dbA, makeObs(s.loc, s.at, s.v), BASE);
    }
    // Path B: one full recomputation over the same window.
    for (const s of seeds) {
      await insertObservation(dbB, makeObs(s.loc, s.at, s.v));
    }
    await rollupObservations(dbB, 24, BASE);

    const hourlyA = rawA
      .prepare("SELECT * FROM weather_observations_hourly ORDER BY location_id, hour")
      .all();
    const hourlyB = rawB
      .prepare("SELECT * FROM weather_observations_hourly ORDER BY location_id, hour")
      .all();
    const dailyA = rawA
      .prepare("SELECT * FROM weather_observations_daily ORDER BY location_id, day")
      .all();
    const dailyB = rawB
      .prepare("SELECT * FROM weather_observations_daily ORDER BY location_id, day")
      .all();

    expect(hourlyA.length).toBeGreaterThan(20);
    expect(hourlyA).toEqual(hourlyB);
    // loc-1 spans June 2 (14 obs) + June 3 (10 obs); loc-2 spans June 2 (12 obs).
    expect(dailyA.length).toBeGreaterThanOrEqual(2);
    expect(dailyA).toEqual(dailyB);
  });

  it("routes 12:07 into the 12:00 bucket and the correct UTC day", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    const obs = makeObs("loc-1", "2025-06-02T12:07:00.000Z", { temperature: 21 });
    await insertObservation(db, obs);
    const bucket = await updateHourlyBucket(db, obs);
    await updateDailyRow(db, obs.location_id, bucket.day, BASE);

    expect(bucket.hour).toBe("2025-06-02 12:00");
    expect(bucket.day).toBe("2025-06-02");

    const hourly = raw.prepare("SELECT * FROM weather_observations_hourly").all() as Array<{
      hour: string;
      observation_count: number;
      temperature_avg: number | null;
    }>;
    const daily = raw.prepare("SELECT * FROM weather_observations_daily").all() as Array<{
      day: string;
      observation_count: number;
    }>;
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.hour).toBe("2025-06-02 12:00");
    expect(hourly[0]!.observation_count).toBe(1);
    expect(hourly[0]!.temperature_avg).toBe(21);
    expect(daily).toHaveLength(1);
    expect(daily[0]!.day).toBe("2025-06-02");
  });

  it("handles the 23:59 -> 00:00 day boundary", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T23:59:00.000Z", { temperature: 20 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-03T00:01:00.000Z", { temperature: 22 }), BASE);

    const hourly = raw
      .prepare("SELECT hour, observation_count FROM weather_observations_hourly ORDER BY hour")
      .all() as Array<{ hour: string; observation_count: number }>;
    const daily = raw
      .prepare("SELECT day, observation_count FROM weather_observations_daily ORDER BY day")
      .all() as Array<{ day: string; observation_count: number }>;

    expect(hourly).toEqual([
      { hour: "2025-06-02 23:00", observation_count: 1 },
      { hour: "2025-06-03 00:00", observation_count: 1 },
    ]);
    expect(daily).toEqual([
      { day: "2025-06-02", observation_count: 1 },
      { day: "2025-06-03", observation_count: 1 },
    ]);
  });

  it("late/out-of-order observations recompute their own bucket exactly", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    // Insert out of order; the last one is the earliest.
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:10:00.000Z", { temperature: 30 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:05:00.000Z", { temperature: 20 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:02:00.000Z", { temperature: 10 }), BASE);

    const hourly = raw.prepare("SELECT * FROM weather_observations_hourly").all() as Array<{
      observation_count: number;
      temperature_avg: number | null;
      temperature_min: number | null;
      temperature_max: number | null;
    }>;
    const daily = raw.prepare("SELECT * FROM weather_observations_daily").all() as Array<{
      observation_count: number;
      temperature_avg: number | null;
    }>;

    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.observation_count).toBe(3);
    expect(hourly[0]!.temperature_avg).toBe(20);
    expect(hourly[0]!.temperature_min).toBe(10);
    expect(hourly[0]!.temperature_max).toBe(30);
    expect(daily[0]!.observation_count).toBe(3);
    expect(daily[0]!.temperature_avg).toBe(20);
  });

  it("duplicates (INSERT OR IGNORE) never double-count", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;
    const obs = makeObs("loc-1", "2025-06-02T12:07:00.000Z", { temperature: 21 });

    expect(await insertIncrementally(db, obs, BASE)).toBe(true);
    expect(await insertIncrementally(db, obs, BASE)).toBe(false);

    const hourly = raw
      .prepare("SELECT observation_count FROM weather_observations_hourly")
      .all() as Array<{ observation_count: number }>;
    const daily = raw
      .prepare("SELECT observation_count FROM weather_observations_daily")
      .all() as Array<{ observation_count: number }>;
    expect(hourly[0]!.observation_count).toBe(1);
    expect(daily[0]!.observation_count).toBe(1);
  });

  it("keeps stations isolated (multiple stations in the same hour)", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:07:00.000Z", { temperature: 20 }), BASE);
    await insertIncrementally(db, makeObs("loc-2", "2025-06-02T12:07:00.000Z", { temperature: 30 }), BASE);

    const hourly = raw
      .prepare("SELECT location_id, observation_count, temperature_avg FROM weather_observations_hourly ORDER BY location_id")
      .all() as Array<{ location_id: string; observation_count: number; temperature_avg: number | null }>;
    expect(hourly).toEqual([
      { location_id: "loc-1", observation_count: 1, temperature_avg: 20 },
      { location_id: "loc-2", observation_count: 1, temperature_avg: 30 },
    ]);
  });

  it("derives recent daily rows from the hourly table with count-weighted averages", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    // Hour 12: three observations averaging 20; hour 13: one observation of 30.
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:05:00.000Z", { temperature: 15 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:30:00.000Z", { temperature: 20 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T12:55:00.000Z", { temperature: 25 }), BASE);
    await insertIncrementally(db, makeObs("loc-1", "2025-06-02T13:20:00.000Z", { temperature: 30 }), BASE);

    const daily = raw.prepare("SELECT * FROM weather_observations_daily").all() as Array<{
      observation_count: number;
      temperature_avg: number | null;
      temperature_min: number | null;
      temperature_max: number | null;
    }>;
    expect(daily).toHaveLength(1);
    expect(daily[0]!.observation_count).toBe(4);
    expect(daily[0]!.temperature_avg).toBeCloseTo(22.5, 6);
    expect(daily[0]!.temperature_min).toBe(15);
    expect(daily[0]!.temperature_max).toBe(30);
  });

  it("A3: daily rows for pruned days (>180d) derive from raw data, never stale hourly rows", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    const oldDay = dayLabelOf(new Date(BASE.getTime() - 200 * 86_400_000));
    const obs = makeObs("loc-1", `${oldDay}T12:07:00.000Z`, {
      temperature: 21,
      precipitation_total: 3,
    });
    await insertObservation(db, obs);

    // Poison the hourly cache for that day with stale/partial data: if the
    // retention guard were missing, the daily row would be built from it.
    raw.exec(
      `INSERT INTO weather_observations_hourly (location_id, hour, temperature_avg, observation_count)
       VALUES ('loc-1', '${oldDay} 00:00', 99, 999)`,
    );

    await updateDailyRow(db, "loc-1", oldDay, BASE);

    const daily = raw.prepare("SELECT * FROM weather_observations_daily").all() as Array<{
      observation_count: number;
      temperature_avg: number | null;
      temperature_min: number | null;
      precipitation_total_sum: number | null;
    }>;
    expect(daily).toHaveLength(1);
    expect(daily[0]!.observation_count).toBe(1);
    expect(daily[0]!.temperature_avg).toBe(21);
    expect(daily[0]!.temperature_min).toBe(21);
    expect(daily[0]!.precipitation_total_sum).toBe(3);
  });

  it("repair job heals buckets that missed the incremental update", async () => {
    const raw = createMigratedDb();
    const db = new SqliteD1(raw) as unknown as D1Database;

    raw.exec(
      `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now'))`,
    );
    // Raw rows inserted WITHOUT any rollup afterwards (simulates a failed
    // best-effort incremental update).
    await insertObservation(db, makeObs("loc-1", iso(-90), { temperature: 18 }));
    await insertObservation(db, makeObs("loc-1", iso(-85), { temperature: 22 }));

    await rollupObservations(db, REPAIR_WINDOW_HOURS, BASE);

    const hourly = raw.prepare("SELECT * FROM weather_observations_hourly").all() as Array<{
      hour: string;
      observation_count: number;
      temperature_avg: number | null;
    }>;
    const daily = raw.prepare("SELECT * FROM weather_observations_daily").all() as Array<{
      observation_count: number;
      temperature_avg: number | null;
    }>;
    expect(hourly).toHaveLength(1);
    expect(hourly[0]!.observation_count).toBe(2);
    expect(hourly[0]!.temperature_avg).toBe(20);
    expect(daily).toHaveLength(1);
    expect(daily[0]!.observation_count).toBe(2);
    expect(daily[0]!.temperature_avg).toBe(20);
  });
});

d("repair scheduling guard", () => {
  it("fires only on the :00 UTC cycle", () => {
    expect(shouldRunRollupRepair(new Date("2025-06-03T14:00:07Z"))).toBe(true);
    expect(shouldRunRollupRepair(new Date("2025-06-03T14:05:00Z"))).toBe(false);
    expect(shouldRunRollupRepair(new Date("2025-06-03T14:55:59Z"))).toBe(false);
  });
});