import { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { fetchAggregates, fetchStations } from "./api";
import { fetchForecast } from "./forecast";
import NotificationSettings from "./NotificationSettings";
import type { AggregateResponse, ForecastResponse, Station } from "./types";

const HOUR_OPTIONS = [6, 12, 24, 48, 72, 168];

interface VarDef { key: string; label: string; unit: string; }

const CHART_VARIABLES: VarDef[] = [
  { key: "temperature_avg", label: "Temperature", unit: "°C" },
  { key: "humidity_avg", label: "Humidity", unit: "%" },
  { key: "solar_radiation_avg", label: "Solar radiation", unit: "W/m²" },
  { key: "uv_index_avg", label: "UV index", unit: "" },
  { key: "precipitation_rate_avg", label: "Precip. rate", unit: "mm/h" },
  { key: "precipitation_total_avg", label: "Precip. total", unit: "mm" },
];

const SUMMARY_VARIABLES: VarDef[] = [
  ...CHART_VARIABLES,
  { key: "pressure_avg", label: "Pressure", unit: "hPa" },
  { key: "wind_speed_avg", label: "Wind speed", unit: "km/h" },
  { key: "wind_gust_avg", label: "Wind gust", unit: "km/h" },
  { key: "wind_direction_avg", label: "Wind direction", unit: "°" },
];

const OPTIONAL_CHART_VARIABLES: VarDef[] = [{ key: "pressure_avg", label: "Pressure", unit: "hPa" }];
const COLORS = ["#8884d8", "#82ca9d", "#ffc658", "#ff7300", "#00C49F", "#FF8042"];

function formatHour(hour: string): string {
  const d = new Date(hour + ":00Z");
  if (Number.isNaN(d.getTime())) return hour;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function forecastHourKey(time: string): string {
  const prefix = time.slice(0, 13);
  return `${prefix.slice(0, 10)} ${prefix.slice(11, 13)}:00`;
}

function forecastLineFor(variableKey: string): { label: string; color: string } | null {
  switch (variableKey) {
    case "temperature_avg": return { label: "Temperature Forecast", color: COLORS[3] };
    case "humidity_avg": return { label: "Humidity Forecast", color: COLORS[1] };
    case "cloud_cover_avg": return { label: "Cloud Cover Forecast", color: COLORS[4] };
    case "pressure_avg": return { label: "Pressure Forecast", color: COLORS[5] };
    case "wind_speed_avg": return { label: "Wind Speed Forecast", color: COLORS[2] };
    case "precipitation_rate_avg": return { label: "Precip. Rate Forecast", color: COLORS[0] };
    case "precipitation_total_avg": return { label: "Precipitation Forecast", color: COLORS[0] };
    default: return null;
  }
}

function bearingToLabel(deg: number | null): string {
  if (deg === null) return "–";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] ?? "–";
}

interface Category { label: string; color: string; }
function humidityCategory(v: number): Category {
  if (v < 30) return { label: "Dry", color: "#e0b94f" };
  if (v < 60) return { label: "Comfortable", color: "#82ca9d" };
  if (v < 80) return { label: "Humid", color: "#42a5f5" };
  return { label: "Very Humid", color: "#7e57c2" };
}
const UV_TIERS: { max: number; label: string; color: string }[] = [
  { max: 2, label: "Low", color: "#4caf50" }, { max: 5, label: "Moderate", color: "#ffb300" },
  { max: 7, label: "High", color: "#fb8c00" }, { max: 10, label: "Very High", color: "#e53935" },
  { max: Infinity, label: "Extreme", color: "#7e57c2" },
];
function uvInfo(v: number): { label: string; color: string; index: number } {
  let idx = 0;
  for (let i = 0; i < UV_TIERS.length; i++) if (v <= UV_TIERS[i]!.max) { idx = i; break; }
  const t = UV_TIERS[idx] ?? UV_TIERS[UV_TIERS.length - 1]!;
  return { label: t.label, color: t.color, index: idx };
}
function solarCategory(v: number): Category {
  if (v <= 100) return { label: "Very Low", color: "#90a4ae" };
  if (v <= 300) return { label: "Low", color: "#42a5f5" };
  if (v <= 600) return { label: "Moderate", color: "#ffb300" };
  if (v <= 900) return { label: "High", color: "#fb8c00" };
  return { label: "Very High", color: "#e53935" };
}
function precipCategory(v: number): Category {
  if (v <= 0) return { label: "Dry", color: "#82ca9d" };
  if (v < 2.5) return { label: "Drizzle", color: "#42a5f5" };
  if (v < 10) return { label: "Rain", color: "#1e88e5" };
  if (v < 50) return { label: "Heavy Rain", color: "#3949ab" };
  return { label: "Storm", color: "#7e57c2" };
}
function windSpeedCategory(v: number): Category {
  if (v <= 5) return { label: "Calm", color: "#82ca9d" };
  if (v <= 20) return { label: "Light", color: "#42a5f5" };
  if (v <= 40) return { label: "Moderate", color: "#ffb300" };
  if (v <= 60) return { label: "Strong", color: "#fb8c00" };
  return { label: "Very Strong", color: "#e53935" };
}
function tempColor(v: number): string {
  if (v <= 0) return "#2196f3";
  if (v < 15) return "#4caf50";
  if (v < 25) return "#ffb300";
  return "#e53935";
}
function SVGArc({ pct, color }: { pct: number; color: string }) {
  const r = 34, c = 2 * Math.PI * r, filled = Math.max(0, Math.min(100, pct));
  return <svg viewBox="0 0 96 96" className="ring"><circle cx="48" cy="48" r={r} fill="none" stroke="#e4e7eb" strokeWidth="10" /><circle cx="48" cy="48" r={r} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(filled / 100) * c} ${c}`} transform="rotate(-90 48 48)" /></svg>;
}

export default function App() {
  const [stations, setStations] = useState<Station[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [hours, setHours] = useState<number>(24);
  const [showPressure, setShowPressure] = useState<boolean>(false);
  const [data, setData] = useState<AggregateResponse | null>(null);
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aggregateInFlight = useRef(false);
  const forecastInFlight = useRef(false);

  useEffect(() => {
    fetchStations(24).then(setStations).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Fetch once per mount (first load / browser refresh) and whenever the
    // user changes a filter. No polling: an idle tab generates zero queries
    // (D1 read conservation, see docs/emergency-d1-mode.md).
    const refresh = async () => {
      if (cancelled || aggregateInFlight.current) return;
      aggregateInFlight.current = true;
      setError(null);
      try {
        const next = await fetchAggregates({ hours, station: selected || undefined });
        if (!cancelled) setData(next);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        aggregateInFlight.current = false;
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [hours, selected]);

  useEffect(() => {
    let cancelled = false;
    // Same policy as aggregates: fetch once per mount, no polling.
    const refresh = async () => {
      if (cancelled || forecastInFlight.current) return;
      forecastInFlight.current = true;
      try {
        const next = await fetchForecast();
        if (!cancelled && next) setForecast(next);
      } finally {
        forecastInFlight.current = false;
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  const stationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stations) map.set(s.id, s.name);
    return map;
  }, [stations]);
  const dataByStation = useMemo(() => {
    const map = new Map<string, Map<string, AggregateResponse["rows"][number]>>();
    for (const row of data?.rows ?? []) {
      let byHour = map.get(row.station_id);
      if (!byHour) { byHour = new Map(); map.set(row.station_id, byHour); }
      byHour.set(row.hour, row);
    }
    return map;
  }, [data]);
  const sortedHours = useMemo(() => Array.from(new Set((data?.rows ?? []).map((r) => r.hour))).sort(), [data]);
  const forecastByHour = useMemo(() => {
    const map = new Map<string, ForecastResponse["hourly"][number]>();
    for (const h of forecast?.hourly ?? []) map.set(forecastHourKey(h.time), h);
    return map;
  }, [forecast]);
  const futureForecastHours = useMemo(() => {
    const latestObserved = sortedHours[sortedHours.length - 1];
    const result = Array.from(forecastByHour.keys()).filter((h) => latestObserved ? h > latestObserved : true);
    result.sort(); return result;
  }, [forecastByHour, sortedHours]);
  const chartHours = useMemo(() => [...sortedHours, ...futureForecastHours], [sortedHours, futureForecastHours]);
  const forecastValueFor = (hour: string, variableKey: string): number | null => {
    const entry = forecastByHour.get(hour); if (!entry) return null;
    let value: number | null | undefined = null;
    if (variableKey === "temperature_avg") value = entry.temperature;
    else if (variableKey === "humidity_avg") value = entry.humidity;
    else if (variableKey === "cloud_cover_avg") value = entry.cloudCover;
    else if (variableKey === "pressure_avg") value = entry.surfacePressure ?? null;
    else if (variableKey === "wind_speed_avg") value = entry.windSpeed ?? null;
    else if (variableKey === "precipitation_rate_avg" || variableKey === "precipitation_total_avg") value = entry.precipitation;
    if (typeof value !== "number") return null;
    return Math.round(value * 100) / 100;
  };
  const forecastSummary = useMemo(() => {
    const hourly = forecast?.hourly ?? []; if (hourly.length === 0) return null;
    const current = hourly[0]!, next6 = hourly.slice(0, 6), next24 = hourly.slice(0, 24);
    const rainProb = Math.max(0, ...next6.map((h) => h.precipitationProbability));
    const temps = next24.map((h) => h.temperature);
    return { currentTemp: current.temperature, rainProb, maxTemp: Math.max(...temps), minTemp: Math.min(...temps) };
  }, [forecast]);
  const visibleStationIds = useMemo(() => {
    const ids = new Set((data?.rows ?? []).map((r) => r.station_id));
    if (selected) return ids.has(selected) ? [selected] : [];
    return Array.from(ids);
  }, [data, selected]);
  const latest = useMemo(() => {
    const rows = data?.rows ?? []; if (rows.length === 0) return null;
    const latestHour = rows.reduce((max, r) => r.hour > max ? r.hour : max, rows[0]!.hour);
    const atHour = rows.filter((r) => r.hour === latestHour); if (atHour.length === 0) return null;
    const keys = ["temperature_avg", "humidity_avg", "solar_radiation_avg", "uv_index_avg", "precipitation_rate_avg", "precipitation_total_avg", "pressure_avg", "wind_speed_avg", "wind_gust_avg", "wind_direction_avg"];
    const values: Record<string, number | null> = {};
    for (const key of keys) {
      const nums = atHour.map((r) => r[key as keyof AggregateResponse["rows"][number]] as number | null).filter((v): v is number => typeof v === "number");
      values[key] = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
    return { hour: latestHour, stationCount: atHour.length, values };
  }, [data]);
  const tempRange = useMemo(() => {
    const temps = (data?.rows ?? []).map((r) => r.temperature_avg).filter((v): v is number => typeof v === "number");
    return temps.length === 0 ? null : { min: Math.min(...temps), max: Math.max(...temps) };
  }, [data]);
  const pressureTrend = useMemo(() => {
    const rows = data?.rows ?? []; if (rows.length < 2) return "stable";
    const latestVal = latest?.values.pressure_avg ?? null;
    const others = rows.flatMap((r) => r.hour !== latest?.hour ? [r.pressure_avg] : []).filter((v): v is number => typeof v === "number");
    if (latestVal === null || others.length === 0) return "stable";
    const diff = latestVal - others.reduce((a, b) => a + b, 0) / others.length;
    return diff > 0.5 ? "rising" : diff < -0.5 ? "falling" : "stable";
  }, [data, latest]);
  const chartVariables = useMemo(() => showPressure ? [...CHART_VARIABLES, ...OPTIONAL_CHART_VARIABLES] : [...CHART_VARIABLES], [showPressure]);
  const current = latest?.values ?? null;

  return (
    <div className="app">
      <header className="header"><h1>Meteo Data Dashboard</h1><div className="controls">
        <label>Station<select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">All stations</option>{stations.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)}</select></label>
        <label>Range<select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{HOUR_OPTIONS.map((h) => <option key={h} value={h}>{h} hours</option>)}</select></label>
        <label className="toggle"><input type="checkbox" checked={showPressure} onChange={(e) => setShowPressure(e.target.checked)} />Show pressure</label>
      </div></header>
      <NotificationSettings onError={setError} />
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="loading">Loading…</div>}
      {data && <main>
        <section className="summary" aria-label="Latest readings"><div className="summary-grid">
          <div className="summary-card gauge-card"><span className="summary-label">🌡 Temperature</span>{current?.temperature_avg != null && tempRange ? <div className="thermometer"><div className="therm-rail"><div className="therm-fill" style={{ height: `${((current.temperature_avg - tempRange.min) / (tempRange.max - tempRange.min || 1)) * 100}%` }} /><div className="therm-bulb" style={{ background: tempColor(current.temperature_avg) }} /></div><div className="therm-labels"><span>{tempRange.max.toFixed(0)}°</span><span className="therm-current" style={{ color: tempColor(current.temperature_avg) }}>{current.temperature_avg.toFixed(1)}°</span><span>{tempRange.min.toFixed(0)}°</span></div></div> : <span className="summary-value">–</span>}</div>
          {forecast && forecast.hourly.length > 0 && forecastSummary && <div className="summary-card forecast-card"><span className="summary-label">📡 Forecast</span><div className="forecast-temp">{forecastSummary.currentTemp.toFixed(1)}°C</div><div className="forecast-detail">Rain next 6h: {forecastSummary.rainProb.toFixed(0)}%</div><div className="forecast-detail">Today: {forecastSummary.minTemp.toFixed(0)}° / {forecastSummary.maxTemp.toFixed(0)}°</div><div className="forecast-attribution">Forecast provided by Open-Meteo</div></div>}
          <div className="summary-card gauge-card"><span className="summary-label">💧 Humidity</span>{current?.humidity_avg != null ? <div className="ring-wrap"><SVGArc pct={current.humidity_avg} color={humidityCategory(current.humidity_avg).color} /><div className="ring-value">{current.humidity_avg.toFixed(0)}%</div><div className="ring-label" style={{ color: humidityCategory(current.humidity_avg).color }}>{humidityCategory(current.humidity_avg).label}</div></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card gauge-card"><span className="summary-label">☀ UV Index</span>{current?.uv_index_avg != null ? <div className="uv-wrap"><div className="uv-scale"><div className="uv-track">{UV_TIERS.map((t) => <span key={t.label} className="uv-seg" style={{ background: t.color }} />)}<span className="uv-marker" style={{ left: `${Math.min(100, (current.uv_index_avg! / 11) * 100)}%` }} /></div><div className="uv-labels">{["0", "2", "5", "7", "10", "11+"].map((t) => <span key={t}>{t}</span>)}</div></div><div className="uv-value" style={{ color: uvInfo(current.uv_index_avg!).color }}>{current.uv_index_avg.toFixed(1)} · {uvInfo(current.uv_index_avg!).label}</div></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card gauge-card"><span className="summary-label">☀ Solar radiation</span>{current?.solar_radiation_avg != null ? <div className="solar-wrap"><div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, (current.solar_radiation_avg / 900) * 100)}%`, background: solarCategory(current.solar_radiation_avg).color }} /></div><div className="bar-value">{current.solar_radiation_avg.toFixed(0)} W/m²</div><div className="bar-label" style={{ color: solarCategory(current.solar_radiation_avg).color }}>{solarCategory(current.solar_radiation_avg).label}</div></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card gauge-card"><span className="summary-label">🌧 Rain</span>{current?.precipitation_rate_avg != null ? <div className="precip-wrap"><div className="precip-status" style={{ color: precipCategory(current.precipitation_rate_avg).color }}>{precipCategory(current.precipitation_rate_avg).label}</div><div className="precip-value">{current.precipitation_rate_avg.toFixed(1)} mm/h</div></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card"><span className="summary-label">💨 Wind</span>{current?.wind_speed_avg != null ? <div className="wind-wrap"><div className="wind-main"><span className="wind-value">{current.wind_speed_avg.toFixed(1)}</span><span className="wind-unit">km/h</span>{current.wind_direction_avg != null && <span className="wind-dir" title={`${current.wind_direction_avg.toFixed(0)}°`}>{bearingGlyph(current.wind_direction_avg)} {bearingToLabel(current.wind_direction_avg)}</span>}</div><div className="wind-cat" style={{ color: windSpeedCategory(current.wind_speed_avg).color }}>{windSpeedCategory(current.wind_speed_avg).label}</div></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card"><span className="summary-label">🌡 Pressure</span>{current?.pressure_avg != null ? <div className="pressure-wrap"><span className="pressure-value">{current.pressure_avg.toFixed(1)} hPa</span><span className="pressure-trend">{pressureTrendArrow(pressureTrend)}</span><span className="pressure-label">{pressureTrendLabel(pressureTrend)}</span></div> : <span className="summary-value">–</span>}</div>
          <div className="summary-card"><span className="summary-label">🌧 Today</span>{current?.precipitation_total_avg != null ? <div className="today-value">{current.precipitation_total_avg.toFixed(1)} mm</div> : <span className="summary-value">–</span>}</div>
        </div>{latest && <div className="summary-caption">Average of latest readings · {formatHour(latest.hour)} · {latest.stationCount} {latest.stationCount === 1 ? "station" : "stations"}</div>}</section>
        <section className="chart-card"><h2>Wind</h2><div className="wind-row">{visibleStationIds.map((sid) => { const latestRow = dataByStation.get(sid)?.get(sortedHours[sortedHours.length - 1] ?? ""); const dir = latestRow?.wind_direction_avg ?? null; const speed = latestRow?.wind_speed_avg ?? null; const gust = latestRow?.wind_gust_avg ?? null; return <div key={sid} className="wind-item"><div className="station-label">{stationNames.get(sid) ?? sid}</div><div className="compass"><span className="compass-n">N</span><span className="compass-e">E</span><span className="compass-s">S</span><span className="compass-w">W</span><span className="compass-arrow" style={{ transform: `translate(-50%, -50%) rotate(${dir !== null ? (dir % 360) + 180 : 0}deg)` }} title={`${dir !== null ? dir.toFixed(0) + "°" : "no data"}`}>↑</span></div><div className="wind-speed">{speed !== null ? `${Number(speed).toFixed(1)} km/h` : "–"}{gust !== null ? ` · gust ${Number(gust).toFixed(1)} km/h` : ""}<span className="wind-direction">{dir !== null ? `${dir.toFixed(0)}° ${bearingToLabel(dir)}` : ""}</span></div></div>; })}</div></section>
        {chartVariables.map((v) => <section key={v.key} className="chart-card"><h2>{v.label} ({v.unit})</h2><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><LineChart data={chartHours.map((hour) => { const point: Record<string, unknown> = { hour: formatHour(hour) }; for (const sid of visibleStationIds) { const raw = dataByStation.get(sid)?.get(hour)?.[v.key as keyof AggregateResponse["rows"][number]] ?? null; point[sid] = typeof raw === "number" ? Math.round(raw * 100) / 100 : raw; } point.forecast = forecastValueFor(hour, v.key); return point; })}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="hour" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} width={45} /><Tooltip /><Legend />{visibleStationIds.map((sid, i) => <Line key={sid} type="monotone" dataKey={sid} name={stationNames.get(sid) ?? sid} stroke={COLORS[i % COLORS.length]} dot={false} connectNulls />)}{forecast && forecastLineFor(v.key) && <Line key="forecast" type="monotone" dataKey="forecast" name={forecastLineFor(v.key)!.label} stroke={forecastLineFor(v.key)!.color} strokeDasharray="5 5" dot={false} connectNulls={false} />}</LineChart></ResponsiveContainer></div></section>)}
        <section className="chart-card"><h2>Latest hourly averages</h2><div className="table-wrap"><table><thead><tr><th>Station</th><th>Hour</th>{SUMMARY_VARIABLES.map((v) => <th key={v.key}>{v.label}</th>)}</tr></thead><tbody>{data?.rows.slice().sort((a, b) => b.hour.localeCompare(a.hour)).slice(0, visibleStationIds.length * 2).map((row, i) => <tr key={i}><td>{stationNames.get(row.station_id) ?? row.station_id}</td><td>{formatHour(row.hour)}</td>{SUMMARY_VARIABLES.map((v) => <td key={v.key}>{row[v.key as keyof AggregateResponse["rows"][number]] !== null ? Number(row[v.key as keyof AggregateResponse["rows"][number]]).toFixed(1) : "–"}</td>)}</tr>)}</tbody></table></div></section>
      </main>}
    </div>
  );
}
function bearingGlyph(deg: number): string { const d = ((deg % 360) + 360) % 360; if (d >= 337.5 || d < 22.5) return "↓"; if (d < 67.5) return "↙"; if (d < 112.5) return "←"; if (d < 157.5) return "↖"; if (d < 202.5) return "↑"; if (d < 247.5) return "↗"; if (d < 292.5) return "→"; return "↘"; }
function pressureTrendArrow(trend: string): string { return trend === "rising" ? "↗" : trend === "falling" ? "↘" : "→"; }
function pressureTrendLabel(trend: string): string { return trend === "rising" ? "Rising" : trend === "falling" ? "Falling" : "Stable"; }
