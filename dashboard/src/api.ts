import type { AggregateResponse, Station } from "./types";

const API_BASE = "/api";

export async function fetchStations(hours?: number): Promise<Station[]> {
  const params = hours ? `?hours=${hours}` : "";
  const res = await fetch(`${API_BASE}/stations${params}`);
  if (!res.ok) {
    throw new Error(`Failed to load stations: ${res.status}`);
  }
  const data = (await res.json()) as { stations: Station[] };
  return data.stations ?? [];
}

export async function fetchAggregates(opts: {
  hours?: number;
  station?: string;
}): Promise<AggregateResponse> {
  const params = new URLSearchParams();
  if (opts.hours) params.set("hours", String(opts.hours));
  if (opts.station) params.set("station", opts.station);
  const query = params.toString();
  const res = await fetch(`${API_BASE}/observations/aggregate${query ? `?${query}` : ""}`);
  if (!res.ok) {
    throw new Error(`Failed to load aggregates: ${res.status}`);
  }
  return (await res.json()) as AggregateResponse;
}