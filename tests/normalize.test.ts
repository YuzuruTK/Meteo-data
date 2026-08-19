import { describe, expect, it } from "vitest";
import { normalizeObservation, NormalizationError } from "../src/collector/normalize";
import type { NormalizationConfig } from "../src/collector/types";
import weatherComResponse from "./fixtures/weather-com-response.json";

const weatherComNormalization: NormalizationConfig = {
  observation_selector: "$.observations[0]",
  fields: {
    observed_at: { path: "$.obsTimeUtc" },
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

  it("converts F to C during normalization (68F -> 20C)", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt" },
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
        observed_at: { path: "$.obsAt" },
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

  it("returns null for missing optional fields", () => {
    const config: NormalizationConfig = {
      observation_selector: "$",
      fields: {
        observed_at: { path: "$.obsAt" },
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
        observed_at: { path: "$.obsAt" },
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
        observed_at: { path: "$.obsAt" },
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
        observed_at: { path: "$.obsAt" },
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
      fields: { temperature: { path: "$.temp", unit: "C" } },
    };
    expect(() =>
      normalizeObservation({ temp: 20 }, config, { sourceId: "s", locationId: "l" }),
    ).toThrow(NormalizationError);
  });
});