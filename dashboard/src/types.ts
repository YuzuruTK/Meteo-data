export interface Station {
  id: string;
  source_id: string;
  name: string;
}

/** Latest collected observation for a station, returned by /api/summary. */
export interface CurrentSummary {
  location_id: string;
  station_name: string;
  observed_at: string;
  temperature: number | null;
  solar_radiation: number | null;
  humidity: number | null;
  pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_gust: number | null;
  precipitation_rate: number | null;
  precipitation_total: number | null;
  uv_index: number | null;
  cloud_cover: number | null;
  visibility: number | null;
  updated_at: string;
}

export interface AggregateRow {
  station_id: string;
  station_name: string;
  hour: string;
  observation_count: number;
  temperature_avg: number | null;
  temperature_min: number | null;
  temperature_max: number | null;
  solar_radiation_avg: number | null;
  solar_radiation_min: number | null;
  solar_radiation_max: number | null;
  humidity_avg: number | null;
  humidity_min: number | null;
  humidity_max: number | null;
  pressure_avg: number | null;
  wind_speed_avg: number | null;
  wind_direction_avg: number | null;
  wind_gust_avg: number | null;
  precipitation_rate_avg: number | null;
  precipitation_total_avg: number | null;
  uv_index_avg: number | null;
  uv_index_max: number | null;
  cloud_cover_avg: number | null;
  visibility_avg: number | null;
}

export interface AggregateResponse {
  columns: string[];
  rows: AggregateRow[];
  filters: { hours: number; station: string | null; stations: string[] | null };
}

/** One raw cumulative precipitation reading used to derive a period total. */
export interface PrecipitationSample {
  station_id: string;
  source_id: string;
  observed_at: string;
  precipitation_total: number | null;
}

export interface PrecipitationResponse {
  samples: PrecipitationSample[];
  filters: { hours: number; station: string | null; stations: string[] | null };
}

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
