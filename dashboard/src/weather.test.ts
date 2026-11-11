import { describe, it, expect } from "vitest";
import { rainStatus, upcoming, type Summary } from "./weather";
import { timestamp } from "../../shared/weather";
const time = "2026-11-10T12:00:00Z",
  now = timestamp(time);
const row = (rate: number | null): Summary => ({
  location_id: "x",
  station_name: "X",
  observed_at: time,
  precipitation_rate: rate,
});
describe("dashboard weather semantics", () => {
  it("distinguishes null/zero/rain/stale/future", () => {
    expect(rainStatus(row(null), now)).toBe("unknown");
    expect(rainStatus(row(0), now)).toBe("dry");
    expect(rainStatus(row(0.1), now)).toBe("rain");
    expect(rainStatus(row(1), now + 900000)).toBe("rain");
    expect(rainStatus(row(1), now + 900001)).toBe("stale");
    expect(rainStatus(row(1), now - 120001)).toBe("invalid");
  });
  it("interprets timezone-free forecast and bucket times as UTC", () => {
    expect(timestamp("2026-11-10 12:00")).toBe(now);
    expect(timestamp("2026-11-10T12:00")).toBe(now);
  });
  it("selects forecast windows from now, not midnight", () => {
    const hours = Array.from({ length: 48 }, (_, i) => ({
      time: new Date(now - 12 * 3600000 + i * 3600000).toISOString(),
      temperature: i,
      humidity: 50,
      precipitationProbability: 20,
      precipitation: 0,
      cloudCover: 0,
    }));
    expect(upcoming(hours, now, 6).map((h) => h.temperature)).toEqual([
      12, 13, 14, 15, 16, 17,
    ]);
    expect(upcoming(hours, now, 24)).toHaveLength(24);
  });
});
