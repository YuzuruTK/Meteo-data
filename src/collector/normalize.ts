import { jsonPath } from "./json-path";
import { getUnitConverter } from "./units";
import {
  ALL_WEATHER_FIELDS,
  DEFAULT_REQUIRED_FIELDS,
  type NormalizationConfig,
  type NormalizedWeatherObservation,
  type WeatherField,
} from "./types";

/**
 * Normalizes a raw API response body into a canonical weather observation.
 *
 * Steps:
 *   1. Select the observation object via `normalization.observation_selector`.
 *   2. For each configured field, extract the value via JSON path.
 *   3. Convert units to the canonical unit for that field.
 *   4. Require that configured `required` fields are present.
 *
 * Optional fields that are missing simply resolve to `null`.
 */

export class NormalizationError extends Error {}

export interface NormalizeOptions {
  sourceId: string;
  locationId: string;
  collectedAt?: string;
}

export function normalizeObservation(
  rawBody: unknown,
  config: NormalizationConfig,
  options: NormalizeOptions,
): NormalizedWeatherObservation {
  if (rawBody === null || typeof rawBody !== "object") {
    throw new NormalizationError("API response is not a JSON object");
  }

  // 1. Select the observation object.
  const observation = jsonPath<unknown>(rawBody, config.observation_selector);
  if (observation === undefined || observation === null) {
    throw new NormalizationError(
      `Observation selector '${config.observation_selector}' did not match anything in the response`,
    );
  }
  if (typeof observation !== "object") {
    throw new NormalizationError(
      `Observation selector '${config.observation_selector}' resolved to a non-object`,
    );
  }

  const required = config.required ?? DEFAULT_REQUIRED_FIELDS;
  const values: Partial<Record<WeatherField, number | string | null>> = {};
  const errors: string[] = [];

  // 2 & 3. Extract and convert each configured field.
  for (const field of ALL_WEATHER_FIELDS) {
    const fieldConfig = config.fields[field];
    if (!fieldConfig) {
      // Not configured for this source -> leave null.
      values[field] = null;
      continue;
    }

    const raw = jsonPath<unknown>(observation, fieldConfig.path);
    if (raw === undefined || raw === null || raw === "") {
      // Missing optional value.
      if (required.includes(field)) {
        errors.push(`Required field '${field}' is missing (path '${fieldConfig.path}')`);
      }
      values[field] = null;
      continue;
    }

    if (field === "observed_at") {
      if (typeof raw !== "string") {
        const numeric = toNumber(raw);
        if (numeric === null) {
          if (required.includes(field)) {
            errors.push(`Required field '${field}' is not a valid timestamp`);
          }
          values[field] = null;
          continue;
        }
        values[field] = new Date(numeric * 1000).toISOString();
      } else {
        if (!isValidTimestamp(raw)) {
          if (required.includes(field)) {
            errors.push(`Required field '${field}' is not a valid timestamp: ${raw}`);
          }
          values[field] = null;
          continue;
        }
        values[field] = new Date(raw).toISOString();
      }
      continue;
    }

    const numeric = toNumber(raw);
    if (numeric === null) {
      if (required.includes(field)) {
        errors.push(`Field '${field}' (path '${fieldConfig.path}') is not numeric`);
      }
      values[field] = null;
      continue;
    }

    try {
      const convert = getUnitConverter(field, fieldConfig.unit, fieldConfig.convert_to);
      values[field] = convert(numeric);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Field '${field}': ${message}`);
    }
  }

  // 4. Validate required fields.
  if (errors.length > 0) {
    throw new NormalizationError(errors.join("; "));
  }

  return {
    source_id: options.sourceId,
    location_id: options.locationId,
    observed_at: String(values.observed_at),
    temperature: asNumber(values.temperature),
    solar_radiation: asNumber(values.solar_radiation),
    humidity: asNumber(values.humidity),
    pressure: asNumber(values.pressure),
    wind_speed: asNumber(values.wind_speed),
    wind_direction: asNumber(values.wind_direction),
    wind_gust: asNumber(values.wind_gust),
    precipitation_rate: asNumber(values.precipitation_rate),
    precipitation_total: asNumber(values.precipitation_total),
    uv_index: asNumber(values.uv_index),
    cloud_cover: asNumber(values.cloud_cover),
    visibility: asNumber(values.visibility),
    collected_at: options.collectedAt ?? new Date().toISOString(),
  };
}

function isValidTimestamp(raw: string): boolean {
  return !Number.isNaN(new Date(raw).getTime());
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    const num = Number(trimmed);
    if (trimmed !== "" && Number.isFinite(num)) {
      return num;
    }
  }
  return null;
}

function asNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}