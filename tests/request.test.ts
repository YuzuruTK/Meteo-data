import { describe, expect, it } from "vitest";
import { buildRequest, RequestBuilderError } from "../src/collector/request";
import type { RequestConfig, WeatherLocationConfig } from "../src/collector/types";

describe("request construction", () => {
  const requestConfig: RequestConfig = {
    method: "GET",
    url: "https://api.weather.com/v2/pws/observations/current",
    params: {
      apikey: "${WEATHER_COM_API_KEY}",
      units: "m",
      format: "json",
    },
    location_param: "stationId",
  };

  const location: WeatherLocationConfig = {
    id: "ijui-iiJu2",
    name: "Ijuí",
    stationId: "IIJU2",
  };

  it("injects the location-specific stationId parameter", () => {
    const req = buildRequest(requestConfig, location, {
      WEATHER_COM_API_KEY: "secret-key",
    });
    expect(req.url).toContain("stationId=IIJU2");
  });

  it("includes all configured params", () => {
    const req = buildRequest(requestConfig, location, {
      WEATHER_COM_API_KEY: "secret-key",
    });
    expect(req.url).toContain("units=m");
    expect(req.url).toContain("format=json");
    expect(req.url).toContain("apikey=secret-key");
  });

  it("does not leak the secret placeholder into the URL", () => {
    const req = buildRequest(requestConfig, location, {
      WEATHER_COM_API_KEY: "secret-key",
    });
    expect(req.url).not.toContain("${WEATHER_COM_API_KEY}");
    expect(req.url).not.toContain("${");
  });

  it("throws when a referenced secret is missing", () => {
    expect(() => buildRequest(requestConfig, location, {})).toThrow(RequestBuilderError);
  });

  it("throws when the location is missing the location_param", () => {
    const missingStation = { ...location, stationId: undefined };
    expect(() =>
      buildRequest(requestConfig, missingStation, { WEATHER_COM_API_KEY: "k" }),
    ).toThrow(RequestBuilderError);
  });

  it("throws when a location_param is configured but not present", () => {
    const noParamConfig: RequestConfig = {
      method: "GET",
      url: "https://example.com/weather",
      location_param: "stationCode",
    };
    expect(() =>
      buildRequest(noParamConfig, location, { WEATHER_COM_API_KEY: "k" }),
    ).toThrow(RequestBuilderError);
  });

  it("interpolates headers", () => {
    const withHeaders: RequestConfig = {
      method: "GET",
      url: "https://example.com/weather",
      headers: { Authorization: "Bearer ${API_TOKEN}" },
    };
    const req = buildRequest(withHeaders, location, { API_TOKEN: "abc123" });
    expect(req.headers.Authorization).toBe("Bearer abc123");
  });
});