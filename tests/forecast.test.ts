import { describe, it, expect } from "vitest";
import {
  FORECAST_LATITUDE,
  FORECAST_LONGITUDE,
  mapOpenMeteoResponse,
} from "../src/forecast/open-meteo";
import type { OpenMeteoResponse } from "../src/forecast/types";

function sampleResponse(): OpenMeteoResponse {
  return {
    latitude: FORECAST_LATITUDE,
    longitude: FORECAST_LONGITUDE,
    generationtime_ms: 1,
    utc_offset_seconds: 0,
    timezone: "UTC",
    timezone_abbreviation: "UTC",
    hourly_units: {
      time: "iso8601",
      temperature_2m: "°C",
      relative_humidity_2m: "%",
      precipitation_probability: "%",
      precipitation: "mm",
      cloud_cover: "%",
      dew_point_2m: "°C",
      surface_pressure: "hPa",
      wind_speed_10m: "km/h",
      wind_direction_10m: "°",
    },
    hourly: {
      time: ["2026-08-21T12:00", "2026-08-21T13:00"],
      temperature_2m: [22.3, 23.1],
      relative_humidity_2m: [75, 70],
      precipitation_probability: [35, 40],
      precipitation: [0.1, 0.0],
      cloud_cover: [65, 60],
      dew_point_2m: [17.5, 17.0],
      surface_pressure: [1013.2, 1012.8],
      wind_speed_10m: [10.5, 11.0],
      wind_direction_10m: [180, 185],
    },
  };
}

describe("forecast: mapOpenMeteoResponse", () => {
  it("maps hourly Open-Meteo fields into the API forecast shape", () => {
    const result = mapOpenMeteoResponse(sampleResponse());

    expect(result.generatedAt).toBeTruthy();
    expect(result.hourly).toHaveLength(2);

    const first = result.hourly[0]!;
    expect(first.time).toBe("2026-08-21T12:00");
    expect(first.temperature).toBe(22.3);
    expect(first.humidity).toBe(75);
    expect(first.precipitationProbability).toBe(35);
    expect(first.precipitation).toBe(0.1);
    expect(first.cloudCover).toBe(65);
    expect(first.dewPoint).toBe(17.5);
    expect(first.surfacePressure).toBe(1013.2);
    expect(first.windSpeed).toBe(10.5);
    expect(first.windDirection).toBe(180);
  });

  it("omits optional fields when the Open-Meteo response lacks them", () => {
    const raw = sampleResponse();
    delete raw.hourly.dew_point_2m;
    delete raw.hourly.surface_pressure;
    delete raw.hourly.wind_speed_10m;
    delete raw.hourly.wind_direction_10m;

    const result = mapOpenMeteoResponse(raw);
    const first = result.hourly[0]!;

    expect(first.dewPoint).toBeUndefined();
    expect(first.surfacePressure).toBeUndefined();
    expect(first.windSpeed).toBeUndefined();
    expect(first.windDirection).toBeUndefined();
  });
});