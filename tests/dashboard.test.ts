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
  locations: Row[] = [];

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
        const observed = sql.includes("weather_observations");

        if (observed && sql.includes("weather_locations") && sql.includes("GROUP BY")) {
          // Aggregate query: group by location + hour, optionally filtered by station.
          const stationFilter = bindings[0] as string | undefined;
          const groups = new Map<string, Row[]>();
          for (const o of self.observations) {
            if (stationFilter && o.location_id !== stationFilter) continue;
            const key = `${o.location_id}|${self.hourOf(o.observed_at as string)}`;
            const bucket = groups.get(key) ?? [];
            bucket.push(o);
            groups.set(key, bucket);
          }
          const rows: HourlyAverageRow[] = Array.from(groups.entries()).map(([key, bucket]) => {
            const [locId, hour] = key.split("|") as [string, string];
            const loc = self.locations.find((l) => l.id === locId);
            // Two-value average of each numeric column (test uses 1 or 2 per bucket).
            const avgOf = (field: string) =>
              bucket.length === 2
                ? self.avg2(bucket[0]?.[field], bucket[1]?.[field])
                : self.num(bucket[0]?.[field]);
            return {
              station_id: locId,
              station_name: (loc?.name as string) ?? "",
              hour,
              temperature_avg: avgOf("temperature"),
              solar_radiation_avg: avgOf("solar_radiation"),
              humidity_avg: avgOf("humidity"),
              pressure_avg: avgOf("pressure"),
              wind_speed_avg: avgOf("wind_speed"),
              wind_direction_avg: avgOf("wind_direction"),
              wind_gust_avg: avgOf("wind_gust"),
              precipitation_rate_avg: avgOf("precipitation_rate"),
              precipitation_total_avg: avgOf("precipitation_total"),
              uv_index_avg: avgOf("uv_index"),
              cloud_cover_avg: avgOf("cloud_cover"),
              visibility_avg: avgOf("visibility"),
            };
          });
          rows.sort((a, b) => a.hour.localeCompare(b.hour));
          return { results: rows as unknown as Row[] };
        }

        if (observed && sql.includes("DISTINCT")) {
          const seen = new Set<string>();
          const results: StationRow[] = [];
          for (const o of self.observations) {
            const loc = self.locations.find((l) => l.id === o.location_id);
            if (!loc || seen.has(loc.id as string)) continue;
            seen.add(loc.id as string);
            results.push({
              id: loc.id as string,
              source_id: loc.source_id as string,
              name: loc.name as string,
            });
          }
          return { results: results as unknown as Row[] };
        }

        if (sql.includes("FROM weather_locations") && !observed) {
          return { results: self.locations as Row[] };
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

  private avg2(a: unknown, b: unknown): number | null {
    const na = this.num(a);
    const nb = this.num(b);
    if (na === null) return nb;
    if (nb === null) return na;
    return (na + nb) / 2;
  }

  private hourOf(ts: string): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
  }
}

describe("dashboard aggregation", () => {
  it("groups observations by station and hour, averaging each variable", async () => {
    const db = new FakeD1();
    db.locations.push({ id: "loc-1", source_id: "src", name: "Ijuí A" });
    db.observations.push(
      {
        location_id: "loc-1", observed_at: "2025-01-01T10:00:00Z",
        temperature: 20, solar_radiation: 100, humidity: 60,
      },
      {
        location_id: "loc-1", observed_at: "2025-01-01T10:30:00Z",
        temperature: 22, solar_radiation: 120, humidity: 55,
      },
      {
        location_id: "loc-1", observed_at: "2025-01-01T11:00:00Z",
        temperature: 24, solar_radiation: 150, humidity: 50,
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
    expect(rows[1]?.temperature_avg).toBe(24);
  });

  it("filters to a single station when requested", async () => {
    const db = new FakeD1();
    db.locations.push(
      { id: "loc-1", source_id: "src", name: "A" },
      { id: "loc-2", source_id: "src", name: "B" },
    );
    db.observations.push(
      { location_id: "loc-1", observed_at: "2025-01-01T10:00:00Z", temperature: 20 },
      { location_id: "loc-2", observed_at: "2025-01-01T10:00:00Z", temperature: 30 },
    );

    const rows = await getHourlyAverages(db as unknown as D1Database, { hours: 24, station: "loc-2" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.station_id).toBe("loc-2");
  });

  it("lists stations from observations, falling back to all locations", async () => {
    const db = new FakeD1();
    db.locations.push(
      { id: "loc-1", source_id: "src", name: "A" },
      { id: "loc-2", source_id: "src", name: "B" },
    );
    db.observations.push({ location_id: "loc-1", observed_at: "2025-01-01T10:00:00Z", temperature: 20 });

    const stations = await getStations(db as unknown as D1Database, { hours: 24 });
    expect(stations).toHaveLength(1);
    expect(stations[0]?.id).toBe("loc-1");
  });
});

describe("dashboard API", () => {
  it("returns aggregate JSON for /api/observations/aggregate", async () => {
    const db = new FakeD1();
    db.locations.push({ id: "loc-1", source_id: "src", name: "Ijuí A" });
    db.observations.push({
      location_id: "loc-1", observed_at: "2025-01-01T10:00:00Z", temperature: 20,
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