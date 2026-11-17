import type { D1Database } from "@cloudflare/workers-types";

/** Maximum permitted separation between the valid times of paired values. */
export const COMPARISON_TOLERANCE_MINUTES = 15;

/** Only inspect recent rows; this bounds work and keeps the endpoint current. */
export const COMPARISON_LOOKBACK_MINUTES = 30;

/** Direction is not meaningful enough to compare when either source is calm. */
export const CALM_WIND_THRESHOLD_KMH = 3;

export const COMPARISON_THRESHOLDS = {
  temperature: { threshold: 2, unit: "°C" },
  solar_radiation: { threshold: 100, unit: "W/m²" },
  humidity: { threshold: 10, unit: "percentage points" },
  pressure: { threshold: 5, unit: "hPa" },
  wind_speed: { threshold: 10, unit: "km/h" },
  wind_direction: { threshold: 30, unit: "degrees" },
  wind_gust: { threshold: 15, unit: "km/h" },
  cloud_cover: { threshold: 20, unit: "percentage points" },
  visibility: { threshold: 5000, unit: "m" },
  uv_index: { threshold: 2, unit: "index" },
} as const;

export type ComparableWeatherVariable = keyof typeof COMPARISON_THRESHOLDS;
export type ComparisonStatus = "within_threshold" | "divergence" | "not_comparable";

interface ComparisonObservationRow {
  location_a_id: string;
  location_b_id: string;
  location_a_name: string;
  location_b_name: string;
  latitude: number;
  longitude: number;
  source_a_id: string;
  source_b_id: string;
  observed_a_at: string;
  observed_b_at: string;
  collected_a_at: string;
  collected_b_at: string;
  temperature_a: number | null;
  temperature_b: number | null;
  solar_radiation_a: number | null;
  solar_radiation_b: number | null;
  humidity_a: number | null;
  humidity_b: number | null;
  pressure_a: number | null;
  pressure_b: number | null;
  wind_speed_a: number | null;
  wind_speed_b: number | null;
  wind_direction_a: number | null;
  wind_direction_b: number | null;
  wind_gust_a: number | null;
  wind_gust_b: number | null;
  cloud_cover_a: number | null;
  cloud_cover_b: number | null;
  visibility_a: number | null;
  visibility_b: number | null;
  uv_index_a: number | null;
  uv_index_b: number | null;
}

export interface SourceComparisonValue {
  source_id: string;
  location_id: string;
  value: number;
  observed_at: string;
  collected_at: string;
}

export interface WeatherSourceComparison {
  location: {
    name: string;
    latitude: number;
    longitude: number;
  };
  variable: ComparableWeatherVariable;
  unit: string;
  source_a: SourceComparisonValue;
  source_b: SourceComparisonValue;
  /** Absolute difference, or minimum circular difference for wind direction. */
  difference: number;
  threshold: number;
  time_difference_minutes: number;
  status: ComparisonStatus;
  reason?: "calm_or_missing_wind_speed";
}

interface Candidate {
  row: ComparisonObservationRow;
  timeGapMs: number;
  latestSharedTime: number;
}

const VARIABLE_COLUMNS: Record<
  ComparableWeatherVariable,
  { left: keyof ComparisonObservationRow; right: keyof ComparisonObservationRow }
> = {
  temperature: { left: "temperature_a", right: "temperature_b" },
  solar_radiation: { left: "solar_radiation_a", right: "solar_radiation_b" },
  humidity: { left: "humidity_a", right: "humidity_b" },
  pressure: { left: "pressure_a", right: "pressure_b" },
  wind_speed: { left: "wind_speed_a", right: "wind_speed_b" },
  wind_direction: { left: "wind_direction_a", right: "wind_direction_b" },
  wind_gust: { left: "wind_gust_a", right: "wind_gust_b" },
  cloud_cover: { left: "cloud_cover_a", right: "cloud_cover_b" },
  visibility: { left: "visibility_a", right: "visibility_b" },
  uv_index: { left: "uv_index_a", right: "uv_index_b" },
};

/**
 * Compute current cross-source comparisons without persisting or modifying
 * source observations. Location IDs are source-specific, so configured equal
 * coordinates are used to identify the same logical place.
 */
export async function getWeatherSourceComparisons(
  db: D1Database,
  options: { now?: Date } = {},
): Promise<WeatherSourceComparison[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - COMPARISON_LOOKBACK_MINUTES * 60_000).toISOString();

  const result = await db
    .prepare(
      `SELECT
         a.id AS location_a_id,
         b.id AS location_b_id,
         a.name AS location_a_name,
         b.name AS location_b_name,
         a.latitude AS latitude,
         a.longitude AS longitude,
         a.source_id AS source_a_id,
         b.source_id AS source_b_id,
         oa.observed_at AS observed_a_at,
         ob.observed_at AS observed_b_at,
         oa.collected_at AS collected_a_at,
         ob.collected_at AS collected_b_at,
         oa.temperature AS temperature_a,
         ob.temperature AS temperature_b,
         oa.solar_radiation AS solar_radiation_a,
         ob.solar_radiation AS solar_radiation_b,
         oa.humidity AS humidity_a,
         ob.humidity AS humidity_b,
         oa.pressure AS pressure_a,
         ob.pressure AS pressure_b,
         oa.wind_speed AS wind_speed_a,
         ob.wind_speed AS wind_speed_b,
         oa.wind_direction AS wind_direction_a,
         ob.wind_direction AS wind_direction_b,
         oa.wind_gust AS wind_gust_a,
         ob.wind_gust AS wind_gust_b,
         oa.cloud_cover AS cloud_cover_a,
         ob.cloud_cover AS cloud_cover_b,
         oa.visibility AS visibility_a,
         ob.visibility AS visibility_b,
         oa.uv_index AS uv_index_a,
         ob.uv_index AS uv_index_b
       FROM weather_locations a
       JOIN weather_locations b
         ON a.latitude = b.latitude
        AND a.longitude = b.longitude
        AND a.source_id < b.source_id
       JOIN weather_observations oa
         ON oa.location_id = a.id
        AND oa.source_id = a.source_id
        AND oa.observed_at >= ?
       JOIN weather_observations ob
         ON ob.location_id = b.id
        AND ob.source_id = b.source_id
        AND ob.observed_at >= ?
       WHERE a.latitude IS NOT NULL
         AND a.longitude IS NOT NULL
         AND oa.observed_at <= ?
         AND ob.observed_at <= ?
       ORDER BY a.id, b.id, oa.observed_at DESC, ob.observed_at DESC`,
    )
    .bind(since, since, now.toISOString(), now.toISOString())
    .all<ComparisonObservationRow>();

  const groups = new Map<string, ComparisonObservationRow[]>();
  for (const row of result.results ?? []) {
    const key = `${row.location_a_id}\u0000${row.location_b_id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const comparisons: WeatherSourceComparison[] = [];
  for (const rows of groups.values()) {
    for (const variable of Object.keys(COMPARISON_THRESHOLDS) as ComparableWeatherVariable[]) {
      const candidate = findCandidate(rows, variable);
      if (!candidate) continue;
      comparisons.push(toComparison(candidate, variable));
    }
  }

  return comparisons.sort((left, right) =>
    left.location.name.localeCompare(right.location.name) ||
    left.variable.localeCompare(right.variable) ||
    left.source_a.source_id.localeCompare(right.source_a.source_id) ||
    left.source_b.source_id.localeCompare(right.source_b.source_id),
  );
}

function findCandidate(
  rows: ComparisonObservationRow[],
  variable: ComparableWeatherVariable,
): Candidate | undefined {
  const columns = VARIABLE_COLUMNS[variable];
  const maxGapMs = COMPARISON_TOLERANCE_MINUTES * 60_000;
  let best: Candidate | undefined;

  for (const row of rows) {
    const leftValue = row[columns.left];
    const rightValue = row[columns.right];
    if (typeof leftValue !== "number" || !Number.isFinite(leftValue)) continue;
    if (typeof rightValue !== "number" || !Number.isFinite(rightValue)) continue;

    const leftTime = Date.parse(row.observed_a_at);
    const rightTime = Date.parse(row.observed_b_at);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) continue;
    const timeGapMs = Math.abs(leftTime - rightTime);
    if (timeGapMs > maxGapMs) continue;

    const candidate: Candidate = {
      row,
      timeGapMs,
      latestSharedTime: Math.min(leftTime, rightTime),
    };
    if (
      !best ||
      candidate.latestSharedTime > best.latestSharedTime ||
      (candidate.latestSharedTime === best.latestSharedTime && candidate.timeGapMs < best.timeGapMs)
    ) {
      best = candidate;
    }
  }

  return best;
}

function toComparison(
  candidate: Candidate,
  variable: ComparableWeatherVariable,
): WeatherSourceComparison {
  const { row } = candidate;
  const columns = VARIABLE_COLUMNS[variable];
  const leftValue = row[columns.left] as number;
  const rightValue = row[columns.right] as number;
  const difference = variable === "wind_direction"
    ? angularDifference(leftValue, rightValue)
    : Math.abs(leftValue - rightValue);
  const { threshold, unit } = COMPARISON_THRESHOLDS[variable];
  const calmDirection = variable === "wind_direction" &&
    (row.wind_speed_a === null || row.wind_speed_b === null ||
      row.wind_speed_a < CALM_WIND_THRESHOLD_KMH ||
      row.wind_speed_b < CALM_WIND_THRESHOLD_KMH);

  return {
    location: {
      name: row.location_a_name || row.location_b_name,
      latitude: row.latitude,
      longitude: row.longitude,
    },
    variable,
    unit,
    source_a: {
      source_id: row.source_a_id,
      location_id: row.location_a_id,
      value: leftValue,
      observed_at: row.observed_a_at,
      collected_at: row.collected_a_at,
    },
    source_b: {
      source_id: row.source_b_id,
      location_id: row.location_b_id,
      value: rightValue,
      observed_at: row.observed_b_at,
      collected_at: row.collected_b_at,
    },
    difference,
    threshold,
    time_difference_minutes: candidate.timeGapMs / 60_000,
    status: calmDirection
      ? "not_comparable"
      : difference > threshold
        ? "divergence"
        : "within_threshold",
    ...(calmDirection ? { reason: "calm_or_missing_wind_speed" as const } : {}),
  };
}

function angularDifference(left: number, right: number): number {
  const normalized = Math.abs(((left % 360) + 360) % 360 - ((right % 360) + 360) % 360);
  return Math.min(normalized, 360 - normalized);
}