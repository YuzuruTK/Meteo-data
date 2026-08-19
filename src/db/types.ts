import type { D1Database } from "@cloudflare/workers-types";

/**
 * Worker environment bindings.
 */
export interface Env {
  DB: D1Database;
  // Static assets (served by the Workers static-assets binding).
  ASSETS: Fetcher;
  // Secret used to protect the manual fetch-triggered endpoint.
  COLLECTOR_TRIGGER_SECRET?: string;
  // Weather.com API key (secret binding).
  WEATHER_COM_API_KEY?: string;
  // Optional extra secrets referenced by other sources.
  [key: string]: unknown;
}
