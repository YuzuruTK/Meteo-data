import type { AggregateRow, PrecipitationSample } from "./types";

/**
 * Period statistics and peer comparisons for the Instant dashboard.
 *
 * These helpers are intentionally pure: the API supplies hourly rollup rows
 * and cumulative precipitation samples, while this module owns the
 * interpretation rules (units, thresholds, missing values, percentages versus
 * percentage points). Keeping the calculations here lets React components deal
 * only with presentation and makes the comparison rules directly testable.
 */

export type MetricKey =
  | "temperature"
  | "solarRadiation"
  | "humidity"
  | "uvIndex"
  | "precipitation"
  | "windSpeed";

export type ComparisonDirection = "positive" | "negative" | "neutral" | "unavailable";
export type ComparisonSemantic = "warmer" | "cooler" | "above" | "below" | "equal" | "unavailable";

export interface MetricDefinition {
  key: MetricKey;
  /** Canonical source label; translated by the existing i18n layer. */
  label: string;
  unit: string;
  decimals: number;
  kind: "temperature" | "humidity" | "solar" | "uv" | "precipitation" | "wind";
  supportsMinMax: boolean;
}

export const METRIC_DEFINITIONS: Record<MetricKey, MetricDefinition> = {
  temperature: {
    key: "temperature",
    label: "Temperature",
    unit: "°C",
    decimals: 1,
    kind: "temperature",
    supportsMinMax: true,
  },
  solarRadiation: {
    key: "solarRadiation",
    label: "Solar radiation",
    unit: "W/m²",
    decimals: 0,
    kind: "solar",
    supportsMinMax: true,
  },
  humidity: {
    key: "humidity",
    label: "Humidity",
    unit: "%",
    decimals: 0,
    kind: "humidity",
    supportsMinMax: true,
  },
  uvIndex: {
    key: "uvIndex",
    label: "UV index",
    unit: "",
    decimals: 1,
    kind: "uv",
    supportsMinMax: false,
  },
  precipitation: {
    key: "precipitation",
    label: "Accumulated precipitation",
    unit: "mm",
    decimals: 1,
    kind: "precipitation",
    supportsMinMax: false,
  },
  windSpeed: {
    key: "windSpeed",
    label: "Wind speed",
    unit: "km/h",
    decimals: 1,
    kind: "wind",
    supportsMinMax: false,
  },
};

export interface MetricValue {
  value: number;
  min: number | null;
  max: number | null;
  /** True when at least half of the selected hourly buckets contain data. */
  sufficient: boolean;
  /** Number of hourly buckets contributing to the metric. */
  samples: number;
}

export interface PeriodStatistics {
  expectedHours: number;
  byStation: Map<string, Map<MetricKey, MetricValue>>;
}

export interface PeerDifference {
  /** Difference from the peer average, in the metric's own unit. */
  absolute: number;
  /** Percentage difference, only when the baseline is non-zero. */
  percentage: number | null;
  baseline: number;
  peerCount: number;
  direction: ComparisonDirection;
  semantic: ComparisonSemantic;
}

export interface PeerComparison {
  stationId: string;
  value: number | null;
  referenceValue: number | null;
  peerCount: number;
  difference: PeerDifference | null;
  reason: "available" | "single_station" | "no_comparable_peer" | "insufficient_data";
}

function metricColumns(metric: MetricKey): { avg: keyof AggregateRow; min?: keyof AggregateRow; max?: keyof AggregateRow } {
  switch (metric) {
    case "temperature":
      return { avg: "temperature_avg", min: "temperature_min", max: "temperature_max" };
    case "solarRadiation":
      return { avg: "solar_radiation_avg", min: "solar_radiation_min", max: "solar_radiation_max" };
    case "humidity":
      return { avg: "humidity_avg", min: "humidity_min", max: "humidity_max" };
    case "uvIndex":
      return { avg: "uv_index_avg", max: "uv_index_max" };
    case "precipitation":
      return { avg: "precipitation_total_avg" };
    case "windSpeed":
      return { avg: "wind_speed_avg" };
  }
}

function aggregateHourlyValues(rows: AggregateRow[], metric: MetricKey): MetricValue | null {
  const columns = metricColumns(metric);
  const values: number[] = [];
  let observations = 0;

  for (const row of rows) {
    const value = row[columns.avg];
    if (!isFiniteNumber(value)) continue;
    const count = isFiniteNumber(row.observation_count) && row.observation_count > 0
      ? row.observation_count
      : 1;
    for (let i = 0; i < count; i += 1) values.push(value);
    observations += count;
  }

  if (values.length === 0 || observations === 0) return null;

  const minValues = rows
    .map((row) => (columns.min ? row[columns.min] : null))
    .filter(isFiniteNumber);
  const maxValues = rows
    .map((row) => (columns.max ? row[columns.max] : null))
    .filter(isFiniteNumber);

  // Weight by raw observation count so the period average uses the same
  // weighting semantics as the rollup tables that produced the hourly values.
  const value = values.reduce((sum, current) => sum + current, 0) / observations;
  const coverage = values.length / Math.max(1, rows.length);

  return {
    value: round(value, 3),
    min: minValues.length > 0 ? round(Math.min(...minValues), 3) : null,
    max: maxValues.length > 0 ? round(Math.max(...maxValues), 3) : null,
    sufficient: coverage >= MINIMUM_COVERAGE,
    samples: values.length,
  };
}

/**
 * Build one period summary per station from the hourly aggregate rows.
 * `expectedHours` is the number of hourly buckets expected in the selected
 * window; coverage is evaluated against it rather than against only the rows
 * a station happened to return.
 */
export function buildPeriodStatistics(
  rows: AggregateRow[],
  expectedHours: number,
): PeriodStatistics {
  const byStation = new Map<string, Map<MetricKey, MetricValue>>();
  const rowsByStation = new Map<string, AggregateRow[]>();

  for (const row of rows) {
    const stationRows = rowsByStation.get(row.station_id) ?? [];
    stationRows.push(row);
    rowsByStation.set(row.station_id, stationRows);
  }

  const denominator = Math.max(1, Math.round(expectedHours));
  for (const [stationId, stationRows] of rowsByStation) {
    const metrics = new Map<MetricKey, MetricValue>();
    for (const metric of Object.keys(METRIC_DEFINITIONS) as MetricKey[]) {
      const summary = aggregateHourlyValues(stationRows, metric);
      if (summary) {
        metrics.set(metric, {
          ...summary,
          sufficient: summary.samples / denominator >= MINIMUM_COVERAGE,
        });
      }
    }
    byStation.set(stationId, metrics);
  }

  return { expectedHours: denominator, byStation };
}

/** Weighted period average for one metric, or null when it has no values. */
export function periodMetricValue(
  statistics: PeriodStatistics,
  stationId: string,
  metric: MetricKey,
): MetricValue | null {
  return statistics.byStation.get(stationId)?.get(metric) ?? null;
}

export interface BuildComparisonInput {
  stationId: string;
  value: number | null;
  /** All selected stations, including the one being evaluated. */
  values: Array<{ stationId: string; value: number | null; sufficient?: boolean; sourceId?: string }>;
  kind: MetricDefinition["kind"];
  /** Restrict the peer baseline to stations from the same data source. */
  sourceId?: string;
  /**
   * Whether the station has enough coverage for the selected window. The UI
   * passes false when a station has some values but not enough for a fair
   * period comparison; such stations are excluded from the peer baseline too.
   */
  sufficient?: boolean;
}

const MINIMUM_COVERAGE = 0.5;
const TEMPERATURE_NEUTRAL_DELTA = 0.05;
const ABSOLUTE_NEUTRAL_DELTA = 0.05;
const PERCENTAGE_NEUTRAL_DELTA = 0.5;

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function semanticFor(direction: ComparisonDirection, kind: MetricDefinition["kind"]): ComparisonSemantic {
  if (direction === "unavailable") return "unavailable";
  if (direction === "neutral") return "equal";
  if (kind === "temperature") return direction === "positive" ? "warmer" : "cooler";
  return direction === "positive" ? "above" : "below";
}

/**
 * Compare one station against the mean of every OTHER station with a valid
 * value for the same metric and period. Missing peer values are excluded from
 * the baseline, never treated as zero. Relative differences are omitted when
 * the baseline is zero and are never applied to Celsius temperature.
 */
export function compareToPeerAverage(input: BuildComparisonInput): PeerComparison {
  const validValues = input.values.filter(
    (entry) => isFiniteNumber(entry.value) && (entry.sufficient ?? true),
  );
  const sameSource = (entry: { sourceId?: string }): boolean =>
    input.sourceId === undefined
    || entry.sourceId === undefined
    || entry.sourceId === input.sourceId;
  const peers = validValues.filter((entry) =>
    entry.stationId !== input.stationId && sameSource(entry),
  );
  const peerValues = peers.map((entry) => entry.value as number);
  const stationSufficient = input.sufficient ?? true;

  if (!stationSufficient) {
    return {
      stationId: input.stationId,
      value: isFiniteNumber(input.value) ? input.value : null,
      referenceValue: peerValues.length > 0
        ? peerValues.reduce((sum, value) => sum + value, 0) / peerValues.length
        : null,
      peerCount: peerValues.length,
      difference: null,
      reason: "insufficient_data",
    };
  }

  if (input.values.length < 2) {
    return {
      stationId: input.stationId,
      value: isFiniteNumber(input.value) ? input.value : null,
      referenceValue: null,
      peerCount: 0,
      difference: null,
      reason: "single_station",
    };
  }

  if (!isFiniteNumber(input.value) || peerValues.length === 0) {
    return {
      stationId: input.stationId,
      value: isFiniteNumber(input.value) ? input.value : null,
      referenceValue: peerValues.length > 0
        ? peerValues.reduce((sum, value) => sum + value, 0) / peerValues.length
        : null,
      peerCount: peerValues.length,
      difference: null,
      reason: isFiniteNumber(input.value) ? "no_comparable_peer" : "insufficient_data",
    };
  }

  const baseline = peerValues.reduce((sum, value) => sum + value, 0) / peerValues.length;
  const absolute = input.value - baseline;
  // Temperature, humidity, UV and wind use absolute differences: Celsius is
  // never interpreted relatively, humidity is percentage points, UV and wind
  // have no meaningful ratio. Solar radiation and precipitation use a
  // percentage only when the peer baseline is non-zero.
  const relativeMetric = input.kind === "solar" || input.kind === "precipitation";
  const percentage = relativeMetric && baseline !== 0
    ? (absolute / Math.abs(baseline)) * 100
    : null;
  const neutralThreshold = percentage !== null
    ? PERCENTAGE_NEUTRAL_DELTA
    : input.kind === "temperature"
      ? TEMPERATURE_NEUTRAL_DELTA
      : ABSOLUTE_NEUTRAL_DELTA;
  const measured = percentage !== null ? percentage : absolute;
  const direction: ComparisonDirection = Math.abs(measured) < neutralThreshold
    ? "neutral"
    : measured > 0
      ? "positive"
      : "negative";

  return {
    stationId: input.stationId,
    value: input.value,
    referenceValue: baseline,
    peerCount: peerValues.length,
    difference: {
      absolute,
      percentage,
      baseline,
      peerCount: peerValues.length,
      direction,
      semantic: semanticFor(direction, input.kind),
    },
    reason: "available",
  };
}

/** Summary of cumulative precipitation samples for one station. */
export interface PrecipitationBoundary {
  stationId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  value: number | null;
}

/**
 * Derive accumulated rainfall from cumulative readings.
 *
 * Positive changes are rain; a decrease is treated as a gauge reset and the
 * new reading is counted. Missing readings do not reset the baseline. A gap
 * longer than `maxGapMinutes` makes the accumulation unavailable because a
 * reset or rain event could have happened unobserved.
 */
export function deriveAccumulatedPrecipitation(
  samples: PrecipitationSample[],
  options: { maxGapMinutes?: number; cumulativeSourcePrefix?: string } = {},
): PrecipitationBoundary {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const base = {
    stationId: first?.station_id ?? "",
    firstObservedAt: first?.observed_at ?? "",
    lastObservedAt: last?.observed_at ?? "",
  };
  if (!first || !last) return { ...base, value: null };

  const maxGapMs = (options.maxGapMinutes ?? 30) * 60_000;
  const cumulativeSourcePrefix = options.cumulativeSourcePrefix ?? "weather-com";
  const sorted = samples.slice().sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  let total = 0;
  let previous: number | null = null;
  let previousTime: number | null = null;
  let observations = 0;

  if (!first.source_id.startsWith(cumulativeSourcePrefix)) return { ...base, value: null };

  for (const sample of sorted) {
    if (sample.source_id !== first.source_id) return { ...base, value: null };
    const time = Date.parse(sample.observed_at);
    if (Number.isNaN(time)) return { ...base, value: null };
    if (previousTime !== null && time - previousTime > maxGapMs) {
      return { ...base, value: null };
    }
    if (isFiniteNumber(sample.precipitation_total)) {
      if (previous !== null) {
        const delta = sample.precipitation_total - previous;
        total += delta >= 0 ? delta : sample.precipitation_total;
      }
      previous = sample.precipitation_total;
      observations += 1;
    }
    previousTime = time;
  }

  if (observations < 2) return { ...base, value: null };
  return { ...base, value: round(total, 2) };
}

/** Group raw samples by station, preserving their observation order. */
export function groupPrecipitationSamples(
  samples: PrecipitationSample[],
): Map<string, PrecipitationSample[]> {
  const map = new Map<string, PrecipitationSample[]>();
  for (const sample of samples) {
    const group = map.get(sample.station_id) ?? [];
    group.push(sample);
    map.set(sample.station_id, group);
  }
  return map;
}

/** Localized metric value formatting shared by the period dashboard. */
export function formatNumber(value: number, decimals: number, locale: string): string {
  return value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatMetricValue(value: number | null, metric: MetricDefinition, locale: string): string {
  if (!isFiniteNumber(value)) return "–";
  const formatted = formatNumber(value, metric.decimals, locale);
  return metric.unit ? `${formatted} ${metric.unit}` : formatted;
}

/** Magnitude of a peer difference, using % only when a ratio is valid. */
export function formatDifferenceMagnitude(
  difference: PeerDifference,
  metric: MetricDefinition,
  locale: string,
): string {
  if (difference.percentage !== null) {
    return `${Math.abs(difference.percentage).toLocaleString(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    })}%`;
  }
  const formatted = formatNumber(Math.abs(difference.absolute), metric.decimals, locale);
  return metric.unit ? `${formatted} ${metric.unit}` : formatted;
}
