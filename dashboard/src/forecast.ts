import type { ForecastResponse } from "./types";

const API_BASE = "/api";

/**
 * Fetch the Open-Meteo forecast for the dashboard. This is intentionally
 * non-fatal: any failure returns `null` so the dashboard can render without
 * forecast overlays (observations remain unaffected).
 */
export async function fetchForecast(): Promise<ForecastResponse | null> {
  try {
    const res = await fetch(`${API_BASE}/forecast`);
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as ForecastResponse;
  } catch {
    return null;
  }
}