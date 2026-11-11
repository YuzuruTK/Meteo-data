/** Pure contracts shared by the dashboard and the Worker. */
export const RAIN_THRESHOLD_MM_H = 0.1;
export const FRESH_MS = 15 * 60_000;
export const FUTURE_MS = 2 * 60_000;
export const DRY_CONFIRM_MS = 5 * 60_000;
export function timestamp(value: string): number {
  return Date.parse(
    /[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z",
  );
}
export function fresh(value: string, now: number): boolean {
  const age = now - timestamp(value);
  return Number.isFinite(age) && age >= -FUTURE_MS && age <= FRESH_MS;
}
export interface PushPreferences {
  stationScope: "all" | "selected";
  stationIds: string[];
  rainStart: boolean;
  rainForecast: boolean;
  temperatureForecast: boolean;
  locale: "pt-BR" | "en" | "es";
}
