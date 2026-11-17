import { jsonPath } from "./json-path";
import { getUnitConverter } from "./units";
import {
  ALL_WEATHER_FIELDS,
  DEFAULT_REQUIRED_FIELDS,
  type NormalizationConfig,
  type NormalizedWeatherObservation,
  type TimestampFieldConfig,
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

  const required = new Set<WeatherField>([
    ...(config.required ?? DEFAULT_REQUIRED_FIELDS),
    "observed_at",
  ]);
  const values: Partial<Record<WeatherField, number | string | null>> = {};
  const errors: string[] = [];

  // 2 & 3. Extract and convert each configured field.
  for (const field of ALL_WEATHER_FIELDS) {
    const fieldConfig = config.fields[field];
    if (!fieldConfig) {
      // Not configured for this source -> leave null.
      if (required.has(field)) errors.push(`Required field '${field}' is not configured`);
      values[field] = null;
      continue;
    }

    const raw = jsonPath<unknown>(observation, fieldConfig.path);
    if (raw === undefined || raw === null || raw === "") {
      // Missing optional value.
      if (required.has(field)) {
        errors.push(`Required field '${field}' is missing (path '${fieldConfig.path}')`);
      }
      values[field] = null;
      continue;
    }

    if (field === "observed_at") {
      try {
        values[field] = normalizeTimestamp(raw, fieldConfig as TimestampFieldConfig);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Required field 'observed_at': ${message}`);
        values[field] = null;
      }
      continue;
    }

    const numeric = toNumber(raw);
    if (numeric === null) {
      if (required.has(field)) {
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

interface IsoTimestampParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

function normalizeTimestamp(
  raw: unknown,
  config: TimestampFieldConfig,
): string {
  if (!config.format) throw new Error("timestamp format is not configured");

  if (config.format === "unix_seconds" || config.format === "unix_milliseconds") {
    if (config.timezone !== undefined) throw new Error("timezone is not valid for Unix timestamps");
    const value = toNumber(raw);
    if (value === null) throw new Error("expected a numeric Unix timestamp");
    const milliseconds = config.format === "unix_seconds" ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) {
      throw new Error("Unix timestamp is outside the supported date range");
    }
    return date.toISOString();
  }

  if (config.format !== "iso8601") {
    throw new Error(`unsupported timestamp format '${String(config.format)}'`);
  }
  if (typeof raw !== "string") throw new Error("expected an ISO-8601 timestamp string");

  const value = raw.trim();
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) throw new Error(`invalid ISO-8601 timestamp '${raw}'`);
  const parts: IsoTimestampParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
    millisecond: Number(((match[7] ?? "") + "000").slice(0, 3)),
  };
  validateCalendarParts(parts);

  const offset = match[8];
  if (offset) {
    const canonicalOffset = offset.toUpperCase() === "Z" ? "Z" : normalizeOffset(offset);
    const normalized = `${value.slice(0, match[0].length - offset.length)}${canonicalOffset}`;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) throw new Error(`invalid ISO-8601 timestamp '${raw}'`);
    return date.toISOString();
  }

  if (!config.timezone) {
    throw new Error("ISO-8601 timestamp has no UTC offset; configure an IANA timezone");
  }
  return new Date(localTimeToEpoch(parts, config.timezone)).toISOString();
}

function normalizeOffset(offset: string): string {
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(offset);
  if (!match) throw new Error(`invalid ISO-8601 UTC offset '${offset}'`);
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? "0");
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) {
    throw new Error(`invalid ISO-8601 UTC offset '${offset}'`);
  }
  return `${match[1]}${match[2]}:${match[3] ?? "00"}`;
}

function validateCalendarParts(parts: IsoTimestampParts): void {
  if (
    parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 ||
    parts.hour > 23 || parts.minute > 59 || parts.second > 59
  ) {
    throw new Error("ISO-8601 timestamp contains an out-of-range date or time component");
  }
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  if (
    date.getUTCFullYear() !== parts.year || date.getUTCMonth() + 1 !== parts.month ||
    date.getUTCDate() !== parts.day
  ) {
    throw new Error("ISO-8601 timestamp contains an invalid calendar date");
  }
}

function epochFromParts(parts: IsoTimestampParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function localTimeToEpoch(parts: IsoTimestampParts, timezone: string): number {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`invalid IANA timezone '${timezone}'`);
  }

  const localEpoch = epochFromParts(parts);
  const offsets = new Set<number>();
  // Sample nearby offsets to handle daylight-saving boundaries. Candidate
  // instants are then round-tripped; DST gaps/folds are rejected, not guessed.
  for (let hours = -48; hours <= 48; hours += 3) {
    const sample = localEpoch + hours * 60 * 60 * 1000;
    const sampleSecond = Math.floor(sample / 1000) * 1000;
    offsets.add(epochFromParts(partsFromFormatter(formatter, sample)) - sampleSecond);
  }

  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = localEpoch - offset;
    if (sameWallTime(parts, partsFromFormatter(formatter, candidate))) matches.add(candidate);
  }
  if (matches.size === 0) throw new Error(`local timestamp does not exist in timezone '${timezone}'`);
  if (matches.size > 1) throw new Error(`local timestamp is ambiguous in timezone '${timezone}'`);
  return matches.values().next().value as number;
}

function partsFromFormatter(formatter: Intl.DateTimeFormat, epoch: number): IsoTimestampParts {
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(epoch)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: 0,
  };
}

function sameWallTime(left: IsoTimestampParts, right: IsoTimestampParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute && left.second === right.second;
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