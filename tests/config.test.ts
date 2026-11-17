import { describe, expect, it } from "vitest";
import { validateConfig, ConfigValidationError } from "../src/collector/validate";
import type { WeatherSourceConfig, WeatherSourcesConfig } from "../src/collector/types";
import { loadConfig } from "../src/config/config";

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
      observed_at: { path: "$.obsTimeUtc", format: "iso8601" },
      temperature: { path: "$.metric.temp", unit: "C" },
      solar_radiation: { path: "$.solarRadiation", unit: "W/m2" },
    },
  },
};

describe("configuration validation", () => {
  it("keeps the current Weather.com source valid with explicit ISO-8601 time", () => {
    const [source] = loadConfig();
    expect(source?.normalization.fields.observed_at).toEqual({
      path: "$.obsTimeUtc",
      format: "iso8601",
    });
    expect(() => validateConfig(loadConfig())).not.toThrow();
  });

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

  it("rejects a unit incompatible with its canonical field", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: {
          ...baseSource.normalization.fields,
          temperature: { path: "$.metric.temp", unit: "km/h" },
        },
      },
    };
    expect(() => validateConfig([bad])).toThrow(/Unsupported unit 'km\/h' for field 'temperature'/);
  });

  it("rejects missing timestamp format", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, observed_at: { path: "$.obsTimeUtc" } },
      },
    };
    expect(() => validateConfig([bad as unknown as WeatherSourceConfig])).toThrow(/must declare format/);
  });

  it("rejects unknown timestamp format", () => {
    const bad = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, observed_at: { path: "$.obsTimeUtc", format: "local" } },
      },
    };
    expect(() => validateConfig([bad as unknown as WeatherSourceConfig])).toThrow(/must declare format/);
  });

  it("rejects invalid timezone and timezone on Unix timestamps", () => {
    const invalidTimezone = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, observed_at: { path: "$.obsTimeUtc", format: "iso8601", timezone: "Mars/Olympus" } },
      },
    };
    expect(() => validateConfig([invalidTimezone as unknown as WeatherSourceConfig])).toThrow(/invalid timezone/);

    const unixTimezone = {
      ...baseSource,
      normalization: {
        ...baseSource.normalization,
        fields: { ...baseSource.normalization.fields, observed_at: { path: "$.epoch", format: "unix_seconds", timezone: "UTC" } },
      },
    };
    expect(() => validateConfig([unixTimezone as unknown as WeatherSourceConfig])).toThrow(/only valid with format 'iso8601'/);
  });

  it("requires observed_at mapping regardless of required fields", () => {
    const bad = {
      ...baseSource,
      normalization: { observation_selector: "$", required: [], fields: { temperature: { path: "$.temp" } } },
    };
    expect(() => validateConfig([bad as unknown as WeatherSourceConfig])).toThrow(/observed_at is required/);
  });

  it("allows required to omit observed_at because the timestamp is always enforced", () => {
    const source = {
      ...baseSource,
      normalization: { ...baseSource.normalization, required: [] },
    };
    expect(() => validateConfig([source])).not.toThrow();
  });

  it("accepts a disabled source", () => {
    const disabled = { ...baseSource, enabled: false };
    expect(() => validateConfig([disabled])).not.toThrow();
  });
});