import type { D1Database } from "@cloudflare/workers-types";
import type { ForecastHourly } from "../forecast/types";
import { sendPushNotifications, type PushSendOptions } from "./send";

export interface ForecastAlertConfig {
  lowTemperatureC: number;
  temperatureVariationC: number;
  consecutiveTemperatureChangeC: number;
  rainProbabilityPercent: number;
  rainStartShiftMinutes: number;
  horizonHours: number;
}

export const DEFAULT_FORECAST_ALERT_CONFIG: ForecastAlertConfig = {
  lowTemperatureC: 5,
  temperatureVariationC: 10,
  consecutiveTemperatureChangeC: 5,
  rainProbabilityPercent: 60,
  rainStartShiftMinutes: 60,
  horizonHours: 24,
};

export interface ForecastAlert {
  type: "low-temperature" | "temperature-variation" | "rain-forecast";
  eventKey: string;
  eventTime: string;
  fingerprint: string;
  title: string;
  body: string;
}

export interface ForecastAlertResult {
  evaluated: number;
  alertsFired: number;
  notificationsSent: number;
  notificationsRemoved: number;
  errors: Array<{ endpoint: string; statusCode: number | undefined; error: string }>;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read forecast alert thresholds from Worker environment variables. */
export function getForecastAlertConfig(env: Record<string, unknown>): ForecastAlertConfig {
  const defaults = DEFAULT_FORECAST_ALERT_CONFIG;
  return {
    lowTemperatureC: parseNumber(env.FORECAST_LOW_TEMP_C as string | undefined, defaults.lowTemperatureC),
    temperatureVariationC: parsePositive(env.FORECAST_TEMP_VARIATION_C as string | undefined, defaults.temperatureVariationC),
    consecutiveTemperatureChangeC: parsePositive(
      env.FORECAST_CONSECUTIVE_TEMP_CHANGE_C as string | undefined,
      defaults.consecutiveTemperatureChangeC,
    ),
    rainProbabilityPercent: Math.min(
      100,
      Math.max(0, parseNumber(env.FORECAST_RAIN_PROBABILITY_PERCENT as string | undefined, defaults.rainProbabilityPercent)),
    ),
    rainStartShiftMinutes: parsePositive(
      env.FORECAST_RAIN_START_SHIFT_MINUTES as string | undefined,
      defaults.rainStartShiftMinutes,
    ),
    horizonHours: parsePositive(env.FORECAST_ALERT_HORIZON_HOURS as string | undefined, defaults.horizonHours),
  };
}

function eventHour(time: string): number {
  return Date.parse(time);
}

function inFuture(hour: ForecastHourly, nowMs: number): boolean {
  return eventHour(hour.time) > nowMs;
}

/** Find the first future hour meeting the configured precipitation criteria. */
export function findRainAlert(hours: ForecastHourly[], config: ForecastAlertConfig, now = new Date()): ForecastAlert | null {
  const end = now.getTime() + config.horizonHours * 60 * 60 * 1000;
  const hour = hours.find(
    (item) =>
      inFuture(item, now.getTime()) &&
      eventHour(item.time) <= end &&
      item.precipitation > 0 &&
      item.precipitationProbability >= config.rainProbabilityPercent,
  );

  if (!hour) return null;
  return {
    type: "rain-forecast",
    eventKey: `rain:${hour.time}`,
    eventTime: hour.time,
    fingerprint: `${hour.time}:${hour.precipitationProbability}`,
    title: "🌧️ Rain forecast",
    body: `Rain is expected around ${formatTime(hour.time)} with a ${Math.round(hour.precipitationProbability)}% chance.`,
  };
}

/** Evaluate low temperature and large temperature changes in the forecast horizon. */
export function findTemperatureAlerts(
  hours: ForecastHourly[],
  config: ForecastAlertConfig,
  now = new Date(),
): ForecastAlert[] {
  const end = now.getTime() + config.horizonHours * 60 * 60 * 1000;
  const future = hours.filter((item) => inFuture(item, now.getTime()) && eventHour(item.time) <= end);
  if (future.length === 0) return [];

  const alerts: ForecastAlert[] = [];
  const minimum = future.reduce((best, item) => (item.temperature < best.temperature ? item : best));
  if (minimum.temperature <= config.lowTemperatureC) {
    alerts.push({
      type: "low-temperature",
      eventKey: `low-temperature:${minimum.time.slice(0, 10)}`,
      eventTime: minimum.time,
      fingerprint: `${minimum.time}:${minimum.temperature}`,
      title: "🥶 Low temperature forecast",
      body: `Temperature may fall to ${formatTemperature(minimum.temperature)} around ${formatTime(minimum.time)}.`,
    });
  }

  const day = future[0]!.time.slice(0, 10);
  const maximum = future.reduce((best, item) => (item.temperature > best.temperature ? item : best));
  if (maximum.temperature - minimum.temperature >= config.temperatureVariationC) {
    alerts.push({
      type: "temperature-variation",
      eventKey: `temperature-variation:${day}`,
      eventTime: maximum.time,
      fingerprint: `${minimum.temperature}:${maximum.temperature}:${minimum.time}:${maximum.time}`,
      title: "🌡️ Large temperature variation",
      body: `Forecast ranges from ${formatTemperature(minimum.temperature)} to ${formatTemperature(maximum.temperature)} between ${formatTime(minimum.time)} and ${formatTime(maximum.time)}.`,
    });
  } else {
    for (let i = 1; i < future.length; i++) {
      const previous = future[i - 1]!;
      const current = future[i]!;
      const change = Math.abs(current.temperature - previous.temperature);
      if (change >= config.consecutiveTemperatureChangeC) {
        alerts.push({
          type: "temperature-variation",
          eventKey: `temperature-variation:${current.time}`,
          eventTime: current.time,
          fingerprint: `${previous.temperature}:${current.temperature}`,
          title: "🌡️ Rapid temperature change forecast",
          body: `Temperature may change by ${formatTemperature(change)} between ${formatTime(previous.time)} and ${formatTime(current.time)}.`,
        });
        break;
      }
    }
  }

  return alerts;
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" }).format(new Date(iso));
}

function formatTemperature(value: number): string {
  return `${value.toFixed(1)}°C`;
}

/** Evaluate all forecast rules without sending notifications. */
export function evaluateForecastAlerts(
  hours: ForecastHourly[],
  config = DEFAULT_FORECAST_ALERT_CONFIG,
  now = new Date(),
): ForecastAlert[] {
  const alerts = findTemperatureAlerts(hours, config, now);
  const rain = findRainAlert(hours, config, now);
  if (rain) alerts.push(rain);
  return alerts;
}

/** Persist an alert only when it represents a new event or a meaningful event-time shift. */
async function shouldSend(
  db: D1Database,
  alert: ForecastAlert,
  config: ForecastAlertConfig,
): Promise<boolean> {
  const previous = await db
    .prepare("SELECT event_key, event_time, fingerprint FROM weather_forecast_alert_state WHERE alert_type = ?")
    .bind(alert.type)
    .first<{ event_key: string; event_time: string | null; fingerprint: string }>();

  if (!previous) return true;
  if (previous.event_key === alert.eventKey) return false;

  if (alert.type === "rain-forecast" && previous.event_time) {
    const delta = Math.abs(eventHour(alert.eventTime) - eventHour(previous.event_time)) / 60000;
    return delta >= config.rainStartShiftMinutes;
  }

  return true;
}

async function recordAlert(db: D1Database, alert: ForecastAlert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO weather_forecast_alert_state (alert_type, event_key, event_time, fingerprint, sent_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(alert_type) DO UPDATE SET
         event_key = excluded.event_key,
         event_time = excluded.event_time,
         fingerprint = excluded.fingerprint,
         sent_at = excluded.sent_at`,
    )
    .bind(alert.type, alert.eventKey, alert.eventTime, alert.fingerprint)
    .run();
}

/** Run forecast alert evaluation and send at most one push per alert event. */
export async function runForecastAlerts(
  db: D1Database,
  vapid: PushSendOptions,
  hours: ForecastHourly[],
  config = DEFAULT_FORECAST_ALERT_CONFIG,
  now = new Date(),
): Promise<ForecastAlertResult> {
  const alerts = evaluateForecastAlerts(hours, config, now);
  const result: ForecastAlertResult = {
    evaluated: hours.length,
    alertsFired: 0,
    notificationsSent: 0,
    notificationsRemoved: 0,
    errors: [],
  };

  for (const alert of alerts) {
    if (!(await shouldSend(db, alert, config))) continue;
    const delivery = await sendPushNotifications(db, vapid, {
      title: alert.title,
      body: alert.body,
      data: { alertType: alert.type, eventTime: alert.eventTime, url: "/" },
    });
    await recordAlert(db, alert);
    result.alertsFired++;
    result.notificationsSent += delivery.sent;
    result.notificationsRemoved += delivery.removed;
    result.errors.push(...delivery.errors);
    console.log(`[forecast-alert] sent type=${alert.type} event=${alert.eventKey}`);
  }

  if (alerts.length === 0) {
    console.log("[forecast-alert] no configured forecast alert conditions detected");
  }
  return result;
}
