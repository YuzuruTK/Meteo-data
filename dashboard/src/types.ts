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