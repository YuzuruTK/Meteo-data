/**
 * Shared types for the configuration-driven weather collector.
 */

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Canonical meteorological fields produced by normalization.
 * Additional fields can be added here without redesigning the collector;
 * each configured API maps into this common model.
 */
export type WeatherField =
  | "observed_at"
  | "temperature"
  | "solar_radiation"
  | "humidity"
  | "pressure"
  | "wind_speed"
  | "wind_direction"
  | "wind_gust"
  | "precipitation_rate"
  | "precipitation_total"
  | "uv_index"
  | "cloud_cover"
  | "visibility";

export const ALL_WEATHER_FIELDS: WeatherField[] = [
  "observed_at",
  "temperature",
  "solar_radiation",
  "humidity",
  "pressure",
  "wind_speed",
  "wind_direction",
  "wind_gust",
  "precipitation_rate",
  "precipitation_total",
  "uv_index",
  "cloud_cover",
  "visibility",
];

/**
 * Fields that must be present in every normalized observation by default.
 * This can be overridden per source via `normalization.required`.
 */
export const DEFAULT_REQUIRED_FIELDS: WeatherField[] = ["observed_at"];

/** Request-level configuration for a weather source. */
export interface RequestConfig {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  /** Raw request body (string or JSON-serializable object). */
  body?: string | Record<string, unknown>;
  /** Request timeout in milliseconds. Defaults when unset. */
  timeout_ms?: number;
  /**
   * Name of the query/body parameter whose value is supplied per location.
   * For Weather.com PWS this is `stationId`, and each location provides its own
   * `stationId` value. If omitted, no per-location parameter is injected.
   */
  location_param?: string;
}

/** Per-source normalization rules mapping canonical fields to response paths. */
export interface NormalizationFieldConfig {
  /** JSON path within the selected observation object, e.g. `$.metric.temp`. */
  path: string;
  /** Source unit of the value, e.g. `F`, `kW/m2`. */
  unit?: string;
  /** Optional target unit to convert to; canonical unit is used if omitted. */
  convert_to?: string;
}

export type NormalizationFieldsConfig = Partial<
  Record<WeatherField, NormalizationFieldConfig>
>;

export interface NormalizationConfig {
  /**
   * JSON path selecting the observation object from the whole API response,
   * e.g. `$.observations[0]`.
   */
  observation_selector: string;
  fields: NormalizationFieldsConfig;
  /**
   * Fields required to be present for the observation to be stored.
   * Defaults to DEFAULT_REQUIRED_FIELDS when unset.
   */
  required?: WeatherField[];
}

/**
 * A configured location. Contains only location-specific information.
 * Extra keys (e.g. `stationId`, `lat`, `lon`) drive the request's
 * `location_param`. All request/common/normalization config lives at the
 * source level.
 */
export interface WeatherLocationConfig {
  id: string;
  name: string;
  latitude?: number;
  longitude?: number;
  [paramName: string]: string | number | boolean | null | undefined;
}

/** A weather API source definition (one entry in the JSON config array). */
export interface WeatherSourceConfig {
  id: string;
  enabled: boolean;
  request: RequestConfig;
  locations: WeatherLocationConfig[];
  normalization: NormalizationConfig;
}

/** Convenience shape for the whole config document. */
export type WeatherSourcesConfig = WeatherSourceConfig[];

/**
 * A fully-normalized, canonical weather observation ready for persistence.
 * All secondary meteorological fields are nullable.
 */
export interface NormalizedWeatherObservation {
  source_id: string;
  location_id: string;
  observed_at: string; // ISO-8601 UTC
  temperature: number | null; // °C
  solar_radiation: number | null; // W/m²
  humidity: number | null;
  pressure: number | null; // hPa
  wind_speed: number | null; // km/h
  wind_direction: number | null; // degrees
  wind_gust: number | null; // km/h
  precipitation_rate: number | null; // mm/h
  precipitation_total: number | null; // mm
  uv_index: number | null;
  cloud_cover: number | null; // %
  visibility: number | null;
  collected_at: string; // ISO-8601 UTC
}

/** Result of a single API/location request attempt. */
export interface RequestAttempt {
  source_id: string;
  location_id: string;
  status: "success" | "failed";
  http_status?: number;
  response_time_ms: number;
  error?: string;
  /** True if the observation was stored (or deduplicated). */
  stored?: boolean;
}

/** Summary of an entire collection run. */
export interface CollectionRun {
  id: string;
  started_at: string;
  finished_at?: string;
  status: "success" | "partial" | "failed";
  sources_attempted: number;
  requests_attempted: number;
  requests_succeeded: number;
  requests_failed: number;
  /** Per-request details, in execution order. */
  requests: RequestAttempt[];
}