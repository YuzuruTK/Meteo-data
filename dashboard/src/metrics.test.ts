import { describe, expect, it } from "vitest";
import {
  METRIC_DEFINITIONS,
  buildPeriodStatistics,
  compareToPeerAverage,
  deriveAccumulatedPrecipitation,
  formatDifferenceMagnitude,
  formatMetricValue,
  periodMetricValue,
} from "./metrics";
import type { AggregateRow, PrecipitationSample } from "./types";

function makeRow(overrides: Partial<AggregateRow> & Pick<AggregateRow, "station_id" | "hour">): AggregateRow {
  return {
    station_name: overrides.station_id,
    observation_count: 1,
    temperature_avg: null,
    temperature_min: null,
    temperature_max: null,
    solar_radiation_avg: null,
    solar_radiation_min: null,
    solar_radiation_max: null,
    humidity_avg: null,
    humidity_min: null,
    humidity_max: null,
    pressure_avg: null,
    wind_speed_avg: null,
    wind_direction_avg: null,
    wind_gust_avg: null,
    precipitation_rate_avg: null,
    precipitation_total_avg: null,
    uv_index_avg: null,
    uv_index_max: null,
    cloud_cover_avg: null,
    visibility_avg: null,
    ...overrides,
  };
}

function sample(
  stationId: string,
  observedAt: string,
  total: number | null,
  sourceId = "weather-com-pws",
): PrecipitationSample {
  return {
    station_id: stationId,
    source_id: sourceId,
    observed_at: observedAt,
    precipitation_total: total,
  };
}

describe("period statistics", () => {
  it("weights hourly averages by observation count and preserves period extremes", () => {
    const rows = [
      makeRow({
        station_id: "a",
        hour: "2026-01-01 10:00",
        observation_count: 2,
        temperature_avg: 20,
        temperature_min: 18,
        temperature_max: 22,
        solar_radiation_avg: 100,
        solar_radiation_min: 90,
        solar_radiation_max: 120,
      }),
      makeRow({
        station_id: "a",
        hour: "2026-01-01 11:00",
        observation_count: 1,
        temperature_avg: 24,
        temperature_min: 23,
        temperature_max: 25,
        solar_radiation_avg: 200,
        solar_radiation_min: 180,
        solar_radiation_max: 210,
      }),
    ];

    const stats = buildPeriodStatistics(rows, 2);
    const temperature = periodMetricValue(stats, "a", "temperature");
    const solar = periodMetricValue(stats, "a", "solarRadiation");

    expect(temperature?.value).toBeCloseTo((20 * 2 + 24) / 3, 3);
    expect(temperature?.min).toBe(18);
    expect(temperature?.max).toBe(25);
    expect(temperature?.sufficient).toBe(true);
    expect(solar?.value).toBeCloseTo((100 * 2 + 200) / 3, 3);
    expect(solar?.min).toBe(90);
    expect(solar?.max).toBe(210);
    expect(periodMetricValue(stats, "a", "humidity")).toBeNull();
  });

  it("marks a station with less than half of the expected hourly coverage as limited", () => {
    const stats = buildPeriodStatistics(
      [makeRow({ station_id: "a", hour: "2026-01-01 10:00", temperature_avg: 20 })],
      4,
    );
    expect(periodMetricValue(stats, "a", "temperature")?.sufficient).toBe(false);
  });

  it("ignores null measurements instead of treating them as zero", () => {
    const stats = buildPeriodStatistics(
      [
        makeRow({ station_id: "a", hour: "2026-01-01 10:00", temperature_avg: 21 }),
        makeRow({ station_id: "a", hour: "2026-01-01 11:00", temperature_avg: null }),
      ],
      2,
    );
    expect(periodMetricValue(stats, "a", "temperature")?.value).toBe(21);
  });
});

describe("accumulated precipitation", () => {
  it("sums positive changes in cumulative readings", () => {
    const result = deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", 10),
      sample("a", "2026-01-01T10:05:00.000Z", 10),
      sample("a", "2026-01-01T10:10:00.000Z", 11.2),
      sample("a", "2026-01-01T10:15:00.000Z", 11.2),
      sample("a", "2026-01-01T10:20:00.000Z", 11.6),
    ]);
    expect(result.value).toBe(1.6);
  });

  it("handles a gauge reset without producing negative rainfall", () => {
    const result = deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", 10),
      sample("a", "2026-01-01T10:05:00.000Z", 11.5),
      sample("a", "2026-01-01T10:10:00.000Z", 0.4),
      sample("a", "2026-01-01T10:15:00.000Z", 0.9),
    ]);
    expect(result.value).toBe(2.4);
  });

  it("marks the accumulation unavailable when observations have a long gap", () => {
    const result = deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", 10),
      sample("a", "2026-01-01T11:00:00.000Z", 12),
    ]);
    expect(result.value).toBeNull();
  });

  it("requires at least two usable cumulative readings", () => {
    expect(deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", 10),
    ]).value).toBeNull();
    expect(deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", null),
      sample("a", "2026-01-01T10:05:00.000Z", null),
    ]).value).toBeNull();
  });

  it("does not interpret a per-interval source as a cumulative gauge", () => {
    const result = deriveAccumulatedPrecipitation([
      sample("a", "2026-01-01T10:00:00.000Z", 0.2, "open-meteo-current"),
      sample("a", "2026-01-01T10:05:00.000Z", 0.4, "open-meteo-current"),
    ]);
    expect(result.value).toBeNull();
  });
});

describe("measurement formatting", () => {
  it("formats a Celsius difference in °C, never as a percentage", () => {
    expect(formatMetricValue(2.4, METRIC_DEFINITIONS.temperature, "en-US")).toBe("2.4 °C");
  });

  it("uses the expected metric units", () => {
    expect(formatMetricValue(520, METRIC_DEFINITIONS.solarRadiation, "en-US")).toBe("520 W/m²");
    expect(formatMetricValue(8, METRIC_DEFINITIONS.precipitation, "en-US")).toBe("8.0 mm");
  });
});

describe("peer comparisons", () => {
  const values = [
    { stationId: "floresta", value: 22 },
    { stationId: "ijui", value: 20.5 },
    { stationId: "itai", value: 21 },
    { stationId: "mundstock", value: 20 },
  ];

  it("compares each station against the average of all OTHER selected stations", () => {
    const result = compareToPeerAverage({
      stationId: "floresta",
      value: 22,
      values,
      kind: "temperature",
    });

    expect(result.reason).toBe("available");
    expect(result.referenceValue).toBeCloseTo((20.5 + 21 + 20) / 3, 6);
    expect(result.peerCount).toBe(3);
    expect(result.difference?.absolute).toBeCloseTo(1.5, 6);
    expect(result.difference?.percentage).toBeNull();
    expect(result.difference?.semantic).toBe("warmer");
    expect(formatDifferenceMagnitude(result.difference!, METRIC_DEFINITIONS.temperature, "en-US")).toBe("1.5 °C");
  });

  it("compares two stations directly without requiring a third station", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 22,
      values: [
        { stationId: "a", value: 22 },
        { stationId: "b", value: 20 },
      ],
      kind: "temperature",
    });

    expect(result.referenceValue).toBe(20);
    expect(result.peerCount).toBe(1);
    expect(result.difference?.absolute).toBe(2);
    expect(result.difference?.semantic).toBe("warmer");
  });

  it("does not produce a comparison for a single station", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 22,
      values: [{ stationId: "a", value: 22 }],
      kind: "temperature",
    });

    expect(result.reason).toBe("single_station");
    expect(result.difference).toBeNull();
  });

  it("uses percentage differences for solar radiation", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 520,
      values: [
        { stationId: "a", value: 520 },
        { stationId: "b", value: 450 },
        { stationId: "c", value: 490 },
        { stationId: "d", value: 410 },
      ],
      kind: "solar",
    });

    expect(result.referenceValue).toBeCloseTo(450, 6);
    expect(result.difference?.percentage).toBeCloseTo((70 / 450) * 100, 6);
    expect(result.difference?.absolute).toBe(70);
    expect(formatDifferenceMagnitude(result.difference!, METRIC_DEFINITIONS.solarRadiation, "en-US")).toContain("%");
  });

  it("uses percentage points for humidity, never a percentage change", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 60,
      values: [
        { stationId: "a", value: 60 },
        { stationId: "b", value: 52 },
      ],
      kind: "humidity",
    });

    expect(result.difference?.absolute).toBe(8);
    expect(result.difference?.percentage).toBeNull();
    expect(result.difference?.semantic).toBe("above");
  });

  it("falls back to an absolute difference when a zero baseline prevents division", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 50,
      values: [
        { stationId: "a", value: 50 },
        { stationId: "b", value: 0 },
      ],
      kind: "solar",
    });

    expect(result.referenceValue).toBe(0);
    expect(result.difference?.percentage).toBeNull();
    expect(result.difference?.absolute).toBe(50);
  });

  it("excludes missing and insufficient peers from the baseline", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 22,
      values: [
        { stationId: "a", value: 22 },
        { stationId: "b", value: 20 },
        { stationId: "c", value: null },
        { stationId: "d", value: 99, sufficient: false },
      ],
      kind: "temperature",
    });

    expect(result.referenceValue).toBe(20);
    expect(result.difference?.absolute).toBe(2);
  });

  it("reports a station with insufficient coverage as not comparable", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      value: 22,
      values: [
        { stationId: "a", value: 22, sufficient: false },
        { stationId: "b", value: 20 },
      ],
      kind: "temperature",
      sufficient: false,
    });

    expect(result.reason).toBe("insufficient_data");
    expect(result.difference).toBeNull();
  });

  it("uses only selected stations from the same data source as peers", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      sourceId: "weather-com-pws",
      value: 22,
      values: [
        { stationId: "a", sourceId: "weather-com-pws", value: 22 },
        { stationId: "b", sourceId: "weather-com-pws", value: 20 },
        { stationId: "c", sourceId: "open-meteo-current", value: 40 },
      ],
      kind: "temperature",
    });

    expect(result.referenceValue).toBe(20);
    expect(result.peerCount).toBe(1);
    expect(result.difference?.absolute).toBe(2);
  });

  it("does not compare across different sources when no same-source peer exists", () => {
    const result = compareToPeerAverage({
      stationId: "a",
      sourceId: "weather-com-pws",
      value: 22,
      values: [
        { stationId: "a", sourceId: "weather-com-pws", value: 22 },
        { stationId: "c", sourceId: "open-meteo-current", value: 24 },
      ],
      kind: "temperature",
    });

    expect(result.reason).toBe("no_comparable_peer");
    expect(result.difference).toBeNull();
  });
});

