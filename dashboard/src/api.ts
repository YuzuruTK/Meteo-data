import type { AggregateResponse, CurrentSummary, PrecipitationResponse, Station } from "./types";

const API_BASE = "/api";

export async function fetchStations(hours?: number): Promise<Station[]> {
  const params = hours ? `?hours=${hours}` : "";
  const res = await fetch(`${API_BASE}/stations${params}`);
  if (!res.ok) throw new Error(`Failed to load stations: ${res.status}`);
  const data = (await res.json()) as { stations: Station[] };
  return data.stations ?? [];
}

export async function fetchCurrentSummaries(): Promise<CurrentSummary[]> {
  const res = await fetch(`${API_BASE}/summary`);
  if (!res.ok) throw new Error(`Failed to load current readings: ${res.status}`);
  const data = (await res.json()) as { summaries: CurrentSummary[] };
  return data.summaries ?? [];
}

export async function fetchAggregates(opts: {
  hours?: number;
  station?: string;
  stations?: string[];
  signal?: AbortSignal;
}): Promise<AggregateResponse> {
  const params = new URLSearchParams();
  if (opts.hours) params.set("hours", String(opts.hours));
  if (opts.stations) {
    for (const station of opts.stations) params.append("station", station);
  } else if (opts.station) {
    params.set("station", opts.station);
  }
  const query = params.toString();
  const res = await fetch(`${API_BASE}/observations/aggregate${query ? `?${query}` : ""}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Failed to load aggregates: ${res.status}`);
  return (await res.json()) as AggregateResponse;
}

/**
 * Fetch cumulative precipitation samples for the selected rolling window.
 * The dashboard derives per-station accumulation with the shared statistics
 * helpers so rainfall follows the same selection and period as every metric.
 */
export async function fetchPrecipitationSamples(opts: {
  hours?: number;
  station?: string;
  stations?: string[];
  signal?: AbortSignal;
}): Promise<PrecipitationResponse> {
  const params = new URLSearchParams();
  if (opts.hours) params.set("hours", String(opts.hours));
  if (opts.stations) {
    for (const station of opts.stations) params.append("station", station);
  } else if (opts.station) {
    params.set("station", opts.station);
  }
  const query = params.toString();
  const res = await fetch(`${API_BASE}/observations/precipitation${query ? `?${query}` : ""}`, {
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Failed to load precipitation: ${res.status}`);
  return (await res.json()) as PrecipitationResponse;
}
