import {
  ALL_WEATHER_FIELDS,
  type HttpMethod,
  type NormalizationConfig,
  type WeatherSourceConfig,
  type WeatherSourcesConfig,
} from "./types";
import { parseJsonPath } from "./json-path";
import { getUnitConverter } from "./units";

/**
 * Configuration validation.
 *
 * Runs at startup (when the config is loaded) and surfaces clear, actionable
 * errors so a developer can fix the JSON quickly. Throws a ConfigValidationError
 * describing all problems found.
 */

export class ConfigValidationError extends Error {}

const VALID_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

export function validateConfig(config: WeatherSourcesConfig): void {
  const errors: string[] = [];

  if (!Array.isArray(config)) {
    throw new ConfigValidationError("Configuration must be an array of source definitions");
  }

  const sourceIds = new Set<string>();
  config.forEach((source, index) => {
    const where = `source #${index + 1}`;
    validateSource(source, where, sourceIds, errors);
  });

  if (errors.length > 0) {
    throw new ConfigValidationError(
      `Configuration validation failed:\n- ${errors.join("\n- ")}`,
    );
  }
}

function validateSource(
  source: WeatherSourceConfig,
  where: string,
  sourceIds: Set<string>,
  errors: string[],
): void {
  if (!source || typeof source !== "object") {
    errors.push(`${where}: source entry must be an object`);
    return;
  }

  if (!source.id || typeof source.id !== "string" || source.id.trim() === "") {
    errors.push(`${where}: missing or invalid 'id'`);
  } else if (sourceIds.has(source.id)) {
    errors.push(`${where}: duplicate source id '${source.id}'`);
  } else {
    sourceIds.add(source.id);
  }

  if (typeof source.enabled !== "boolean") {
    errors.push(`${where} (${source.id ?? "unknown"}): 'enabled' must be a boolean`);
  }

  if (!source.request || typeof source.request !== "object") {
    errors.push(`${where}: missing 'request' configuration`);
  } else {
    validateRequest(source.request, `${where} (${source.id ?? "unknown"})`, errors);
  }

  if (!source.normalization || typeof source.normalization !== "object") {
    errors.push(`${where}: missing 'normalization' configuration`);
  } else {
    validateNormalization(
      source.normalization,
      `${where} (${source.id ?? "unknown"})`,
      errors,
    );
  }

  if (!Array.isArray(source.locations) || source.locations.length === 0) {
    errors.push(`${where}: must define at least one 'location'`);
  } else {
    validateLocations(source, `${where} (${source.id ?? "unknown"})`, errors);
  }
}

function validateRequest(
  request: NonNullable<WeatherSourceConfig["request"]>,
  where: string,
  errors: string[],
): void {
  if (!VALID_METHODS.includes(request.method)) {
    errors.push(
      `${where}: invalid HTTP method '${request.method}'. Valid: ${VALID_METHODS.join(", ")}`,
    );
  }
  if (!request.url || typeof request.url !== "string" || request.url.trim() === "") {
    errors.push(`${where}: missing or invalid 'request.url'`);
  }
  if (
    request.timeout_ms !== undefined &&
    (!Number.isFinite(request.timeout_ms) || request.timeout_ms <= 0)
  ) {
    errors.push(`${where}: 'request.timeout_ms' must be a positive number`);
  }
}

function validateNormalization(
  normalization: NormalizationConfig,
  where: string,
  errors: string[],
): void {
  if (
    !normalization.observation_selector ||
    typeof normalization.observation_selector !== "string"
  ) {
    errors.push(`${where}: missing 'normalization.observation_selector'`);
  } else {
    try {
      parseJsonPath(normalization.observation_selector);
    } catch (err) {
      errors.push(`${where}: invalid observation_selector: ${errMessage(err)}`);
    }
  }

  if (!normalization.fields || typeof normalization.fields !== "object") {
    errors.push(`${where}: missing 'normalization.fields'`);
    return;
  }

  for (const field of Object.keys(normalization.fields)) {
    if (!(ALL_WEATHER_FIELDS as string[]).includes(field)) {
      errors.push(`${where}: unknown normalization field '${field}'`);
      continue;
    }
    const fieldConfig = normalization.fields[field as keyof typeof normalization.fields];
    if (!fieldConfig || typeof fieldConfig !== "object") {
      errors.push(`${where}: field '${field}' must be an object`);
      continue;
    }
    if (!fieldConfig.path || typeof fieldConfig.path !== "string") {
      errors.push(`${where}: field '${field}' is missing a valid 'path'`);
    } else {
      try {
        parseJsonPath(fieldConfig.path);
      } catch (err) {
        errors.push(`${where}: field '${field}' has invalid path: ${errMessage(err)}`);
      }
    }
    try {
      getUnitConverter(field, fieldConfig.unit, fieldConfig.convert_to);
    } catch (err) {
      errors.push(`${where}: field '${field}': ${errMessage(err)}`);
    }
  }

  if (normalization.required) {
    if (!Array.isArray(normalization.required)) {
      errors.push(`${where}: 'normalization.required' must be an array`);
    } else {
      for (const req of normalization.required) {
        if (!(ALL_WEATHER_FIELDS as string[]).includes(req)) {
          errors.push(`${where}: unknown required field '${req}'`);
        }
      }
    }
  }
}

function validateLocations(source: WeatherSourceConfig, where: string, errors: string[]): void {
  const locationIds = new Set<string>();
  source.locations.forEach((location, i) => {
    const locWhere = `${where} / location #${i + 1}`;
    if (!location || typeof location !== "object") {
      errors.push(`${locWhere}: location must be an object`);
      return;
    }
    if (typeof location.id !== "string" || location.id.trim() === "") {
      errors.push(`${locWhere}: missing or invalid 'id'`);
    } else if (locationIds.has(location.id)) {
      errors.push(`${locWhere}: duplicate location id '${location.id}'`);
    } else {
      locationIds.add(location.id);
    }
    if (typeof location.name !== "string" || location.name.trim() === "") {
      errors.push(`${locWhere}: missing or invalid 'name'`);
    }

    if (source.request?.location_param) {
      const param = source.request.location_param;
      const value = location[param];
      if (value === undefined || value === null || value === "") {
        errors.push(
          `${locWhere}: missing required location parameter '${param}' (needed by request.location_param)`,
        );
      }
    }
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function validateWeatherSourcesConfig(
  config: unknown,
): asserts config is WeatherSourcesConfig {
  validateConfig(config as WeatherSourcesConfig);
}