import { describe, expect, it } from "vitest";
import { normalizeObservation, NormalizationError } from "../src/collector/normalize";
import type { NormalizationConfig } from "../src/collector/types";
import weatherComResponse from "./fixtures/weather-com-response.json";

const weatherComNormalization: NormalizationConfig = {
  observation_selector: "$.observations[0]",
  fields: {
    observed_at: { path: "$.obsTimeUtc", format: "iso8601" },
    temperature: { path: "$.metric.temp", unit: "C" },
    solar_radiation: { path: "$.solarRadiation", unit: "W/m2" },
    humidity: { path: "$.humidity", unit: "%" },
    uv_index: { path: "$.uv" },
    wind_speed: { path: "$.metric.windSpeed", unit: "km/h" },
    wind_direction: { path: "$.winddir", unit: "degrees" },
    wind_gust: { path: "$.metric.windGust", unit: "km/h" },
    pressure: { path: "$.metric.pressure", unit: "hPa" },
    precipitation_rate: { path: "$.metric.precipRate", unit: "mm/h" },
    precipitation_total: { path: "$.metric.precipTotal", unit: "mm" },
  },
};

describe("normalization", () => {
  it("normalizes the Weather.com sample response into the canonical model", () => {
    const obs = normalizeObservation(weatherComResponse, weatherComNormalization, {
      sourceId: "weather-com-pws",
      locationId: "ijui-iiJu2",
    });

    expect(obs.source_id).toBe("weather-com-pws");
    expect(obs.location_id).toBe("ijui-iiJu2");
    expect(obs.observed_at).toBe("2026-08-19T00:02:05.000Z");
    expect(obs.temperature).toBeCloseTo(18, 5);
    expect(obs.solar_radiation).toBeCloseTo(0, 5);
    expect(obs.humidity).toBeCloseTo(99, 5);
    expect(obs.uv_index).toBeCloseTo(0, 5);
    expect(obs.wind_direction).toBeCloseTo(152, 5);
    expect(obs.wind_speed).toBeCloseTo(0, 5);
    expect(obs.wind_gust).toBeCloseTo(0, 5);
    expect(obs.pressure).toBeCloseTo(1009.82, 5);
    expect(obs.precipitation_rate).toBeCloseTo(0, 5);
    expect(obs.precipitation_total).toBeCloseTo(0, 5);
    expect(obs.collected_at).toBeTruthy();
  });

  it("normalizes ISO-8601 UTC and explicit offsets to UTC", () => {
    const utc = normalizeObservation(
      { at: "2026-08-19T00:02:05Z" },
      { observation_selector: "$", fields: { observed_at: { path: "$.at", format: "iso8601" } } },
      { sourceId: "s", locationId: "l" },
    );
    const offset = normalizeObservation(
      { at: "2026-08-19T03:02:05+03:00" },
      { observation_selector: "$", fields: { observed_at: { path: "$.at", format: "iso8601" } } },
      { sourceId: "s", locationId: "l" },
    );
    expect(utc.observed_at).toBe("2026-08-19T00:02:05.000Z");
    expect(offset.observed_at).toBe(utc.observed_at);
  });

  it("normalizes Unix timestamps in seconds and milliseconds", () => {
    const normalizeAt = (at: number, format: "unix_seconds" | "unix_milliseconds") =>
      normalizeObservation(
        { at },
        { observation_selector: "$", fields: { observed_at: { path: "$.at", format } } },
        { sourceId: "s", locationId: "l" },
      ).observed_at;
    expect(normalizeAt(1787097725, "unix_seconds")).toBe("2026-08-19T00:02:05.000Z");
    expect(normalizeAt(1787097725000, "unix_milliseconds")).toBe("2026-08-19T00:02:05.000Z");
  });

  it("interprets local ISO timestamps in the configured IANA timezone", () => {
    const obs = normalizeObservation(
      { at: "2026-08-18 21:02:05" },
      {
        observation_selector: "$",
        fields: { observed_at: { path: "$.at", format: "iso8601", timezone: "America/Sao_Paulo" } },
      },
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.observed_at).toBe("2026-08-19T00:02:05.000Z");
  });

  it("rejects local ISO timestamps without a timezone", () => {
    expect(() => normalizeObservation(
      { at: "2026-08-18 21:02:05" },
      { observation_selector: "$", fields: { observed_at: { path: "$.at", format: "iso8601" } } },
      { sourceId: "s", locationId: "l" },
    )).toThrow(/configure an IANA timezone/);
  });

  it("rejects nonexistent and ambiguous local times during timezone transitions", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: { observed_at: { path: "$.at", format: "iso8601", timezone: "America/New_York" } },
    };
    expect(() => normalizeObservation(
      { at: "2026-03-08T02:30:00" }, config, { sourceId: "s", locationId: "l" },
    )).toThrow(/does not exist/);
    expect(() => normalizeObservation(
      { at: "2026-11-01T01:30:00" }, config, { sourceId: "s", locationId: "l" },
    )).toThrow(/ambiguous/);
  });

  it("keeps observed_at mandatory even if required excludes it", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      required: [],
      fields: { observed_at: { path: "$.at", format: "iso8601" } },
    };
    expect(() => normalizeObservation(
      {}, config, { sourceId: "s", locationId: "l" },
    )).toThrow(NormalizationError);
  });

  it("converts F to C during normalization (68F -> 20C)", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "F" },
        solar_radiation: { path: "$.solar", unit: "W/m2" },
      },
    };
    const obs = normalizeObservation(
      { obsAt: "2026-08-19T00:00:00Z", temp: 68, solar: 0 },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.temperature).toBeCloseTo(20, 5);
  });

  it("converts kW/m2 to W/m2 during normalization (0.812 kW/m2 -> 812 W/m2)", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
        solar_radiation: { path: "$.solar", unit: "kW/m2" },
      },
    };
    const obs = normalizeObservation(
      { obsAt: "2026-08-19T00:00:00Z", temp: 20, solar: 0.812 },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.solar_radiation).toBeCloseTo(812, 5);
  });

  it("converts configured weather variables to canonical units during normalization", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.at", format: "iso8601" },
        pressure: { path: "$.pressure", unit: "Pa" },
        wind_speed: { path: "$.wind", unit: "m/s" },
        wind_gust: { path: "$.gust", unit: "mph" },
        wind_direction: { path: "$.direction", unit: "rad" },
        precipitation_rate: { path: "$.rate", unit: "in/hr" },
        precipitation_total: { path: "$.total", unit: "in" },
        cloud_cover: { path: "$.cloud", unit: "fraction" },
        visibility: { path: "$.visibility", unit: "km" },
        uv_index: { path: "$.uv", unit: "index" },
      },
    };
    const obs = normalizeObservation(
      {
        at: "2026-08-19T00:00:00Z",
        pressure: 101325,
        wind: 10,
        gust: 10,
        direction: Math.PI,
        rate: 1,
        total: 1,
        cloud: 0.5,
        visibility: 1,
        uv: 8,
      },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.pressure).toBeCloseTo(1013.25, 5);
    expect(obs.wind_speed).toBeCloseTo(36, 5);
    expect(obs.wind_gust).toBeCloseTo(16.09344, 5);
    expect(obs.wind_direction).toBeCloseTo(180, 5);
    expect(obs.precipitation_rate).toBeCloseTo(25.4, 5);
    expect(obs.precipitation_total).toBeCloseTo(25.4, 5);
    expect(obs.cloud_cover).toBeCloseTo(50, 5);
    expect(obs.visibility).toBeCloseTo(1000, 5);
    expect(obs.uv_index).toBe(8);
  });

  it("keeps null optional values null without attempting conversion", () => {
    const obs = normalizeObservation(
      { at: "2026-08-19T00:00:00Z", pressure: null },
      {
        observation_selector: "$",
        fields: {
          observed_at: { path: "$.at", format: "iso8601" },
          pressure: { path: "$.pressure", unit: "Pa" },
        },
      },
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.pressure).toBeNull();
  });

  it("returns null for missing optional fields", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
        solar_radiation: { path: "$.solar", unit: "W/m2" },
        humidity: { path: "$.humidity", unit: "%" },
      },
    };
    const obs = normalizeObservation(
      { obsAt: "2026-08-19T00:00:00Z", temp: 20, solar: 100 },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.humidity).toBeNull();
  });

  it("accepts null solar_radiation and keeps the other fields (station without solar sensor)", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
        solar_radiation: { path: "$.solar", unit: "W/m2" },
        humidity: { path: "$.humidity", unit: "%" },
        pressure: { path: "$.pressure", unit: "hPa" },
      },
    };
    const obs = normalizeObservation(
      { obsAt: "2026-08-19T00:00:00Z", temp: 22, solar: null, humidity: 60, pressure: 1010 },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.temperature).toBeCloseTo(22, 5);
    expect(obs.solar_radiation).toBeNull();
    expect(obs.humidity).toBeCloseTo(60, 5);
    expect(obs.pressure).toBeCloseTo(1010, 5);
  });

  it("accepts null temperature and stores it as NULL (only observed_at required)", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
        solar_radiation: { path: "$.solar", unit: "W/m2" },
        humidity: { path: "$.humidity", unit: "%" },
      },
    };
    const obs = normalizeObservation(
      { obsAt: "2026-08-19T00:00:00Z", temp: null, solar: 100, humidity: 61 },
      config,
      { sourceId: "s", locationId: "l" },
    );
    expect(obs.temperature).toBeNull();
    expect(obs.solar_radiation).toBeCloseTo(100, 5);
    expect(obs.humidity).toBeCloseTo(61, 5);
  });

  it("throws when the required observed_at field is missing", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
        solar_radiation: { path: "$.solar", unit: "W/m2" },
      },
    };
    expect(() =>
      normalizeObservation(
        { temp: 20, solar: 100 },
        config,
        { sourceId: "s", locationId: "l" },
      ),
    ).toThrow(NormalizationError);
  });

  it("throws when the observation selector does not match", () => {
    const config: NormalizationConfig = {
      observation_selector: "$.no-such",
      fields: {
        observed_at: { path: "$.obsAt", format: "iso8601" },
        temperature: { path: "$.temp", unit: "C" },
      },
    };
    expect(() =>
      normalizeObservation({ temp: 20 }, config, { sourceId: "s", locationId: "l" }),
    ).toThrow(NormalizationError);
  });
});