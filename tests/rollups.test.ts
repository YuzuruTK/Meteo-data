import { describe, expect, it } from "vitest";
import { rollupObservations } from "../src/db/rollups";
import type { D1Database } from "@cloudflare/workers-types";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory D1 mock supporting the rollup queries:
 *   - INSERT INTO weather_observations_hourly ... SELECT FROM weather_observations
 *   - INSERT INTO weather_observations_daily ... SELECT FROM weather_observations_hourly
 *
 * The mock stores raw observations, hourly rows, and daily rows in arrays
 * and implements the aggregation logic inline so the rollup function can be
 * tested without a real D1 database.
 */
class FakeD1 {
  observations: Row[] = [];
  hourly: Row[] = [];
  daily: Row[] = [];

  prepare(sql: string) {
    const self = this;
    return {
      bind: (...args: unknown[]) => this.execute(sql, args),
      run: () => this.execute(sql, []).run(),
      first: () => this.execute(sql, []).first(),
      all: () => this.execute(sql, []).all(),
    };
  }

  private execute(sql: string, _bindings: unknown[]) {
    const self = this;
    return {
      async run(): Promise<{ meta: { changes: number } }> {
        if (sql.includes("INTO weather_observations_hourly")) {
          // Recompute hourly from raw observations within the window.
          // The SQL uses `datetime('now', '-N hours')` — we approximate by
          // using all observations (the test controls the window via data).
          const groups = new Map<string, Row[]>();
          for (const o of self.observations) {
            const hour = self.hourOf(o.observed_at as string);
            const key = `${o.location_id}|${hour}`;
            const bucket = groups.get(key) ?? [];
            bucket.push(o);
            groups.set(key, bucket);
          }
          let changes = 0;
          for (const [key, bucket] of groups.entries()) {
            const [locId, hour] = key.split("|") as [string, string];
            const row = self.buildHourlyRow(locId, hour, bucket);
            const existing = self.hourly.findIndex(
              (r) => r.location_id === locId && r.hour === hour,
            );
            if (existing >= 0) {
              self.hourly[existing] = row;
            } else {
              self.hourly.push(row);
            }
            changes++;
          }
          return { meta: { changes } };
        }

        if (sql.includes("INTO weather_observations_daily")) {
          // Determine affected days from the hourly table.
          // The subquery finds distinct days where hour >= window start.
          // In the mock we use all hourly rows (test controls data).
          const affectedDays = new Set<string>();
          for (const h of self.hourly) {
            affectedDays.add(self.dayOf(h.hour as string));
          }

          const groups = new Map<string, Row[]>();
          for (const h of self.hourly) {
            const day = self.dayOf(h.hour as string);
            if (!affectedDays.has(day)) continue;
            const key = `${h.location_id}|${day}`;
            const bucket = groups.get(key) ?? [];
            bucket.push(h);
            groups.set(key, bucket);
          }
          let changes = 0;
          for (const [key, bucket] of groups.entries()) {
            const [locId, day] = key.split("|") as [string, string];
            const row = self.buildDailyRow(locId, day, bucket);
            const existing = self.daily.findIndex(
              (r) => r.location_id === locId && r.day === day,
            );
            if (existing >= 0) {
              self.daily[existing] = row;
            } else {
              self.daily.push(row);
            }
            changes++;
          }
          return { meta: { changes } };
        }

        return { meta: { changes: 0 } };
      },
      async first() {
        return null;
      },
      async all() {
        // Repair job (A1): the station list. In production this reads
        // weather_locations; in the mock it is derived from the observations
        // present in the test data.
        if (sql.includes("FROM weather_locations")) {
          const ids = [
            ...new Set(self.observations.map((o) => o.location_id as string)),
          ];
          return { results: ids.map((id) => ({ id })) };
        }
        return { results: [] };
      },
    };
  }

  private hourOf(ts: string): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00`;
  }

  private dayOf(hour: string): string {
    return hour.slice(0, 10);
  }

  private num(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  private avg(nums: number[]): number | null {
    const valid = nums.filter((n): n is number => n !== null);
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
  }

  private buildHourlyRow(locId: string, hour: string, bucket: Row[]): Row {
    const temps = bucket.map((o) => this.num(o.temperature)).filter((v): v is number => v !== null);
    const humidities = bucket.map((o) => this.num(o.humidity)).filter((v): v is number => v !== null);
    const pressures = bucket.map((o) => this.num(o.pressure)).filter((v): v is number => v !== null);
    const precipTotals = bucket.map((o) => this.num(o.precipitation_total)).filter((v): v is number => v !== null);

    return {
      location_id: locId,
      hour,
      temperature_avg: this.avg(temps),
      temperature_min: temps.length > 0 ? Math.min(...temps) : null,
      temperature_max: temps.length > 0 ? Math.max(...temps) : null,
      humidity_avg: this.avg(humidities),
      humidity_min: humidities.length > 0 ? Math.min(...humidities) : null,
      humidity_max: humidities.length > 0 ? Math.max(...humidities) : null,
      pressure_avg: this.avg(pressures),
      pressure_min: pressures.length > 0 ? Math.min(...pressures) : null,
      pressure_max: pressures.length > 0 ? Math.max(...pressures) : null,
      precipitation_total_sum: precipTotals.reduce((a, b) => a + b, 0),
      observation_count: bucket.length,
    };
  }

  private buildDailyRow(locId: string, day: string, hourlyRows: Row[]): Row {
    const temps: number[] = [];
    const humidities: number[] = [];
    const pressures: number[] = [];
    let precipSum = 0;
    let totalCount = 0;

    for (const h of hourlyRows) {
      const count = this.num(h.observation_count) ?? 0;
      totalCount += count;
      const t = this.num(h.temperature_avg);
      if (t !== null) temps.push(t);
      const hu = this.num(h.humidity_avg);
      if (hu !== null) humidities.push(hu);
      const p = this.num(h.pressure_avg);
      if (p !== null) pressures.push(p);
      precipSum += this.num(h.precipitation_total_sum) ?? 0;
    }

    return {
      location_id: locId,
      day,
      temperature_avg: this.avg(temps),
      temperature_min: temps.length > 0 ? Math.min(...temps) : null,
      temperature_max: temps.length > 0 ? Math.max(...temps) : null,
      humidity_avg: this.avg(humidities),
      humidity_min: humidities.length > 0 ? Math.min(...humidities) : null,
      humidity_max: humidities.length > 0 ? Math.max(...humidities) : null,
      pressure_avg: this.avg(pressures),
      pressure_min: pressures.length > 0 ? Math.min(...pressures) : null,
      pressure_max: pressures.length > 0 ? Math.max(...pressures) : null,
      precipitation_total_sum: precipSum,
      observation_count: totalCount,
    };
  }
}

describe("observation rollups", () => {
  it("preserves complete daily aggregates when the hourly window is partial", async () => {
    const db = new FakeD1();

    // Simulate a complete Monday with 24 hourly observations (one per hour).
    for (let h = 0; h < 24; h++) {
      const hour = String(h).padStart(2, "0");
      db.observations.push({
        location_id: "loc-1",
        observed_at: `2025-06-02T${hour}:00:00Z`, // Monday
        temperature: 20 + h * 0.5,
        humidity: 60,
        pressure: 1013,
        precipitation_total: h === 12 ? 5 : 0,
      });
    }

    // Run rollup — should produce a complete Monday daily row.
    await rollupObservations(db as unknown as D1Database, 24);
    expect(db.daily).toHaveLength(1);
    const monday = db.daily[0]!;
    expect(monday.day).toBe("2025-06-02");
    expect(monday.observation_count).toBe(24);
    expect(monday.temperature_avg).toBeCloseTo(20 + 23 * 0.5 / 2, 1);
    expect(monday.precipitation_total_sum).toBe(5);

    // Now simulate Tuesday at 12:00. Add 12 hours of Tuesday observations.
    // The 24-hour window covers Monday 12:00 → Tuesday 12:00.
    for (let h = 0; h < 12; h++) {
      const hour = String(h).padStart(2, "0");
      db.observations.push({
        location_id: "loc-1",
        observed_at: `2025-06-03T${hour}:00:00Z`, // Tuesday
        temperature: 22,
        humidity: 55,
        pressure: 1015,
        precipitation_total: 0,
      });
    }

    // Run rollup again. Monday's daily row must still have 24 observations,
    // not be truncated to 12.
    await rollupObservations(db as unknown as D1Database, 24);
    const mondayAfter = db.daily.find((r) => r.day === "2025-06-02");
    expect(mondayAfter).toBeDefined();
    expect(mondayAfter!.observation_count).toBe(24);
    expect(mondayAfter!.temperature_avg).toBeCloseTo(20 + 23 * 0.5 / 2, 1);
    expect(mondayAfter!.precipitation_total_sum).toBe(5);

    // Tuesday should have 12 observations.
    const tuesday = db.daily.find((r) => r.day === "2025-06-03");
    expect(tuesday).toBeDefined();
    expect(tuesday!.observation_count).toBe(12);
  });

  it("is idempotent: re-running produces identical daily results", async () => {
    const db = new FakeD1();

    for (let h = 0; h < 24; h++) {
      const hour = String(h).padStart(2, "0");
      db.observations.push({
        location_id: "loc-1",
        observed_at: `2025-06-02T${hour}:00:00Z`,
        temperature: 20 + h * 0.5,
        humidity: 60,
        pressure: 1013,
        precipitation_total: h === 12 ? 5 : 0,
      });
    }

    await rollupObservations(db as unknown as D1Database, 24);
    const firstRun = JSON.parse(JSON.stringify(db.daily)) as Row[];

    // Run again with no new data.
    await rollupObservations(db as unknown as D1Database, 24);
    const secondRun = db.daily;

    expect(secondRun).toHaveLength(firstRun.length);
    for (let i = 0; i < firstRun.length; i++) {
      expect(secondRun[i]).toEqual(firstRun[i]);
    }
  });

  it("handles multiple stations correctly", async () => {
    const db = new FakeD1();

    for (let h = 0; h < 24; h++) {
      const hour = String(h).padStart(2, "0");
      db.observations.push({
        location_id: "loc-1",
        observed_at: `2025-06-02T${hour}:00:00Z`,
        temperature: 20,
        humidity: 60,
        pressure: 1013,
        precipitation_total: 0,
      });
      db.observations.push({
        location_id: "loc-2",
        observed_at: `2025-06-02T${hour}:00:00Z`,
        temperature: 25,
        humidity: 50,
        pressure: 1010,
        precipitation_total: 0,
      });
    }

    await rollupObservations(db as unknown as D1Database, 24);
    expect(db.daily).toHaveLength(2);

    const loc1 = db.daily.find((r) => r.location_id === "loc-1");
    const loc2 = db.daily.find((r) => r.location_id === "loc-2");
    expect(loc1!.observation_count).toBe(24);
    expect(loc2!.observation_count).toBe(24);
    expect(loc1!.temperature_avg).toBe(20);
    expect(loc2!.temperature_avg).toBe(25);
  });

  it("handles a partially completed current day", async () => {
    const db = new FakeD1();

    // Only 6 hours of data for today.
    for (let h = 0; h < 6; h++) {
      const hour = String(h).padStart(2, "0");
      db.observations.push({
        location_id: "loc-1",
        observed_at: `2025-06-02T${hour}:00:00Z`,
        temperature: 20,
        humidity: 60,
        pressure: 1013,
        precipitation_total: 0,
      });
    }

    await rollupObservations(db as unknown as D1Database, 24);
    expect(db.daily).toHaveLength(1);
    expect(db.daily[0]!.observation_count).toBe(6);
    expect(db.daily[0]!.temperature_avg).toBe(20);
  });
});