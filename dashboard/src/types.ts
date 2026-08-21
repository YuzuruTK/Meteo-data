export interface Station {
  id: string;
  source_id: string;
  name: string;
}

export interface AggregateRow {
  station_id: string;
  station_name: string;
  hour: string;
  temperature_avg: number | null;
  solar_radiation_avg: number | null;
  humidity_avg: number | null;
  pressure_avg: number | null;
  wind_speed_avg: number | null;
  wind_direction_avg: number | null;
  wind_gust_avg: number | null;
  precipitation_rate_avg: number | null;
  precipitation_total_avg: number | null;
  uv_index_avg: number | null;
  cloud_cover_avg: number | null;
  visibility_avg: number | null;
}

export interface AggregateResponse {
  columns: string[];
  rows: AggregateRow[];
  filters: { hours: number; station: string | null };
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
