import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const WeatherChart = lazy(() => import("./WeatherChart"));
import LanguageSelector from "./LanguageSelector";
import NotificationSettings from "./NotificationSettings";
import { useMessages, type MessageKey } from "./messages";
import { useResource } from "./useResource";
import { rainStatus, upcoming, type Summary } from "./weather";
import { timestamp } from "../../shared/weather";
import type { AggregateResponse, ForecastResponse, Station } from "./types";
const HOURS = [6, 12, 24, 48, 72, 168];
const VARIABLES: Array<[MessageKey, string]> = [
  ["temperature", "°C"],
  ["humidity", "%"],
  ["precipitation_rate", "mm/h"],
  ["precipitation_total", "mm"],
  ["wind_speed", "km/h"],
  ["wind_gust", "km/h"],
  ["wind_direction", "°"],
  ["pressure", "hPa"],
  ["solar_radiation", "W/m²"],
  ["uv_index", ""],
  ["cloud_cover", "%"],
  ["visibility", "km"],
];
function selection() {
  const q = new URLSearchParams(location.search);
  return {
    station: q.get("station") ?? "",
    hours: HOURS.includes(Number(q.get("hours"))) ? Number(q.get("hours")) : 24,
    notice: q.get("stations")?.split(",") ?? [],
  };
}
export default function App() {
  const { locale, t } = useMessages();
  const [filters, setFilters] = useState(selection);
  const [refresh, setRefresh] = useState(0);
  const [newNotice, setNewNotice] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [variable, setVariable] = useState<MessageKey>("temperature");
  const stations = useResource<{ stations: Station[] }>(
    "/api/stations?includeInactive=true",
    refresh,
  );
  const summary = useResource<{
    summaries: Summary[];
    meta?: { serverTime: string };
  }>("/api/summary", refresh);
  const aggregate = useResource<AggregateResponse>(
    `/api/observations/aggregate?hours=${filters.hours}&station=${encodeURIComponent(filters.station)}`,
    refresh,
  );
  const forecast = useResource<ForecastResponse>("/api/forecast", refresh);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const back = () => setFilters(selection());
    window.addEventListener("popstate", back);
    if (location.hash === "#chuva") document.getElementById("chuva")?.focus();
    return () => {
      clearInterval(timer);
      window.removeEventListener("popstate", back);
    };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === navigator.serviceWorker.controller &&
        event.data?.type === "meteo-notification"
      )
        setNewNotice(true);
    };
    navigator.serviceWorker?.addEventListener("message", receive);
    return () =>
      navigator.serviceWorker?.removeEventListener("message", receive);
  }, []);
  const update = (next: typeof filters) => {
    const q = new URLSearchParams(location.search);
    next.station ? q.set("station", next.station) : q.delete("station");
    q.set("hours", String(next.hours));
    q.delete("stations");
    history.pushState(null, "", `?${q}${location.hash}`);
    setFilters({ ...next, notice: [] });
  };
  const catalog =
    stations.data?.stations ??
    summary.data?.summaries.map((s) => ({
      id: s.location_id,
      name: s.station_name,
      source_id: "",
    })) ??
    [];
  const invalid =
    !!filters.station &&
    !catalog.some((s) => s.id === filters.station) &&
    (!!stations.data || !!summary.data);
  const observed: Summary[] = summary.data
    ? catalog
        .filter((s) => !filters.station || s.id === filters.station)
        .map(
          (s) =>
            summary.data!.summaries.find((row) => row.location_id === s.id) ?? {
              location_id: s.id,
              station_name: s.name,
              observed_at: "",
              precipitation_rate: null,
            },
        )
    : [];
  const serverOffset = summary.data?.meta
    ? timestamp(summary.data.meta.serverTime) - summary.updated
    : 0;
  const clock = now + serverOffset;
  const valid = observed.filter((s) =>
    ["rain", "dry"].includes(rainStatus(s, clock)),
  );
  const raining = valid.filter((s) => rainStatus(s, clock) === "rain");
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v)
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(v)
      : "—";
  const date = (v: string) =>
    Number.isFinite(timestamp(v))
      ? new Date(timestamp(v)).toLocaleString(locale, {
          timeZone: "America/Sao_Paulo",
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "—";
  const rate = (v: unknown) =>
    typeof v === "number" && v > 0 && v < 0.1 ? `< ${number(0.1)}` : number(v);
  const visible = catalog.filter(
    (s) => !filters.station || s.id === filters.station,
  );
  const chart = useMemo(() => {
    const end = Math.floor((aggregate.updated || now) / 3600000) * 3600000;
    const rows = aggregate.data?.rows ?? [];
    return Array.from({ length: filters.hours + 1 }, (_, i) => {
      const time = end - (filters.hours - i) * 3600000;
      const point: Record<string, string | number | null> = { time };
      for (const s of visible) {
        const row = rows.find(
          (r) => r.station_id === s.id && timestamp(r.hour) === time,
        );
        point[s.id] =
          (row?.[`${variable}_avg` as keyof typeof row] as number) ?? null;
      }
      return point;
    });
  }, [
    aggregate.data,
    aggregate.updated,
    filters.hours,
    filters.station,
    stations.data,
    summary.data,
    variable,
  ]);
  const six = upcoming(forecast.data?.hourly ?? [], clock, 6),
    day = upcoming(forecast.data?.hourly ?? [], clock, 24);
  const unit = VARIABLES.find((v) => v[0] === variable)?.[1];
  const status = (resource: { loading: boolean; error: number | null }) =>
    resource.loading ? (
      <p role="status">{t("loading")}</p>
    ) : resource.error ? (
      <p role="alert">{t(resource.error === 503 ? "maintenance" : "error")}</p>
    ) : null;
  return (
    <div className="app" data-i18n-ignore>
      <a className="skip-link" href="#chuva">
        {t("skip")}
      </a>
      <header className="header">
        <div className="brand">
          <span className="brand-icon" aria-hidden="true">
            ☂
          </span>
          <div>
            <h1>Meteo Data</h1>
            <p>{t("subtitle")} · Ijuí, RS</p>
          </div>
        </div>
        <LanguageSelector />
      </header>
      <div className="toolbar">
        <label>
          {t("station")}
          <select
            value={filters.station}
            onChange={(e) => update({ ...filters, station: e.target.value })}
          >
            <option value="">{t("all")}</option>
            {invalid && (
              <option value={filters.station}>{filters.station}</option>
            )}
            {catalog.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() => {
            setNewNotice(false);
            setRefresh((n) => n + 1);
          }}
          disabled={summary.loading}
        >
          {summary.loading ? t("loading") : t("refresh")}
        </button>
        <span className="muted">
          {summary.updated
            ? `${t("updated")} · ${date(new Date(summary.updated).toISOString())}`
            : ""}
        </span>
      </div>
      {invalid && <p role="alert">{t("invalidStation")}</p>}
      {newNotice && <p role="status">{t("newNotice")}</p>}
      <main>
        <section
          id="chuva"
          tabIndex={-1}
          className={`rain-hero ${raining.length ? "wet" : ""}`}
          aria-labelledby="rain-title"
        >
          <div className="eyebrow">{t("rainTitle")}</div>
          <h2 id="rain-title">
            {summary.loading
              ? t("loading")
              : observed.length === 1
                ? t(rainStatus(observed[0]!, clock))
                : raining.length
                  ? `${t("rain")} · ${raining.length} / ${valid.length}`
                  : valid.length
                    ? t("dry")
                    : t("unknown")}
          </h2>
          {status({ ...summary, loading: false })}
          {filters.notice.length > 0 && (
            <p>
              {t("fromNotice")}:{" "}
              {catalog
                .filter((s) => filters.notice.includes(s.id))
                .map((s) => s.name)
                .join(", ")}
            </p>
          )}
          <div className="rain-readings">
            {observed.map((s) => (
              <div key={s.location_id}>
                <strong>{s.station_name}</strong>
                <span>
                  {t(rainStatus(s, clock))}
                  {["rain", "dry"].includes(rainStatus(s, clock))
                    ? ` · ${rate(s.precipitation_rate)} mm/h`
                    : ""}
                </span>
                <small>
                  {t("observed")} · {date(s.observed_at)}
                </small>
              </div>
            ))}
          </div>
          {!summary.loading && !observed.length && <p>{t("empty")}</p>}
          {observed.length > 1 && (
            <p className="muted">
              {valid.length} {t("recent")} · {observed.length - valid.length}{" "}
              {t("missing")}
            </p>
          )}
        </section>
        <NotificationSettings stations={catalog} selected={filters.station} />
        <section aria-labelledby="current-title">
          <div className="section-title">
            <h2 id="current-title">{t("current")}</h2>
            <span className="muted">America/Sao_Paulo</span>
          </div>
          {status(summary)}
          <div className="conditions-grid">
            {observed.map((s) => (
              <article className="card" key={s.location_id}>
                <h3>{s.station_name}</h3>
                <p className="muted">
                  {date(s.observed_at)} · {t(rainStatus(s, clock))}
                </p>
                <div className="temperature">
                  {number(s.temperature)}
                  <small> °C</small>
                </div>
                <dl className="metrics">
                  {VARIABLES.filter((v) =>
                    ["humidity", "precipitation_rate", "wind_speed"].includes(
                      v[0],
                    ),
                  ).map(([key, unit]) => (
                    <div key={key}>
                      <dt>{t(key)}</dt>
                      <dd>
                        {key === "precipitation_rate"
                          ? rate(s[key])
                          : number(s[key])}{" "}
                        <small>{unit}</small>
                      </dd>
                    </div>
                  ))}
                </dl>
                <details>
                  <summary>{t("moreReadings")}</summary>
                  <dl className="metrics">
                    {VARIABLES.filter(
                      (v) =>
                        ![
                          "temperature",
                          "humidity",
                          "precipitation_rate",
                          "wind_speed",
                        ].includes(v[0]),
                    ).map(([key, unit]) => (
                      <div key={key}>
                        <dt>{t(key)}</dt>
                        <dd>
                          {key === "precipitation_rate"
                            ? rate(s[key])
                            : number(s[key])}{" "}
                          <small>{unit}</small>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </article>
            ))}
          </div>
        </section>
        <section className="card history">
          <div className="section-title">
            <div>
              <h2>{t("history")}</h2>
              <p className="muted">{t("averages")}</p>
            </div>
            <div className="controls">
              <label>
                {t("variable")}
                <select
                  value={variable}
                  onChange={(e) => setVariable(e.target.value as MessageKey)}
                >
                  {VARIABLES.map(([key, unit]) => (
                    <option key={key} value={key}>
                      {t(key)} {unit}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("hours")}
                <select
                  value={filters.hours}
                  onChange={(e) =>
                    update({ ...filters, hours: Number(e.target.value) })
                  }
                >
                  {HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h} {t("hours")}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          {status(aggregate)}
          {aggregate.data && !aggregate.data.rows.length && <p>{t("empty")}</p>}
          {!!aggregate.data?.rows.length && (
            <>
              <div
                className="chart-wrap"
                aria-label={`${t(variable)} (${unit})`}
              >
                <Suspense fallback={<p>{t("loading")}</p>}>
                  <WeatherChart
                    points={chart}
                    stations={visible}
                    unit={unit}
                    formatTime={date}
                  />
                </Suspense>
              </div>
              <details>
                <summary>{t("table")}</summary>
                <div className="table-wrap" tabIndex={0}>
                  <table>
                    <caption>
                      {t(variable)} ({unit}) · {t("averages")}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("time")}</th>
                        {visible.map((s) => (
                          <th scope="col" key={s.id}>
                            {s.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {chart.map((row) => (
                        <tr key={row.time}>
                          <th scope="row">
                            {date(new Date(Number(row.time)).toISOString())}
                          </th>
                          {visible.map((s) => (
                            <td key={s.id}>{number(row[s.id])}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </section>
        <section className="card">
          <h2>{t("forecast")}</h2>
          {status(forecast)}
          {day.length > 0 ? (
            <div className="forecast-grid">
              <div>
                <p>{t("next6")}</p>
                <strong>
                  {six.length
                    ? number(
                        Math.max(...six.map((h) => h.precipitationProbability)),
                      )
                    : "—"}
                  %
                </strong>
              </div>
              <div>
                <p>{t("next24")}</p>
                <strong>
                  {number(Math.min(...day.map((h) => h.temperature)))}° /{" "}
                  {number(Math.max(...day.map((h) => h.temperature)))}°
                </strong>
              </div>
            </div>
          ) : (
            !forecast.loading && !forecast.error && <p>{t("empty")}</p>
          )}
          <p className="muted">Open-Meteo · America/Sao_Paulo</p>
        </section>
      </main>
      <footer>Meteo Data · Ijuí, Rio Grande do Sul</footer>
    </div>
  );
}
