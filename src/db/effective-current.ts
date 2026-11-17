import type { D1Database } from "@cloudflare/workers-types";

export const EFFECTIVE_SOURCE_PRIORITY = ["weather-com-pws", "open-meteo-current"] as const;
export const EFFECTIVE_SOURCE_MAX_AGE_MINUTES = {
  "weather-com-pws": 15,
  "open-meteo-current": 30,
} as const;

const MAX_SOURCE_AGE_MINUTES = Math.max(...Object.values(EFFECTIVE_SOURCE_MAX_AGE_MINUTES));

/** Broad physical sanity bounds: reject impossible values, not rare weather. */
export const EFFECTIVE_VALUE_LIMITS = {
  temperature: { min: -90, max: 60, unit: "°C" },
  solar_radiation: { min: 0, max: 2000, unit: "W/m²" },
  humidity: { min: 0, max: 100, unit: "%" },
  pressure: { min: 500, max: 1100, unit: "hPa" },
  wind_speed: { min: 0, max: 500, unit: "km/h" },
  wind_direction: { min: 0, max: 360, unit: "degrees" },
  wind_gust: { min: 0, max: 500, unit: "km/h" },
  uv_index: { min: 0, max: 30, unit: "index" },
  cloud_cover: { min: 0, max: 100, unit: "%" },
  visibility: { min: 0, max: 100_000, unit: "m" },
} as const;

export type EffectiveWeatherVariable = keyof typeof EFFECTIVE_VALUE_LIMITS;

interface LatestPairRow {
  location_id: string;
  location_name: string;
  latitude: number;
  longitude: number;
  pws_location_id: string;
  pws_observed_at: string | null;
  pws_temperature: number | null;
  pws_solar_radiation: number | null;
  pws_humidity: number | null;
  pws_pressure: number | null;
  pws_wind_speed: number | null;
  pws_wind_direction: number | null;
  pws_wind_gust: number | null;
  pws_uv_index: number | null;
  pws_cloud_cover: number | null;
  pws_visibility: number | null;
  meteo_location_id: string;
  meteo_observed_at: string | null;
  meteo_temperature: number | null;
  meteo_solar_radiation: number | null;
  meteo_humidity: number | null;
  meteo_pressure: number | null;
  meteo_wind_speed: number | null;
  meteo_wind_direction: number | null;
  meteo_wind_gust: number | null;
  meteo_uv_index: number | null;
  meteo_cloud_cover: number | null;
  meteo_visibility: number | null;
}

export interface EffectiveWeatherValue {
  value: number;
  unit: string;
  source_id: (typeof EFFECTIVE_SOURCE_PRIORITY)[number];
  location_id: string;
  observed_at: string;
  age_minutes: number;
  fallback: boolean;
}

export interface EffectiveCurrentLocation {
  location: { id: string; name: string; latitude: number; longitude: number };
  values: Record<EffectiveWeatherVariable, EffectiveWeatherValue | null>;
}

type SourceKey = "pws" | "meteo";

const VARIABLE_FIELDS: Record<EffectiveWeatherVariable, string> = {
  temperature: "temperature",
  solar_radiation: "solar_radiation",
  humidity: "humidity",
  pressure: "pressure",
  wind_speed: "wind_speed",
  wind_direction: "wind_direction",
  wind_gust: "wind_gust",
  uv_index: "uv_index",
  cloud_cover: "cloud_cover",
  visibility: "visibility",
};

/**
 * Resolve current values from the original observations without writing or
 * aggregating them. The newest observation per source/location is selected
 * first; null or invalid fields in it are not filled from older rows of that
 * same source.
 */
export async function getEffectiveCurrentValues(
  db: D1Database,
  options: { now?: Date } = {},
): Promise<EffectiveCurrentLocation[]> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const earliestValidAt = new Date(
    now.getTime() - MAX_SOURCE_AGE_MINUTES * 60_000,
  ).toISOString();

  const result = await db
    .prepare(
      `SELECT
         pws_loc.id AS location_id,
         pws_loc.name AS location_name,
         pws_loc.latitude AS latitude,
         pws_loc.longitude AS longitude,
         pws_loc.id AS pws_location_id,
         pws_obs.observed_at AS pws_observed_at,
         pws_obs.temperature AS pws_temperature,
         pws_obs.solar_radiation AS pws_solar_radiation,
         pws_obs.humidity AS pws_humidity,
         pws_obs.pressure AS pws_pressure,
         pws_obs.wind_speed AS pws_wind_speed,
         pws_obs.wind_direction AS pws_wind_direction,
         pws_obs.wind_gust AS pws_wind_gust,
         pws_obs.uv_index AS pws_uv_index,
         pws_obs.cloud_cover AS pws_cloud_cover,
         pws_obs.visibility AS pws_visibility,
         meteo_loc.id AS meteo_location_id,
         meteo_obs.observed_at AS meteo_observed_at,
         meteo_obs.temperature AS meteo_temperature,
         meteo_obs.solar_radiation AS meteo_solar_radiation,
         meteo_obs.humidity AS meteo_humidity,
         meteo_obs.pressure AS meteo_pressure,
         meteo_obs.wind_speed AS meteo_wind_speed,
         meteo_obs.wind_direction AS meteo_wind_direction,
         meteo_obs.wind_gust AS meteo_wind_gust,
         meteo_obs.uv_index AS meteo_uv_index,
         meteo_obs.cloud_cover AS meteo_cloud_cover,
         meteo_obs.visibility AS meteo_visibility
       FROM weather_locations pws_loc
       JOIN weather_locations meteo_loc
         ON meteo_loc.latitude = pws_loc.latitude
        AND meteo_loc.longitude = pws_loc.longitude
        AND meteo_loc.source_id = ?
       LEFT JOIN weather_observations pws_obs
         ON pws_obs.id = (
           SELECT latest.id
           FROM weather_observations latest
           WHERE latest.location_id = pws_loc.id
             AND latest.source_id = pws_loc.source_id
             AND latest.observed_at >= ?
             AND latest.observed_at <= ?
           ORDER BY latest.observed_at DESC
           LIMIT 1
         )
       LEFT JOIN weather_observations meteo_obs
         ON meteo_obs.id = (
           SELECT latest.id
           FROM weather_observations latest
           WHERE latest.location_id = meteo_loc.id
             AND latest.source_id = meteo_loc.source_id
             AND latest.observed_at >= ?
             AND latest.observed_at <= ?
           ORDER BY latest.observed_at DESC
           LIMIT 1
         )
       WHERE pws_loc.source_id = ?
         AND pws_loc.latitude IS NOT NULL
         AND pws_loc.longitude IS NOT NULL
       ORDER BY pws_loc.name ASC, pws_loc.id ASC`,
    )
    .bind(
      EFFECTIVE_SOURCE_PRIORITY[1],
      earliestValidAt,
      nowIso,
      earliestValidAt,
      nowIso,
      EFFECTIVE_SOURCE_PRIORITY[0],
    )
    .all<LatestPairRow>();

  return (result.results ?? []).map((row) => resolveLocation(row, now.getTime()));
}

function resolveLocation(row: LatestPairRow, nowMs: number): EffectiveCurrentLocation {
  const values = {} as Record<EffectiveWeatherVariable, EffectiveWeatherValue | null>;

  for (const variable of Object.keys(EFFECTIVE_VALUE_LIMITS) as EffectiveWeatherVariable[]) {
    values[variable] = resolveVariable(row, variable, nowMs);
  }

  return {
    location: {
      id: row.location_id,
      name: row.location_name,
      latitude: row.latitude,
      longitude: row.longitude,
    },
    values,
  };
}

function resolveVariable(
  row: LatestPairRow,
  variable: EffectiveWeatherVariable,
  nowMs: number,
): EffectiveWeatherValue | null {
  const column = VARIABLE_FIELDS[variable];
  const limits = EFFECTIVE_VALUE_LIMITS[variable];

  for (const source of EFFECTIVE_SOURCE_PRIORITY) {
    const prefix: SourceKey = source === EFFECTIVE_SOURCE_PRIORITY[0] ? "pws" : "meteo";
    const observedAt = row[`${prefix}_observed_at` as keyof LatestPairRow];
    if (typeof observedAt !== "string") continue;

    const observedMs = Date.parse(observedAt);
    if (!Number.isFinite(observedMs) || observedMs > nowMs) continue;
    const ageMs = nowMs - observedMs;
    if (ageMs > EFFECTIVE_SOURCE_MAX_AGE_MINUTES[source] * 60_000) continue;

    const value = row[`${prefix}_${column}` as keyof LatestPairRow];
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < limits.min ||
      value > limits.max
    ) {
      continue;
    }

    return {
      value,
      unit: limits.unit,
      source_id: source,
      location_id: prefix === "pws" ? row.pws_location_id : row.meteo_location_id,
      observed_at: observedAt,
      age_minutes: Number((ageMs / 60_000).toFixed(2)),
      fallback: source !== EFFECTIVE_SOURCE_PRIORITY[0],
    };
  }

  return null;
}