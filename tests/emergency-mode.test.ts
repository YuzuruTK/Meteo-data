import { describe, expect, it, vi, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { WeatherSourceConfig } from "../src/collector/types";
import weatherComResponse from "./fixtures/weather-com-response.json";

/**
 * EMERGENCY D1 READ CONSERVATION MODE (docs/emergency-d1-mode.md).
 *
 * Verifies that the emergency feature flags behave as documented:
 *  - DISABLE_ROLLUPS=true skips ALL rollup work entirely — both the
 *    incremental per-observation bucket updates (updateHourlyBucket /
 *    updateDailyRow) and the hourly repair job (rollupObservations).
 *    Collection itself is NOT skipped — observations must keep being stored;
 *  - READ_ONLY_EMERGENCY=true serves 503 maintenance responses on the
 *    expensive dashboard endpoints WITHOUT touching D1 (proved by a db
 *    whose prepare() throws);
 *  - with flags absent, behavior is unchanged (incremental updates run per
 *    observation and the repair runs on the :00 cycle).
 */

const rollupSpy = vi.hoisted(() => vi.fn(async () => ({ hourlyRows: 0, dailyRows: 0 })));
const hourlyBucketSpy = vi.hoisted(() =>
  vi.fn(async () => ({ hour: "2025-06-03 14:00", day: "2025-06-03" })),
);
const dailyRowSpy = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/db/rollups", () => ({
  rollupObservations: rollupSpy,
  updateHourlyBucket: hourlyBucketSpy,
  updateDailyRow: dailyRowSpy,
  // Repair guard pinned to "allowed" so the repair assertions below are
  // deterministic regardless of the wall clock.
  shouldRunRollupRepair: () => true,
  REPAIR_WINDOW_HOURS: 2,
}));

import { runCollection } from "../src/collector/collector";
import { handleApi } from "../src/dashboard/api";

const makeSource = (): WeatherSourceConfig => ({
  id: "weather-com-pws",
  enabled: true,
  request: {
    method: "GET",
    url: "https://api.weather.com/v2/pws/observations/current",
    params: { apikey: "${WEATHER_COM_API_KEY}", units: "m", format: "json" },
    location_param: "stationId",
  },
  locations: [{ id: "loc-1", name: "Only", stationId: "IIJU2" }],
  normalization: {
    observation_selector: "$.observations[0]",
    fields: {
      observed_at: { path: "$.obsTimeUtc" },
      temperature: { path: "$.metric.temp", unit: "C" },
      solar_radiation: { path: "$.solarRadiation", unit: "W/m2" },
    },
  },
});

/** Minimal write-capable D1 mock for collection (reads not needed here). */
class WriteOnlyD1 {
  prepare(_sql: string) {
    const stmt = {
      bind: () => stmt,
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return stmt;
  }
}

/** A D1 stub that must never be touched: any access fails the test. */
class NeverTouchD1 {
  prepare(sql: string): never {
    throw new Error(`D1 accessed during emergency mode: ${sql.slice(0, 60)}`);
  }
}

const okResponse = () => new Response(JSON.stringify(weatherComResponse), { status: 200 });

beforeEach(() => {
  rollupSpy.mockClear();
  hourlyBucketSpy.mockClear();
  dailyRowSpy.mockClear();
});

describe("emergency D1 read conservation mode", () => {
  it("DISABLE_ROLLUPS=true skips rollups but still stores observations", async () => {
    const db = new WriteOnlyD1();
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));

    const run = await runCollection([makeSource()], { DB: db as unknown as D1Database, DISABLE_ROLLUPS: "true", WEATHER_COM_API_KEY: "secret" }, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      concurrency: 1,
    });

    // Collection itself must continue: the observation fetch succeeded.
    expect(run.status).toBe("success");
    expect(run.requests_succeeded).toBe(1);
    // But ALL rollup work was skipped: the per-observation incremental
    // bucket updates and the hourly repair job.
    expect(rollupSpy).not.toHaveBeenCalled();
    expect(hourlyBucketSpy).not.toHaveBeenCalled();
    expect(dailyRowSpy).not.toHaveBeenCalled();
  });

  it("without the flag, incremental updates run per observation and the repair runs", async () => {
    const db = new WriteOnlyD1();
    const fetchMock = vi.fn(() => Promise.resolve(okResponse()));

    const run = await runCollection([makeSource()], { DB: db as unknown as D1Database, WEATHER_COM_API_KEY: "secret" }, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      concurrency: 1,
    });

    expect(run.status).toBe("success");
    expect(hourlyBucketSpy).toHaveBeenCalledTimes(1);
    expect(dailyRowSpy).toHaveBeenCalledTimes(1);
    // Repair guard is mocked to "allowed"; the repair job must run once.
    expect(rollupSpy).toHaveBeenCalledTimes(1);
  });

  it("READ_ONLY_EMERGENCY=true returns 503 without touching D1", async () => {
    const db = new NeverTouchD1() as unknown as D1Database;
    const opts = { readOnlyEmergency: true };

    const req = (path: string) =>
      new Request(`https://example.workers.dev${path}`, {
        method: "GET",
        headers: { origin: "https://example.workers.dev" },
      });

    for (const path of ["/api/stations", "/api/observations/aggregate"]) {
      const res = await handleApi(req(path), db, opts);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
      const body = (await res!.json()) as { maintenance: boolean; message: string };
      expect(body.maintenance).toBe(true);
      expect(body.message).toBe("Temporarily disabled due to database quota exhaustion");
    }
  });

  it("without READ_ONLY_EMERGENCY, endpoints query the database as before", async () => {
    // A db stub that returns empty results; if emergency mode were wrongly
    // active we would get a 503 instead of a 200 with the normal shape.
    const db = {
      prepare: () => {
        throw new Error("unexpected query — this stub only proves the flag is off");
      },
    } as unknown as D1Database;

    const req = new Request("https://example.workers.dev/api/stations", {
      method: "GET",
      headers: { origin: "https://example.workers.dev" },
    });

    // Flag absent: handleApi attempts the query (which this stub rejects),
    // proving the emergency bypass is NOT engaged by default.
    await expect(handleApi(req, db)).rejects.toThrow();
  });
});
