import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { fetchAggregates, fetchStations } from "./api";
import type { AggregateResponse, Station } from "./types";

const HOUR_OPTIONS = [6, 12, 24, 48, 72, 168];

const VARIABLES: { key: keyof AggregateResponse["rows"][number] & string; label: string; unit: string }[] = [
  { key: "temperature_avg", label: "Temperature", unit: "°C" },
  { key: "humidity_avg", label: "Humidity", unit: "%" },
  { key: "pressure_avg", label: "Pressure", unit: "hPa" },
  { key: "wind_speed_avg", label: "Wind speed", unit: "km/h" },
  { key: "wind_gust_avg", label: "Wind gust", unit: "km/h" },
  { key: "wind_direction_avg", label: "Wind direction", unit: "°" },
  { key: "solar_radiation_avg", label: "Solar radiation", unit: "W/m²" },
  { key: "uv_index_avg", label: "UV index", unit: "" },
  { key: "precipitation_rate_avg", label: "Precip. rate", unit: "mm/h" },
  { key: "precipitation_total_avg", label: "Precip. total", unit: "mm" },
  { key: "cloud_cover_avg", label: "Cloud cover", unit: "%" },
  { key: "visibility_avg", label: "Visibility", unit: "km" },
];

const COLORS = [
  "#8884d8", "#82ca9d", "#ffc658", "#ff7300", "#00C49F", "#FF8042",
  "#a4de6c", "#d0ed57", "#808888", "#6b6b6b", "#413ea0", "#ff6b6b",
];

function formatHour(hour: string): string {
  const d = new Date(hour + ":00Z");
  if (Number.isNaN(d.getTime())) return hour;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function App() {
  const [stations, setStations] = useState<Station[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [hours, setHours] = useState<number>(24);
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchStations(24)
      .then(setStations)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    setError(null);
    fetchAggregates({ hours, station: selected || undefined })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [hours, selected]);

  const stationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stations) map.set(s.id, s.name);
    return map;
  }, [stations]);

  const dataByStation = useMemo(() => {
    const map = new Map<string, Map<string, AggregateResponse["rows"][number]>>();
    for (const row of data?.rows ?? []) {
      let byHour = map.get(row.station_id);
      if (!byHour) {
        byHour = new Map();
        map.set(row.station_id, byHour);
      }
      byHour.set(row.hour, row);
    }
    return map;
  }, [data]);

  const sortedHours = useMemo(() => {
    const hoursSet = new Set((data?.rows ?? []).map((r) => r.hour));
    return Array.from(hoursSet).sort();
  }, [data]);

  const visibleStationIds = useMemo(() => {
    const ids = new Set((data?.rows ?? []).map((r) => r.station_id));
    if (selected) {
      return ids.has(selected) ? [selected] : [];
    }
    return Array.from(ids);
  }, [data, selected]);

  return (
    <div className="app">
      <header className="header">
        <h1>Meteo Data Dashboard</h1>
        <div className="controls">
          <label>
            Station
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">All stations</option>
              {stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
              ))}
            </select>
          </label>
          <label>
            Range
            <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {HOUR_OPTIONS.map((h) => (
                <option key={h} value={h}>{h} hours</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="loading">Loading…</div>}

      {data && (
        <main>
          {VARIABLES.map((v) => (
            <section key={v.key} className="chart-card">
              <h2>{v.label} ({v.unit})</h2>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sortedHours.map((hour) => {
                    const point: Record<string, unknown> = { hour: formatHour(hour) };
                    for (const sid of visibleStationIds) {
                      point[sid] = dataByStation.get(sid)?.get(hour)?.[v.key] ?? null;
                    }
                    return point;
                  })}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="hour" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} width={45} />
                    <Tooltip />
                    <Legend />
                    {visibleStationIds.map((sid, i) => (
                      <Line
                        key={sid}
                        type="monotone"
                        dataKey={sid}
                        name={stationNames.get(sid) ?? sid}
                        stroke={COLORS[i % COLORS.length]}
                        dot={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </section>
          ))}

          <section className="chart-card">
            <h2>Latest hourly averages</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Station</th>
                    <th>Hour</th>
                    {VARIABLES.map((v) => <th key={v.key}>{v.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.slice().sort((a, b) => b.hour.localeCompare(a.hour)).slice(0, visibleStationIds.length * 2).map((row, i) => (
                    <tr key={i}>
                      <td>{stationNames.get(row.station_id) ?? row.station_id}</td>
                      <td>{formatHour(row.hour)}</td>
                      {VARIABLES.map((v) => (
                        <td key={v.key}>{row[v.key] !== null ? Number(row[v.key]).toFixed(1) : "–"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      )}
    </div>
  );
}