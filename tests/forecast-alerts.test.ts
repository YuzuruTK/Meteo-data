import { describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type { ForecastHourly } from "../src/forecast/types";
import {
  DEFAULT_FORECAST_ALERT_CONFIG,
  evaluateForecastAlerts,
  findRainAlert,
  findTemperatureAlerts,
  getForecastAlertConfig,
  runForecastAlerts,
} from "../src/push/forecast";
import { sendNotification } from "web-push-neo";

vi.mock("web-push-neo", () => ({ sendNotification: vi.fn().mockResolvedValue(undefined) }));

type State = { event_key: string; event_time: string; fingerprint: string };

class FakeD1 {
  state = new Map<string, State>();
  subscriptions = [{ endpoint: "https://push.example/1", p256dh: "A", auth: "B", created_at: "2026-01-01" }];

  prepare(sql: string) {
    const execute = (args: unknown[]) => ({
      first: async <T>() => {
        if (sql.includes("weather_forecast_alert_state")) {
          return (this.state.get(String(args[0])) as T) ?? null;
        }
        return null as T;
      },
      run: async () => {
        if (sql.includes("weather_forecast_alert_state")) {
          const [type, eventKey, eventTime, fingerprint] = args as [
            string,
            string,
            string,
            string,
          ];
          this.state.set(type, { event_key: eventKey, event_time: eventTime, fingerprint });
        }
        return { meta: { changes: 1 } };
      },
      all: async () => ({ results: this.subscriptions }),
    });

    return {
      bind: (...args: unknown[]) => execute(args),
      first: <T>() => execute([]).first<T>(),
      run: () => execute([]).run(),
      all: <T>() => execute([]).all() as Promise<{ results: T[] }>,
    };
  }
}

const NOW = new Date("2026-08-26T10:00:00Z");

function hour(offset: number, temperature: number, probability = 0, precipitation = 0): ForecastHourly {
  const time = new Date(NOW.getTime() + offset * 60 * 60 * 1000).toISOString();
  return { time, temperature, humidity: 70, precipitationProbability: probability, precipitation, cloudCover: 50 };
}

describe("forecast alert evaluation", () => {
  it("alerts when a low temperature is forecast", () => {
    const alerts = findTemperatureAlerts([hour(1, 12), hour(5, 4), hour(8, 9)], DEFAULT_FORECAST_ALERT_CONFIG, NOW);
    expect(alerts.some((alert) => alert.type === "low-temperature")).toBe(true);
    expect(alerts.find((alert) => alert.type === "low-temperature")?.body).toContain("4.0°C");
  });

  it("alerts on a large min/max temperature variation", () => {
    const config = { ...DEFAULT_FORECAST_ALERT_CONFIG, temperatureVariationC: 8 };
    const alerts = findTemperatureAlerts([hour(1, 10), hour(5, 20)], config, NOW);
    expect(alerts.some((alert) => alert.type === "temperature-variation")).toBe(true);
  });

  it("alerts on a significant consecutive temperature change", () => {
    const config = { ...DEFAULT_FORECAST_ALERT_CONFIG, temperatureVariationC: 20, consecutiveTemperatureChangeC: 5 };
    const alerts = findTemperatureAlerts([hour(1, 10), hour(2, 16)], config, NOW);
    expect(alerts.some((alert) => alert.type === "temperature-variation")).toBe(true);
  });

  it("finds the first future rain window and includes probability", () => {
    const hours = [hour(1, 20, 30, 0.2), hour(2, 21, 75, 0.4), hour(3, 22, 90, 1)];
    const alert = findRainAlert(hours, DEFAULT_FORECAST_ALERT_CONFIG, NOW);
    expect(alert?.eventTime).toBe(hours[1]!.time);
    expect(alert?.body).toContain("75% chance");
  });

  it("does not alert on rain below the configured probability", () => {
    const alert = findRainAlert([hour(1, 20, 59, 1)], DEFAULT_FORECAST_ALERT_CONFIG, NOW);
    expect(alert).toBeNull();
  });

  it("loads configurable thresholds from environment", () => {
    const config = getForecastAlertConfig({
      FORECAST_LOW_TEMP_C: "2",
      FORECAST_TEMP_VARIATION_C: "7",
      FORECAST_CONSECUTIVE_TEMP_CHANGE_C: "4",
      FORECAST_RAIN_PROBABILITY_PERCENT: "80",
      FORECAST_RAIN_START_SHIFT_MINUTES: "30",
      FORECAST_ALERT_HORIZON_HOURS: "12",
    });
    expect(config).toEqual({ lowTemperatureC: 2, temperatureVariationC: 7, consecutiveTemperatureChangeC: 4, rainProbabilityPercent: 80, rainStartShiftMinutes: 30, horizonHours: 12 });
  });
});

describe("forecast alert deduplication", () => {
  it("sends the same rain event only once", async () => {
    const db = new FakeD1();
    const forecast = [hour(2, 20, 80, 1)];
    const vapid = { subject: "mailto:test@example.com", publicKey: "pk", privateKey: "sk" };

    await runForecastAlerts(db as unknown as D1Database, vapid, forecast, DEFAULT_FORECAST_ALERT_CONFIG, NOW);
    await runForecastAlerts(db as unknown as D1Database, vapid, forecast, DEFAULT_FORECAST_ALERT_CONFIG, NOW);

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("can emit a new rain alert when the predicted start shifts beyond the configured rule", async () => {
    const db = new FakeD1();
    const config = { ...DEFAULT_FORECAST_ALERT_CONFIG, rainStartShiftMinutes: 60 };
    const vapid = { subject: "mailto:test@example.com", publicKey: "pk", privateKey: "sk" };

    await runForecastAlerts(db as unknown as D1Database, vapid, [hour(2, 20, 80, 1)], config, NOW);
    await runForecastAlerts(db as unknown as D1Database, vapid, [hour(4, 20, 80, 1)], config, NOW);

    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("combines all configured forecast rules into one evaluation result", () => {
    const config = { ...DEFAULT_FORECAST_ALERT_CONFIG, lowTemperatureC: 6, temperatureVariationC: 8 };
    const alerts = evaluateForecastAlerts([hour(1, 10), hour(5, 4), hour(8, 20, 80, 1)], config, NOW);
    expect(alerts.map((alert) => alert.type)).toEqual(expect.arrayContaining(["low-temperature", "temperature-variation", "rain-forecast"]));
  });
});
