import { fresh, timestamp, RAIN_THRESHOLD_MM_H } from "../../shared/weather";
import type { ForecastHourly } from "./types";
export interface Summary {
  location_id: string;
  station_name: string;
  observed_at: string;
  rainEvent?: { id: string; observedAt: string; detectedAt: string } | null;
  [key: string]: unknown;
}
export function rainStatus(s: Summary, now: number) {
  const ms = timestamp(s.observed_at);
  if (!Number.isFinite(ms) || ms - now > 120000) return "invalid";
  if (!fresh(s.observed_at, now)) return "stale";
  const rate = s.precipitation_rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)
    return "unknown";
  return rate >= RAIN_THRESHOLD_MM_H ? "rain" : "dry";
}
export function upcoming(hours: ForecastHourly[], now: number, count: number) {
  return hours.filter(
    (h) =>
      timestamp(h.time) >= now && timestamp(h.time) < now + count * 3600000,
  );
}
export function stationColor(id: string) {
  const palette = ["#075985", "#8b3c77", "#946100", "#13745c"];
  return palette[
    Array.from(id).reduce((n, c) => n + c.charCodeAt(0), 0) % palette.length
  ];
}
