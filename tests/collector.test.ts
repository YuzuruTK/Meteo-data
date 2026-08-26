import { describe, expect, it, vi } from "vitest";
import { runCollection } from "../src/collector/collector";
import type { D1Database } from "@cloudflare/workers-types";
import type { WeatherSourceConfig } from "../src/collector/types";
import weatherComResponse from "./fixtures/weather-com-response.json";

/**
 * Minimal in-memory D1 mock supporting prepare().bind().run()/first()/all().
 * Tracks inserted observation rows to verify duplicate protection.
 */
type Row = Record<string, unknown>;

class FakeD1 {
  locations: Row[] = [];
  observations: Row[] = [];
  runs: Row[] = [];
  requests: Row[] = [];

  prepare(_sql: string): {
    bind: (...args: unknown[]) => {
      run: () => Promise<{ meta: { changes: number }; results?: Row[] }>;
      first: () => Promise<Row | null>;
      all: () => Promise<{ results: Row[] }>;
    };
    run: () => Promise<{ meta: { changes: number }; results?: Row[] }>;
    first: () => Promise<Row | null>;
    all: () => Promise<{ results: Row[] }>;
  } {
    return {
      bind: (...args: unknown[]) => this.execute(_sql, args),
      run: () => this.execute(_sql, []).run(),
      first: () => this.execute(_sql, []).first(),
      all: () => this.execute(_sql, []).all(),
    };
  }

  private execute(sql: string, args: unknown[]) {
    const self = this;
    return {
      async run() {
        if (sql.includes("INSERT OR IGNORE INTO weather_observations")) {
          const cols = [
            "id", "source_id", "location_id", "observed_at", "temperature",
            "solar_radiation", "humidity", "pressure", "wind_speed",
            "wind_direction", "wind_gust", "precipitation_rate",
            "precipitation_total", "uv_index", "cloud_cover", "visibility",
            "collected_at",
          ];
          const row: Row = {};
          cols.forEach((c, i) => (row[c] = args[i]));
          const dup = self.observations.some(
            (o) =>
              o.source_id === row.source_id &&
              o.location_id === row.location_id &&
              o.observed_at === row.observed_at,
          );
          if (!dup) {
            self.observations.push(row);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("INTO weather_locations")) {
          const id = args[0] as string;
          if (!self.locations.some((l) => l.id === id)) {
            self.locations.push({
              id,
              source_id: args[1],
              external_id: args[2],
              name: args[3],
              latitude: args[4],
              longitude: args[5],
            });
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("INTO collector_runs")) {
          self.runs.push({ id: args[0], status: args[2] });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE collector_runs")) {
          const id = args[5] as string;
          const run = self.runs.find((r) => r.id === id);
          if (run) run.status = args[1] as string;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INTO collector_requests")) {
          self.requests.push({ id: args[0], run_id: args[1], status: args[6] });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      async first() {
        if (sql.includes("FROM weather_locations") && sql.includes("SELECT")) {
          const match = self.locations.find(
            (l) => l.source_id === args[0] && l.external_id === args[1],
          );
          return (match ?? null) as Row | null;
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
    };
  }
}

const makeSource = (overrides: Partial<WeatherSourceConfig> = {}): WeatherSourceConfig => {
  return {
    id: "weather-com-pws",
    enabled: true,
    request: {
      method: "GET",
      url: "https://api.weather.com/v2/pws/observations/current",
      params: { apikey: "${WEATHER_COM_API_KEY}", units: "m", format: "json" },
      location_param: "stationId",
    },
    locations: [],
    normalization: {
      observation_selector: "$.observations[0]",
      fields: {
        observed_at: { path: "$.obsTimeUtc" },
        temperature: { path: "$.metric.temp", unit: "C" },
        solar_radiation: { path: "$.solarRadiation", unit: "W/m2" },
      },
    },
    ...overrides,
  };
};

const okResponse = (body: unknown = weatherComResponse) =>
  new Response(JSON.stringify(body), { status: 200 });

describe("collector orchestration", () => {
  it("stores observations for successful locations and isolates failures", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("stationId=OK1")) return Promise.resolve(okResponse());
      if (url.includes("stationId=ERR")) return Promise.resolve(new Response("err", { status: 500 }));
      if (url.includes("stationId=OK2")) return Promise.resolve(okResponse());
      return Promise.resolve(new Response("not found", { status: 404 }));
    });

    const source = makeSource({
      locations: [
        { id: "loc-1", name: "OK1", stationId: "OK1" },
        { id: "loc-2", name: "ERR", stationId: "ERR" },
        { id: "loc-3", name: "OK2", stationId: "OK2" },
      ],
    });

    const run = await runCollection(
      [source],
      { DB: db, WEATHER_COM_API_KEY: "secret" },
      { fetchImpl: fetchMock as unknown as typeof fetch, concurrency: 3 },
    );

    expect(run.status).toBe("partial");
    expect(run.requests_attempted).toBe(3);
    expect(run.requests_succeeded).toBe(2);
    expect(run.requests_failed).toBe(1);

    const locs = (db as unknown as FakeD1).observations.map((o) => o.location_id);
    expect(locs).toContain("loc-1");
    expect(locs).toContain("loc-3");
    expect(locs).not.toContain("loc-2");
  });

  it("deduplicates identical observations (duplicate protection)", async () => {
    const db = new FakeD1() as unknown as D1Database;
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));

    const source = makeSource({
      locations: [{ id: "loc-1", name: "Only", stationId: "IIJU2" }],
    });

    const env = { DB: db, WEATHER_COM_API_KEY: "secret" };

    await runCollection([source], env, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      concurrency: 1,
    });
    await runCollection([source], env, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      concurrency: 1,
    });

    const cols = (db as unknown as FakeD1).observations;
    expect(cols.length).toBe(1);
  });
});