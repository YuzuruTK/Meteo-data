import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  upsertLatestObservation,
  loadLatestStations,
  STALE_MINUTES,
} from "../src/db/latest";
import { runRainAlerts } from "../src/push/alerts";
import { insertSubscription } from "../src/push/subscriptions";
import { sendNotification } from "web-push-neo";
import type { NormalizedWeatherObservation } from "../src/collector/types";

vi.mock("web-push-neo", () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}));

type Row = Record<string, unknown>;

/** ISO timestamp N minutes in the future/past relative to now. */
const minutesFromNow = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const makeObs = (
  overrides: Partial<NormalizedWeatherObservation> = {},
): NormalizedWeatherObservation => ({
  source_id: "weather-com-pws",
  location_id: "loc-1",
  observed_at: minutesFromNow(0),
  temperature: 20,
  solar_radiation: null,
  humidity: 60,
  pressure: null,
  wind_speed: null,
  wind_direction: null,
  wind_gust: null,
  precipitation_rate: 0,
  precipitation_total: null,
  uv_index: null,
  cloud_cover: null,
  visibility: null,
  collected_at: minutesFromNow(0),
  ...overrides,
});

/**
 * Minimal in-memory D1 mock emulating the `latest_weather_observations`
 * table (including the out-of-order guard) and the latest-station SELECT
 * used by loadLatestStations, joined against weather_locations.
 */
class FakeD1 {
  locations = new Map<string, string>(); // id -> name
  latest = new Map<string, Row>(); // location_id -> latest row
  rainStates = new Map<string, Row>(); // weather_alert_state
  subscriptions: Row[] = [];
  /** Last SQL string seen — used to assert query sources. */
  lastSql = "";
  sawInsert = false;
  sawSelect = false;

  prepare(sql: string) {
    this.lastSql = sql;
    if (sql.includes("FROM latest_weather_observations")) this.sawSelect = true;
    if (sql.includes("INTO latest_weather_observations")) this.sawInsert = true;
    const self = this;
    return {
      bind: (...args: unknown[]) => this.execute(sql, args),
      all: () => this.execute(sql, []).all(),
      first: <T>() => this.execute(sql, []).first<T>(),
      run: () => this.execute(sql, []).run(),
    };
  }

  private execute(sql: string, bindings: unknown[]) {
    const self = this;
    return {
      run: async () => {
        if (sql.includes("INTO latest_weather_observations")) {
          const [locationId, observedAt, , , , updatedAt] = bindings as [
            string, string, number | null, number | null, number | null, string,
          ];
          const existing = self.latest.get(locationId);
          // Mirror the SQL guard: never overwrite a newer row.
          if (!existing || String(observedAt) >= String(existing.observed_at)) {
            self.latest.set(locationId, {
              location_id: locationId,
              observed_at: observedAt,
              precipitation_rate: bindings[2],
              temperature: bindings[3],
              humidity: bindings[4],
              updated_at: updatedAt,
            });
          }
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INTO weather_alert_state")) {
          const [stationId, raining] = bindings as [string, number];
          self.rainStates.set(stationId, { station_id: stationId, raining });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO push_subscriptions")) {
          const [endpoint, p256dh, auth] = bindings as [string, string, string];
          if (!self.subscriptions.some((s) => s.endpoint === endpoint)) {
            self.subscriptions.push({ endpoint, p256dh, auth });
          }
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (sql.includes("FROM weather_alert_state")) {
          const [stationId] = bindings as [string];
          return ((self.rainStates.get(String(stationId)) as T) ?? null) as T;
        }
        return null as T;
      },
      all: async () => {
        if (sql.includes("FROM latest_weather_observations")) {
          // Mirror `WHERE l.observed_at >= datetime('now', '-15 minutes')`.
          const cutoff = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
          const results = [...self.latest.values()]
            .filter((r) => String(r.observed_at) >= cutoff)
            .map((r) => ({
              stationId: r.location_id,
              stationName: self.locations.get(String(r.location_id)) ?? r.location_id,
              rainRateMmH: r.precipitation_rate,
            }))
            .sort((a, b) => String(a.stationName).localeCompare(String(b.stationName)));
          return { results };
        }
        if (sql.includes("FROM push_subscriptions")) {
          return { results: self.subscriptions };
        }
        return { results: [] };
      },
    };
  }
}

describe("latest_weather_observations upsert", () => {
  it("inserts a row for a new observation", async () => {
    const db = new FakeD1();
    await upsertLatestObservation(db as unknown as D1Database, makeObs());

    expect(db.sawInsert).toBe(true);
    expect(db.latest.size).toBe(1);
    const row = db.latest.get("loc-1")!;
    expect(row.precipitation_rate).toBe(0);
    expect(row.temperature).toBe(20);
    expect(row.humidity).toBe(60);
  });

  it("replaces values when a newer observation arrives", async () => {
    const db = new FakeD1();
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(-10), precipitation_rate: 0 }),
    );
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(0), precipitation_rate: 4.5 }),
    );

    expect(db.latest.size).toBe(1);
    expect(db.latest.get("loc-1")!.precipitation_rate).toBe(4.5);
  });

  it("does not let an older observation overwrite a newer one", async () => {
    const db = new FakeD1();
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(0), precipitation_rate: 4.5 }),
    );
    // Late-arriving (out-of-order) older observation must be ignored.
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(-10), precipitation_rate: 0 }),
    );

    expect(db.latest.size).toBe(1);
    expect(db.latest.get("loc-1")!.precipitation_rate).toBe(4.5);
  });
});

describe("loadLatestStations", () => {
  it("reads from latest_weather_observations, not the historical table", async () => {
    const db = new FakeD1();
    db.locations.set("loc-1", "Ijuí");
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ location_id: "loc-1", precipitation_rate: 2.5 }),
    );

    // Run the real query path and inspect the SQL that was issued.
    const stations = await loadLatestStations(db as unknown as D1Database);

    expect(db.sawSelect).toBe(true);
    expect(db.lastSql).toContain("latest_weather_observations");
    expect(db.lastSql).not.toContain("weather_observations o");
    expect(db.lastSql).not.toContain("MAX(");
    expect(stations).toEqual([
      { stationId: "loc-1", stationName: "Ijuí", rainRateMmH: 2.5 },
    ]);
  });

  it("ignores stale observations older than 15 minutes", async () => {
    const db = new FakeD1();
    db.locations.set("loc-fresh", "Fresh");
    db.locations.set("loc-stale", "Stale");
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ location_id: "loc-fresh", precipitation_rate: 1.2 }),
    );
    // Seed a stale row directly (20 minutes old, past the 15-minute window).
    db.latest.set("loc-stale", {
      location_id: "loc-stale",
      observed_at: minutesFromNow(-STALE_MINUTES - 5),
      precipitation_rate: 9.9,
    });

    const stations = await loadLatestStations(db as unknown as D1Database);

    expect(stations).toHaveLength(1);
    expect(stations[0]!.stationId).toBe("loc-fresh");
  });
});

describe("rain alert pipeline end-to-end", () => {
  it("fires an alert from latest-state data, exactly once per rain start", async () => {
    const db = new FakeD1();
    db.locations.set("loc-1", "Ijuí");
    await insertSubscription(db as unknown as D1Database, {
      endpoint: "https://push.example/abc",
      p256dh: "A",
      auth: "B",
    });

    // Cycle 1: dry observation — initialises state silently.
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ precipitation_rate: 0 }),
    );
    let stations = await loadLatestStations(db as unknown as D1Database);
    let result = await runRainAlerts({
      db: db as unknown as D1Database,
      vapid: { subject: "mailto:a@b.c", publicKey: "pk", privateKey: "sk" },
      stations,
    });
    expect(result.alertsFired).toBe(0);

    // Cycle 2: rain starts — alert fires.
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(0), precipitation_rate: 3 }),
    );
    stations = await loadLatestStations(db as unknown as D1Database);
    result = await runRainAlerts({
      db: db as unknown as D1Database,
      vapid: { subject: "mailto:a@b.c", publicKey: "pk", privateKey: "sk" },
      stations,
    });
    expect(result.alertsFired).toBe(1);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(result.notificationsSent).toBe(1);

    // Cycle 3: rain continues — no duplicate alert.
    await upsertLatestObservation(
      db as unknown as D1Database,
      makeObs({ observed_at: minutesFromNow(5), precipitation_rate: 2 }),
    );
    stations = await loadLatestStations(db as unknown as D1Database);
    result = await runRainAlerts({
      db: db as unknown as D1Database,
      vapid: { subject: "mailto:a@b.c", publicKey: "pk", privateKey: "sk" },
      stations,
    });
    expect(result.alertsFired).toBe(0);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});
