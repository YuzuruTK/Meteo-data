import { describe, expect, it } from "vitest";
import { getHourlyAverages, getStations } from "../src/dashboard/aggregate";
import { handleApi } from "../src/dashboard/api";
import type { D1Database } from "@cloudflare/workers-types";
import type { HourlyAverageRow, StationRow } from "../src/dashboard/aggregate";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory D1 mock that supports the aggregation queries used by the
 * dashboard (SELECT ... FROM weather_observations JOIN weather_locations ...).
 * Supports both `prepare().all()` (no bindings) and `prepare().bind(...).all()`.
 * For the aggregate query, if a bucket has exactly two observations it averages
 * them pairwise (temperature, solar_radiation, humidity).
 */
interface Prepared {
  bind: (...args: unknown[]) => { all: () => Promise<{ results: Row[] }> };
  all: () => Promise<{ results: Row[] }>;
}

class FakeD1 {
  observations: Row[] = [];
  hourly: Row[] = [];
  latest: Row[] = [];
  locations: Row[] = [];
  summary: Row[] = [];

  prepare(sql: string): Prepared {
    return {
      bind: (...args: unknown[]) => this.execute(sql, args),
      all: () => this.execute(sql, []).all(),
    };
  }

  private execute(sql: string, bindings: unknown[]): {
    all: () => Promise<{ results: Row[] }>;
  } {
    const self = this;
    return {
      async all(): Promise<{ results: Row[] }> {
        // Aggregate query: reads the materialized hourly rollup
        // (getHourlyAverages reads weather_observations_hourly).
        if (sql.includes("weather_observations_hourly")) {
          const stationFilter = bindings[0] as string | undefined;
          const rows: Row[] = self.hourly
            .filter((h) => !stationFilter || h.location_id === stationFilter)
            .map((h) => {
              const loc = self.locations.find((l) => l.id === h.location_id);
              const count = self.num(h.observation_count) ?? 0;
              const total = self.num(h.precipitation_total_sum);
              return {
                station_id: h.location_id,
                station_name: (loc?.name as string) ?? "",
                hour: h.hour,
                temperature_avg: self.num(h.temperature_avg),
                solar_radiation_avg: self.num(h.solar_radiation_avg),
                humidity_avg: self.num(h.humidity_avg),
                pressure_avg: self.num(h.pressure_avg),
                wind_speed_avg: self.num(h.wind_speed_avg),
                wind_direction_avg: self.num(h.wind_direction_avg),
                wind_gust_avg: self.num(h.wind_gust_avg),
                precipitation_rate_avg: self.num(h.precipitation_rate_avg),
                precipitation_total_avg:
                  count > 0 && total !== null ? total / count : null,
                uv_index_avg: self.num(h.uv_index_avg),
                cloud_cover_avg: self.num(h.cloud_cover_avg),
                visibility_avg: self.num(h.visibility_avg),
              };
            });
          rows.sort((a, b) => (a.hour as string).localeCompare(b.hour as string));
          return { results: rows };
        }

        // Stations query: latest-observation-per-station with a stale flag,
        // read from the materialized latest-state table (getStations reads
        // latest_weather_observations).
        if (sql.includes("latest_weather_observations")) {
          const results: Row[] = [];
          for (const l of self.latest) {
            const loc = self.locations.find((x) => x.id === l.location_id);
            if (!loc) continue;
            const lastObservedAt = l.observed_at as string;
            results.push({
              id: loc.id,
              source_id: loc.source_id,
              name: loc.name,
              last_observed_at: lastObservedAt,
              stale: self.isStale(lastObservedAt) ? 1 : 0,
            });
          }
          return { results };
        }

        if (sql.includes("FROM weather_locations")) {
          return { results: self.locations as Row[] };
        }

        if (sql.includes("FROM dashboard_summary")) {
          return { results: self.summary as Row[] };
        }

        return { results: [] };
      },
    };
  }

  private num(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isNaN(n) ? null : n;
  }

  isStale(ts: string): boolean {
    const d = new Date(ts).getTime();
    return new Date().getTime() - d > 15 * 60 * 1000;
  }
}

describe("dashboard aggregation (rollup read path)", () => {
  it("groups observations by station and hour, averaging each variable", async () => {
    const db = new FakeD1();
    db.locations.push({ id: "loc-1", source_id: "src", name: "Ijuí A" });
    // Pre-aggregated hourly rollup rows, exactly what
    // rollupObservations() would persist for these raw observations.
    db.hourly.push(
      {
        location_id: "loc-1", hour: "2025-01-01 10:00",
        temperature_avg: 21, solar_radiation_avg: 110, humidity_avg: 57.5,
        pressure_avg: null, wind_speed_avg: null, wind_direction_avg: null,
        wind_gust_avg: null, precipitation_rate_avg: null,
        precipitation_total_sum: 2, observation_count: 2,
        uv_index_avg: null, cloud_cover_avg: null, visibility_avg: null,
      },
      {
        location_id: "loc-1", hour: "2025-01-01 11:00",
        temperature_avg: 24, solar_radiation_avg: 150, humidity_avg: 50,
        pressure_avg: null, wind_speed_avg: null, wind_direction_avg: null,
        wind_gust_avg: null, precipitation_rate_avg: null,
        precipitation_total_sum: null, observation_count: 1,
        uv_index_avg: null, cloud_cover_avg: null, visibility_avg: null,
      },
    );

    const rows = await getHourlyAverages(db as unknown as D1Database, { hours: 24 });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.station_id).toBe("loc-1");
    expect(rows[0]?.station_name).toBe("Ijuí A");
    expect(rows[0]?.hour).toBe("2025-01-01 10:00");
    expect(rows[0]?.temperature_avg).toBe(21);
    expect(rows[0]?.solar_radiation_avg).toBe(110);
    expect(rows[0]?.humidity_avg).toBe(57.5);
    // precipitation_total_avg derived as sum / count.
    expect(rows[0]?.precipitation_total_avg).toBe(1);
    expect(rows[1]?.temperature_avg).toBe(24);
  });

  it("filters to a single station when requested", async () => {
    const db = new FakeD1();
    db.locations.push(
      { id: "loc-1", source_id: "src", name: "A" },
      { id: "loc-2", source_id: "src", name: "B" },
    );
    db.hourly.push(
      {
        location_id: "loc-1", hour: "2025-01-01 10:00",
        temperature_avg: 20, observation_count: 1,
      },
      {
        location_id: "loc-2", hour: "2025-01-01 10:00",
        temperature_avg: 30, observation_count: 1,
      },
    );

    const rows = await getHourlyAverages(db as unknown as D1Database, { hours: 24, station: "loc-2" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.station_id).toBe("loc-2");
  });

  it("lists stations from latest state, falling back to all locations", async () => {
    const db = new FakeD1();
    db.locations.push(
      { id: "loc-1", source_id: "src", name: "A" },
      { id: "loc-2", source_id: "src", name: "B" },
    );
    db.latest.push({ location_id: "loc-1", observed_at: "2025-01-01T10:00:00Z" });

    const stations = await getStations(db as unknown as D1Database, { hours: 24 });
    expect(stations).toHaveLength(1);
    expect(stations[0]?.id).toBe("loc-1");
  });

  it("flags stations as stale when their latest observation is old", async () => {
    const db = new FakeD1();
    db.locations.push(
      { id: "loc-1", source_id: "src", name: "Fresh" },
      { id: "loc-2", source_id: "src", name: "Old" },
    );
    // Set stale directly on the mock data so the test does not depend on
    // wall-clock timing.
    db.latest.push(
      { location_id: "loc-1", observed_at: "2025-06-01T12:00:00Z" },
      { location_id: "loc-2", observed_at: "2020-01-01T00:00:00Z" },
    );
    // Override isStale for this test: loc-1 is fresh, loc-2 is stale.
    db.isStale = (ts: string) => ts.startsWith("2020");

    const stations = await getStations(db as unknown as D1Database, { hours: 24 * 365 * 10, staleMinutes: 15 });
    const fresh = stations.find((s) => s.id === "loc-1");
    const stale = stations.find((s) => s.id === "loc-2");
    expect(fresh?.stale).toBe(false);
    expect(fresh?.last_observed_at).toBe("2025-06-01T12:00:00Z");
    expect(stale?.stale).toBe(true);
    expect(stale?.last_observed_at).toBe("2020-01-01T00:00:00Z");
  });
});

describe("dashboard summary API", () => {
  it("returns the precomputed summary for /api/summary", async () => {
    const db = new FakeD1();
    db.summary.push({
      location_id: "loc-1",
      station_name: "Ijuí",
      observed_at: "2025-01-01T10:00:00Z",
      temperature: 20,
      humidity: 60,
    });

    const req = new Request("https://example.workers.dev/api/summary", {
      method: "GET",
      headers: { origin: "https://example.workers.dev" },
    });
    const res = await handleApi(req, db as unknown as D1Database);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { summaries: Row[] };
    expect(body.summaries).toHaveLength(1);
    expect(body.summaries[0]?.station_name).toBe("Ijuí");
  });
});

describe("dashboard API", () => {
  it("returns aggregate JSON for /api/observations/aggregate", async () => {
    const db = new FakeD1();
    db.locations.push({ id: "loc-1", source_id: "src", name: "Ijuí A" });
    db.hourly.push({
      location_id: "loc-1", hour: "2025-01-01 10:00",
      temperature_avg: 20, observation_count: 1,
    });

    const req = new Request("https://example.workers.dev/api/observations/aggregate?hours=24", {
      method: "GET",
      headers: { origin: "https://example.workers.dev" },
    });
    const res = await handleApi(req, db as unknown as D1Database);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      columns: string[];
      rows: HourlyAverageRow[];
      filters: { hours: number };
    };
    expect(body.columns).toContain("temperature");
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.temperature_avg).toBe(20);
    expect(body.filters.hours).toBe(24);
  });

  it("returns null for unknown /api paths", async () => {
    const db = new FakeD1();
    const req = new Request("https://example.workers.dev/api/nope", { method: "GET" });
    const res = await handleApi(req, db as unknown as D1Database);
    expect(res).toBeNull();
  });
});