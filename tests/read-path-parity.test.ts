import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { insertObservation } from "../src/db/observations";
import { upsertLatestObservation } from "../src/db/latest";
import { rollupObservations } from "../src/db/rollups";
import { getHourlyAverages, getStations } from "../src/dashboard/aggregate";
import type { HourlyAverageRow, StationRow } from "../src/dashboard/aggregate";
import type { NormalizedWeatherObservation } from "../src/collector/types";

/**
 * READ-PATH PARITY TESTS (perf/read-path-rollup-tables).
 *
 * Prove that the optimized read path — getHourlyAverages() over the
 * materialized `weather_observations_hourly` rollup and getStations() over
 * the materialized `latest_weather_observations` table — produces responses
 * equivalent to computing the same values from the raw
 * `weather_observations` history, which is what the previous implementation
 * did on every request.
 *
 * Runs against REAL SQLite (node:sqlite) with every migration applied,
 * exercising the production rollup writer (rollupObservations) and the
 * production read functions end-to-end. Skipped gracefully if the runtime
 * does not provide `node:sqlite`.
 */

const sqliteModuleName = "node:" + "sqlite"; // dynamic specifier: no static types required
const sqlite = await import(sqliteModuleName).catch(() => null);
const DatabaseSync = sqlite?.DatabaseSync as
  | (new (path?: string) => unknown)
  | undefined;

const AGG_FIELDS = [
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_direction",
  "wind_gust",
  "precipitation_rate",
  "precipitation_total",
  "uv_index",
  "cloud_cover",
  "visibility",
] as const;

type RawValues = Partial<Record<(typeof AGG_FIELDS)[number], number | null>>;

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

/** JS reference implementation: hourly averages computed from raw rows. */
function expectedHourlyAverages(
  rows: Array<{ location_id: string; observed_at: string } & RawValues>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, RawValues[]>();
  for (const r of rows) {
    const d = new Date(r.observed_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    const hour = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
    const key = `${r.location_id}|${hour}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(r);
    groups.set(key, bucket);
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [key, bucket] of Array.from(groups.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const [locationId, hour] = key.split("|");
    const row: Record<string, unknown> = {
      station_id: locationId,
      station_name: locationId === "loc-1" ? "Alpha" : "Beta",
      hour,
    };
    for (const f of AGG_FIELDS) {
      const vals = bucket
        .map((b) => b[f])
        .filter((v): v is number => typeof v === "number");
      row[`${f}_avg`] =
        vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    out.push(row);
  }
  return out;
}

/** Compare produced vs expected rows, ignoring floating-point dust. */
function expectSameRows(
  produced: HourlyAverageRow[],
  expected: Array<Record<string, unknown>>,
) {
  // Both sides sorted identically (hour, then station) so the comparison is
  // independent of each implementation's internal ordering.
  const byKey = (r: Record<string, unknown>) =>
    `${r.hour}|${r.station_id}`;
  const sortedProduced = [...(produced as unknown as Array<Record<string, unknown>>)].sort((a, b) =>
    byKey(a).localeCompare(byKey(b)),
  );
  const sortedExpected = [...expected].sort((a, b) => byKey(a).localeCompare(byKey(b)));
  expect(sortedProduced).toHaveLength(sortedExpected.length);
  for (let i = 0; i < sortedProduced.length; i++) {
    const p = sortedProduced[i]!;
    const e = sortedExpected[i]!;
    expect(p.station_id).toBe(e.station_id);
    expect(p.station_name).toBe(e.station_name);
    expect(p.hour).toBe(e.hour);
    for (const f of AGG_FIELDS) {
      const pv = p[`${f}_avg`] as number | null;
      const ev = e[`${f}_avg`] as number | null;
      if (ev === null || ev === undefined) {
        expect(pv).toBeNull();
      } else {
        expect(pv).not.toBeNull();
        expect(Math.abs((pv as number) - ev)).toBeLessThan(1e-9);
      }
    }
  }
}

const d = DatabaseSync ? describe : describe.skip;

d("read-path parity: rollup tables vs raw computation", () => {
  it("getHourlyAverages over the rollup matches raw-table aggregation", async () => {
    const raw = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(raw) as unknown as D1Database;

    raw.exec(
      `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now')),
      ('loc-2', 'src', 'e2', 'Beta', datetime('now'), datetime('now'))`,
    );

    const now = Date.now();
    const iso = (minOffset: number) =>
      new Date(now + minOffset * 60_000).toISOString();

    // Realistic mixed dataset: two stations, several hours, multiple
    // observations per bucket, NULL-heavy rows, precipitation.
    const seeds: Array<{ loc: string; at: string; values: RawValues }> = [
      { loc: "loc-1", at: iso(-30), values: { temperature: 20.5, humidity: 61, precipitation_total: 2.4 } },
      { loc: "loc-1", at: iso(-25), values: { temperature: 22.5, humidity: 55, precipitation_total: 1.6 } },
      { loc: "loc-1", at: iso(-20), values: { temperature: 24, solar_radiation: 150, precipitation_total: 0 } },
      { loc: "loc-1", at: iso(-95), values: { temperature: 18, pressure: 1013.2, wind_speed: 3.5 } },
      { loc: "loc-1", at: iso(-90), values: { temperature: 19, pressure: 1013.0, wind_speed: 4.1, wind_gust: 9.2 } },
      { loc: "loc-2", at: iso(-40), values: { temperature: 30, humidity: 40, uv_index: 5 } },
      { loc: "loc-2", at: iso(-35), values: { temperature: 32, humidity: 42, cloud_cover: 20 } },
      { loc: "loc-2", at: iso(-200), values: { temperature: 28, visibility: 10 } },
    ];

    for (const s of seeds) {
      await insertObservation(db, makeObs(s.loc, s.at, s.values));
      await upsertLatestObservation(db, makeObs(s.loc, s.at, s.values));
    }
    await rollupObservations(db);

    const produced = await getHourlyAverages(db, { hours: 24 });
    const expected = expectedHourlyAverages(
      seeds.map((s) => ({ location_id: s.loc, observed_at: s.at, ...s.values })),
    );
    expectSameRows(produced, expected);

    // Documented rollup semantics: precipitation_total_avg is derived as
    // precipitation_total_sum / observation_count, which equals the raw AVG
    // exactly when every observation in a bucket reports the field (true for
    // the production weather.com PWS source).

    // Station filter must produce the same per-station subset.
    const filtered = await getHourlyAverages(db, { hours: 24, station: "loc-2" });
    expectSameRows(
      filtered,
      expected.filter((e) => e.station_id === "loc-2"),
    );
  });

  it("getStations over the latest-state table matches raw-history computation", async () => {
    const raw = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    const db = new SqliteD1(raw) as unknown as D1Database;

    raw.exec(
      `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now')),
      ('loc-2', 'src', 'e2', 'Beta', datetime('now'), datetime('now')),
      ('loc-3', 'src', 'e3', 'Gamma', datetime('now'), datetime('now'))`,
    );

    const now = Date.now();
    const iso = (minOffset: number) =>
      new Date(now + minOffset * 60_000).toISOString();

    // loc-1: fresh; loc-2: latest 30 min old (stale); loc-3: no observations
    // at all (must be absent from the primary list).
    const seeds: Array<{ loc: string; at: string; values: RawValues }> = [
      { loc: "loc-1", at: iso(-2), values: { temperature: 21 } },
      { loc: "loc-1", at: iso(-10), values: { temperature: 22 } },
      { loc: "loc-2", at: iso(-45), values: { temperature: 30 } },
      { loc: "loc-2", at: iso(-30), values: { temperature: 31 } },
    ];

    for (const s of seeds) {
      await insertObservation(db, makeObs(s.loc, s.at, s.values));
      await upsertLatestObservation(db, makeObs(s.loc, s.at, s.values));
    }

    const stations = (await getStations(db, {
      hours: 24,
      staleMinutes: 15,
    })) as StationRow[];

    // Reference: latest observation per station from the raw history.
    const latestByLoc = new Map<string, string>();
    for (const s of seeds) {
      const prev = latestByLoc.get(s.loc);
      if (!prev || s.at > prev) latestByLoc.set(s.loc, s.at);
    }

    const byId = new Map(stations.map((s) => [s.id, s]));
    expect(stations.map((s) => s.id).sort()).toEqual(["loc-1", "loc-2"]);

    for (const [locId, at] of latestByLoc.entries()) {
      const row = byId.get(locId);
      expect(row).toBeDefined();
      expect(row!.last_observed_at).toBe(at);
      const stale = now - new Date(at).getTime() > 15 * 60_000;
      expect(row!.stale).toBe(stale);
    }

    // Fallback path unchanged: empty latest table → all configured locations.
    const raw2 = createMigratedDb() as {
      exec: (sql: string) => void;
      prepare: (sql: string) => any;
    };
    raw2.exec(
      `INSERT INTO weather_locations (id, source_id, external_id, name, created_at, updated_at) VALUES
      ('loc-1', 'src', 'e1', 'Alpha', datetime('now'), datetime('now')),
      ('loc-3', 'src', 'e3', 'Gamma', datetime('now'), datetime('now'))`,
    );
    const empty = await getStations(
      new SqliteD1(raw2) as unknown as D1Database,
      { hours: 24 },
    );
    expect(empty.map((s) => s.id)).toEqual(["loc-1", "loc-3"]);
    expect(
      empty.every((s) => s.last_observed_at === null && s.stale === false),
    ).toBe(true);
  });
});
