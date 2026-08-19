import { describe, expect, it } from "vitest";
import { validateConfig, ConfigValidationError } from "../src/collector/validate";
import type { WeatherSourceConfig, WeatherSourcesConfig } from "../src/collector/types";

const baseSource: WeatherSourceConfig = {
  id: "weather-com-pws",
  enabled: true,
  request: {
    method: "GET",
    url: "https://api.weather.com/v2/pws/observations/current",
    params: { apikey: "${WEATHER_COM_API_KEY}", units: "m", format: "json" },
    location_param: "stationId",
  },
  locations: [
    { id: "loc-1", name: "Ijuí", stationId: "IIJU2" },
    { id: "loc-2", name: "Test", stationId: "XXXXX" },
  ],
  normalization: {
    observation_selector: "$.observations[0]",
    fields: {
      observed_at: { path: "$.obsTimeUtc" },
      temperature: { path: "$.metric.temp", unit: "C" },
      solar_radiation: { path: "$.solarRadiation", unit: "W/m2" },
    },
  },
};

describe("configuration validation", () => {
  it("accepts a valid configuration", () => {
    expect(() => validateConfig([baseSource])).not.toThrow();
  });

  it("rejects duplicate source ids", () => {
    const config: WeatherSourcesConfig = [baseSource, { ...baseSource, id: "weather-com-pws" }];
    expect(() => validateConfig(config)).toThrow(ConfigValidationError);
  });

  it("rejects missing url", () => {
    const bad = {
      ...baseSource,
      request: { ...baseSource.request, url: "" },
    };
    expect(() => validateConfig([bad])).toThrow(ConfigValidationError);
  });

  it("rejects invalid HTTP method", () => {
    const bad = {
      ...baseSource,
      request: { ...baseSource.request, method: "TRACE" },
    };
    expect(() => validateConfig([bad as unknown as WeatherSourceConfig])).toThrow(
      ConfigValidationError,
    );
  });

  it("rejects missing locations", () => {
    const bad = { ...baseSource, locations: [] };
    expect(() => validateConfig([bad])).toThrow(ConfigValidationError);
  });

  it("rejects duplicate location ids", () => {
    const bad = {
      ...baseSource,
      locations: [
        { id: "dup", name: "A", stationId: "IIJU2" },
        { id: "dup", name: "B", stationId: "XXXXX" },
      ],
    };
    expect(() => validateConfig([bad])).toThrow(ConfigValidationError);
  });

  it("rejects invalid normalization path", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, temperature: { path: "not-a-path" } },
      },
    };
    expect(() => validateConfig([bad])).toThrow(ConfigValidationError);
  });

  it("rejects unknown normalization field", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, bogus_field: { path: "$.x" } },
      },
    };
    expect(() => validateConfig([bad as unknown as WeatherSourceConfig])).toThrow(
      ConfigValidationError,
    );
  });

  it("rejects invalid unit", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: {
          ...baseSource.normalization.fields,
          temperature: { path: "$.metric.temp", unit: "warp" },
        },
      },
    };
    expect(() => validateConfig([bad])).toThrow(ConfigValidationError);
  });

  it("accepts a disabled source", () => {
    const disabled = { ...baseSource, enabled: false };
    expect(() => validateConfig([disabled])).not.toThrow();
  });
});