import {
  ALL_WEATHER_FIELDS,
  type HttpMethod,
  type NormalizationConfig,
  type TimestampFormat,
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
const TIMESTAMP_FORMATS: TimestampFormat[] = ["iso8601", "unix_seconds", "unix_milliseconds"];

export function validateConfig(config: WeatherSourcesConfig): void {
  const errors: string[] = [];

  if (!Array.isArray(config)) {
    throw new ConfigValidationError("Configuration must be an array of source definitions");
  }

  const sourceIds = new Set<string>();
  const locationIds = new Map<string, string>();
  const externalIds = new Map<string, Map<string, string>>();
  config.forEach((source, index) => {
    const where = `source #${index + 1}`;
    validateSource(source, where, sourceIds, locationIds, externalIds, errors);
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
  locationIds: Map<string, string>,
  externalIds: Map<string, Map<string, string>>,
  errors: string[],
): void {
  if (!source || typeof source !== "object") {
    errors.push(`${where}: source entry must be an object`);
    return;
  }

  if (!source.id || typeof source.id !== "string" || source.id.trim() === "") {
    errors.push(`${where}: missing or invalid 'id'`);
  } else if (source.id !== source.id.trim()) {
    errors.push(`${where}: 'id' must not have leading or trailing whitespace`);
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
    validateLocations(
      source,
      `${where} (${source.id ?? "unknown"})`,
      locationIds,
      externalIds,
      errors,
    );
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
    request.location_param !== undefined &&
    (typeof request.location_param !== "string" || request.location_param.trim() === "")
  ) {
    errors.push(`${where}: 'request.location_param' must be a non-empty string when provided`);
  }
  if (request.location_params !== undefined) {
    if (
      !request.location_params ||
      typeof request.location_params !== "object" ||
      Array.isArray(request.location_params)
    ) {
      errors.push(`${where}: 'request.location_params' must be an object when provided`);
    } else {
      for (const [parameterName, locationProperty] of Object.entries(request.location_params)) {
        if (parameterName.trim() === "") {
          errors.push(`${where}: 'request.location_params' parameter names must not be empty`);
        }
        if (typeof locationProperty !== "string" || locationProperty.trim() === "") {
          errors.push(
            `${where}: location property for request parameter '${parameterName}' must be a non-empty string`,
          );
        }
      }
    }
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
    if (field === "observed_at") {
      validateTimestampConfig(
        fieldConfig as NonNullable<NormalizationConfig["fields"]["observed_at"]>,
        where,
        errors,
      );
    } else if ("format" in fieldConfig || "timezone" in fieldConfig) {
      errors.push(`${where}: timestamp options 'format' and 'timezone' are only valid for 'observed_at'`);
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
    if (field === "observed_at") {
      if (fieldConfig.unit !== undefined || fieldConfig.convert_to !== undefined) {
        errors.push(`${where}: field 'observed_at' does not support unit conversion`);
      }
    } else {
      try {
        getUnitConverter(field, fieldConfig.unit, fieldConfig.convert_to);
      } catch (err) {
        errors.push(`${where}: field '${field}': ${errMessage(err)}`);
      }
    }
  }

  if (!normalization.fields.observed_at) {
    errors.push(`${where}: normalization.fields.observed_at is required`);
  }

  if (normalization.required !== undefined) {
    if (!Array.isArray(normalization.required)) {
      errors.push(`${where}: 'normalization.required' must be an array`);
    } else {
      for (const req of normalization.required) {
        if (!(ALL_WEATHER_FIELDS as string[]).includes(req)) {
          errors.push(`${where}: unknown required field '${req}'`);
        } else if (!normalization.fields[req as keyof typeof normalization.fields]) {
          errors.push(`${where}: required field '${req}' has no normalization mapping`);
        }
      }
      if (new Set(normalization.required).size !== normalization.required.length) {
        errors.push(`${where}: 'normalization.required' must not contain duplicate fields`);
      }
    }
  }
}

function validateTimestampConfig(
  fieldConfig: NonNullable<NormalizationConfig["fields"]["observed_at"]>,
  where: string,
  errors: string[],
): void {
  if (!fieldConfig.format || !TIMESTAMP_FORMATS.includes(fieldConfig.format)) {
    errors.push(
      `${where}: field 'observed_at' must declare format (${TIMESTAMP_FORMATS.join(", ")})`,
    );
  }

  if (fieldConfig.timezone !== undefined) {
    if (typeof fieldConfig.timezone !== "string" || fieldConfig.timezone.trim() === "") {
      errors.push(`${where}: field 'observed_at' timezone must be a non-empty IANA timezone`);
    } else {
      try {
        new Intl.DateTimeFormat("en", { timeZone: fieldConfig.timezone }).format(0);
      } catch {
        errors.push(`${where}: field 'observed_at' has invalid timezone '${fieldConfig.timezone}'`);
      }
    }
  }

  if (fieldConfig.format !== "iso8601" && fieldConfig.timezone !== undefined) {
    errors.push(`${where}: field 'observed_at' timezone is only valid with format 'iso8601'`);
  }
}

function validateLocations(
  source: WeatherSourceConfig,
  where: string,
  globalLocationIds: Map<string, string>,
  externalIdsBySource: Map<string, Map<string, string>>,
  errors: string[],
): void {
  const sourceId = typeof source.id === "string" ? source.id : "<invalid-source>";
  let sourceExternalIds = externalIdsBySource.get(sourceId);
  if (!sourceExternalIds) {
    sourceExternalIds = new Map<string, string>();
    externalIdsBySource.set(sourceId, sourceExternalIds);
  }

  source.locations.forEach((location, i) => {
    const locWhere = `${where} / location #${i + 1}`;
    if (!location || typeof location !== "object") {
      errors.push(`${locWhere}: location must be an object`);
      return;
    }
    if (typeof location.id !== "string" || location.id.trim() === "") {
      errors.push(`${locWhere}: missing or invalid 'id'`);
    } else {
      if (location.id !== location.id.trim()) {
        errors.push(`${locWhere}: 'id' must not have leading or trailing whitespace`);
      }
      const priorLocation = globalLocationIds.get(location.id);
      if (priorLocation) {
        errors.push(
          `${locWhere}: duplicate global location id '${location.id}' (already defined at ${priorLocation})`,
        );
      } else {
        globalLocationIds.set(location.id, locWhere);
      }
    }
    if (typeof location.name !== "string" || location.name.trim() === "") {
      errors.push(`${locWhere}: missing or invalid 'name'`);
    }

    const configuredParam = source.request?.location_param;
    const param = typeof configuredParam === "string" && configuredParam.trim() !== ""
      ? configuredParam
      : undefined;
    const externalIdValue = param ? location[param] : (location.external_id ?? location.id);
    if (
      externalIdValue === undefined ||
      externalIdValue === null ||
      (typeof externalIdValue === "string" && externalIdValue.trim() === "") ||
      (typeof externalIdValue === "number" && !Number.isFinite(externalIdValue)) ||
      !["string", "number", "boolean"].includes(typeof externalIdValue)
    ) {
      if (param) {
        errors.push(
          `${locWhere}: missing required location parameter '${param}' (needed by request.location_param)`,
        );
      } else {
        errors.push(`${locWhere}: missing or invalid external location identifier`);
      }
      return;
    }

    for (const [parameterName, locationProperty] of Object.entries(
      source.request?.location_params ?? {},
    )) {
      const value = location[locationProperty];
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim() === "") ||
        (typeof value === "number" && !Number.isFinite(value)) ||
        !["string", "number", "boolean"].includes(typeof value)
      ) {
        errors.push(
          `${locWhere}: missing or invalid location property '${locationProperty}' (needed by request parameter '${parameterName}')`,
        );
      }
    }

    const externalId = String(externalIdValue);
    const priorExternalId = sourceExternalIds.get(externalId);
    if (priorExternalId) {
      errors.push(
        `${locWhere}: duplicate external location id '${externalId}' for source '${sourceId}' (already defined at ${priorExternalId})`,
      );
    } else {
      sourceExternalIds.set(externalId, locWhere);
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