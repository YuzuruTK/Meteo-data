import type { D1Database } from "@cloudflare/workers-types";

/**
 * Worker environment bindings.
 */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  COLLECTOR_TRIGGER_SECRET?: string;
  WEATHER_COM_API_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** Forecast alert thresholds, configured as Wrangler variables. */
  FORECAST_LOW_TEMP_C?: string;
  FORECAST_TEMP_VARIATION_C?: string;
  FORECAST_CONSECUTIVE_TEMP_CHANGE_C?: string;
  FORECAST_RAIN_PROBABILITY_PERCENT?: string;
  FORECAST_RAIN_START_SHIFT_MINUTES?: string;
  FORECAST_ALERT_HORIZON_HOURS?: string;
  /**
   * Emergency D1 read-conservation flags (see docs/emergency-d1-mode.md).
   * All default to disabled; set to "true" to activate.
   */
  /** Skip rollupObservations() after collection (no rollup reads). */
  DISABLE_ROLLUPS?: string;
  /** Skip all weather-alert processing (no alert-related reads). */
  DISABLE_ALERTS?: string;
  /** Serve 503 maintenance responses for expensive dashboard endpoints without touching D1. */
  READ_ONLY_EMERGENCY?: string;
  [key: string]: unknown;
}
