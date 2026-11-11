import { describe, it, expect, vi } from "vitest";
import { TestD1 } from "./helpers/sqlite";
import { updateDashboardSummary } from "../src/dashboard/summary";
import { upsertLatestObservation, loadLatestStations } from "../src/db/latest";
import { runRainAlerts } from "../src/push/alerts";
import { sendPushNotificationToOne } from "../src/push/send";
import type { NormalizedWeatherObservation } from "../src/collector/types";
vi.mock("../src/push/send", () => ({
  sendPushNotificationToOne: vi.fn().mockResolvedValue(undefined),
}));
function observation(time: string, rate: number): NormalizedWeatherObservation {
  return {
    source_id: "test",
    location_id: "loc-1",
    observed_at: time,
    collected_at: time,
    temperature: 23,
    humidity: 70,
    precipitation_rate: rate,
    solar_radiation: null,
    pressure: null,
    wind_speed: null,
    wind_direction: null,
    wind_gust: null,
    precipitation_total: null,
    uv_index: null,
    cloud_cover: null,
    visibility: null,
  };
}
describe("materialized data integration", () => {
  it("summary and latest reject older and equivalent conflicting timestamps", async () => {
    const db = new TestD1();
    db.location();
    const now = "2026-11-10T12:05:00Z";
    for (const time of [now, "2026-11-10T12:00:00Z", "2026-11-10 12:05:00"]) {
      const obs = observation(time, time === now ? 1 : 0);
      await updateDashboardSummary(db.db, obs, "Ijuí", now);
      await upsertLatestObservation(db.db, obs);
    }
    expect(db.rows("dashboard_summary")[0].precipitation_rate).toBe(1);
    expect(db.rows("latest_weather_observations")[0].precipitation_rate).toBe(
      1,
    );
  });
  it("collector latest read through event and outbox emits once", async () => {
    vi.clearAllMocks();
    const db = new TestD1();
    db.location();
    db.subscriber();
    const now = Date.now();
    for (const [offset, rate] of [
      [-300000, 0],
      [0, 2],
      [0, 2],
    ]) {
      await upsertLatestObservation(
        db.db,
        observation(new Date(now + offset!).toISOString(), rate!),
      );
      const stations = await loadLatestStations(db.db);
      expect(stations[0]?.observedAt).toBeTruthy();
      await runRainAlerts({
        db: db.db,
        stations,
        vapid: {
          subject: "mailto:t@example.com",
          publicKey: "test",
          privateKey: "test",
        },
      });
    }
    expect(sendPushNotificationToOne).toHaveBeenCalledTimes(1);
    expect(db.rows("rain_events")).toHaveLength(1);
  });
});
