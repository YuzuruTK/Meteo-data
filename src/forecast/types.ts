/**
 * Forecast types for Open-Meteo integration.
 *
 * These types represent hourly forecast data fetched from the Open-Meteo API
 * and served through the /api/forecast endpoint.
 *
 * Future work:
 *  - Forecast persistence (D1 storage)
 *  - Forecast-vs-observation verification
 *  - Forecast accuracy metrics
 *  - Ensemble / multi-model forecasts
 */

/** A single hourly forecast data point returned by /api/forecast. */
export interface ForecastHourly {
  time: string;
  temperature: number;
  humidity: number;
  precipitationProbability: number;
  precipitation: number;
  cloudCover: number;
  /** Optional extra variables for future verification / alerts / ML. */
  dewPoint?: number;
  surfacePressure?: number;
  windSpeed?: number;
  windDirection?: number;
}

/** Top-level response from /api/forecast. */
export interface ForecastResponse {
  generatedAt: string;
  hourly: ForecastHourly[];
}

/**
 * Raw Open-Meteo API response shape (subset of fields we care about).
 * @see https://open-meteo.com/en/docs
 */
export interface OpenMeteoResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  hourly_units: {
    time: string;
    temperature_2m: string;
    relative_humidity_2m: string;
    precipitation_probability: string;
    precipitation: string;
    cloud_cover: string;
    dew_point_2m?: string;
    surface_pressure?: string;
    wind_speed_10m?: string;
    wind_direction_10m?: string;
  };
  hourly: {
    time: string[];
    temperature_2m: number[];
    relative_humidity_2m: number[];
    precipitation_probability: number[];
    precipitation: number[];
    cloud_cover: number[];
    dew_point_2m?: number[];
    surface_pressure?: number[];
    wind_speed_10m?: number[];
    wind_direction_10m?: number[];
  };
}