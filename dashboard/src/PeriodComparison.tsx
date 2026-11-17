import { useMemo } from "react";
import { formatHour, translateValue, useI18n } from "./i18n";
import {
  METRIC_DEFINITIONS,
  buildPeriodStatistics,
  compareToPeerAverage,
  deriveAccumulatedPrecipitation,
  formatDifferenceMagnitude,
  formatMetricValue,
  formatNumber,
  groupPrecipitationSamples,
  isFiniteNumber,
  periodMetricValue,
  type ComparisonSemantic,
  type MetricKey,
  type MetricValue,
  type PeerComparison,
} from "./metrics";
import type { AggregateRow, PrecipitationSample, Station } from "./types";
import { sourceLabel } from "./source";

const PRIMARY_METRICS: MetricKey[] = ["temperature", "solarRadiation"];
const SECONDARY_METRICS: MetricKey[] = ["humidity", "uvIndex", "precipitation", "windSpeed"];

const SEMANTIC_LABELS: Record<ComparisonSemantic, string> = {
  warmer: "warmer than peer average",
  cooler: "cooler than peer average",
  above: "above peer average",
  below: "below peer average",
  equal: "approximately equal to peer average",
  unavailable: "comparison unavailable",
};

interface PeriodComparisonProps {
  stations: Station[];
  selectedStations: Station[];
  hours: number;
  rows: AggregateRow[];
  loading: boolean;
  precipitationSamples: PrecipitationSample[];
  precipitationLoading: boolean;
  precipitationError: string | null;
}

interface MetricStationRow {
  station: Station;
  value: number | null;
  min: number | null;
  max: number | null;
  sufficient: boolean;
  loading: boolean;
  comparison: PeerComparison;
}

type Translate = (value: string) => string;

function windowLabel(hours: number, t: Translate): string {
  if (hours === 168) return t("Last 7 days");
  if (hours === 720) return t("Last 30 days");
  return `${t("Last")} ${hours} ${t("hours")}`;
}

function rangeText(row: MetricStationRow, metric: MetricKey, locale: string, t: Translate): string {
  const definition = METRIC_DEFINITIONS[metric];
  const parts: string[] = [];
  if (row.min !== null) parts.push(`${t("Min")} ${formatMetricValue(row.min, definition, locale)}`);
  if (row.max !== null) parts.push(`${t("Max")} ${formatMetricValue(row.max, definition, locale)}`);
  return parts.length > 0 ? parts.join(" · ") : "–";
}

function selectedRange(rows: MetricStationRow[], metric: MetricKey, locale: string): string {
  const values = rows.map((row) => row.value).filter(isFiniteNumber);
  if (values.length === 0) return "–";
  const definition = METRIC_DEFINITIONS[metric];
  return `${formatMetricValue(Math.min(...values), definition, locale)} – ${formatMetricValue(Math.max(...values), definition, locale)}`;
}

function comparisonMagnitude(row: MetricStationRow, metric: MetricKey, locale: string, t: Translate): string {
  const difference = row.comparison.difference;
  if (!difference) return "";
  if (metric === "humidity") {
    return `${formatNumber(Math.abs(difference.absolute), 0, locale)}${t(" pp")}`;
  }
  return formatDifferenceMagnitude(difference, METRIC_DEFINITIONS[metric], locale);
}

function maxMagnitude(rows: MetricStationRow[]): number {
  return Math.max(
    0,
    ...rows.map((row) => {
      const difference = row.comparison.difference;
      return difference ? Math.abs(difference.percentage ?? difference.absolute) : 0;
    }),
  );
}

function comparisonUnavailableText(row: MetricStationRow, t: Translate): string {
  if (row.loading) return t("Loading…");
  if (row.comparison.reason === "no_comparable_peer") return t("No comparable peer from the same source");
  if (row.value === null) return t("No data for this period");
  return t("Insufficient data for comparison");
}

export default function PeriodComparison({
  stations,
  selectedStations,
  hours,
  rows,
  loading,
  precipitationSamples,
  precipitationLoading,
  precipitationError,
}: PeriodComparisonProps) {
  const { locale } = useI18n();
  const t = (value: string): string => translateValue(value, locale);

  const stationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const station of stations) map.set(station.id, station.name);
    return map;
  }, [stations]);

  const statistics = useMemo(() => {
    const selectedIds = new Set(selectedStations.map((station) => station.id));
    const scopedRows = rows.filter((row) => selectedIds.has(row.station_id));
    return buildPeriodStatistics(scopedRows, hours);
  }, [rows, selectedStations, hours]);

  const precipitationValues = useMemo(() => {
    const grouped = groupPrecipitationSamples(precipitationSamples);
    const values = new Map<string, number | null>();
    for (const station of selectedStations) {
      const boundary = deriveAccumulatedPrecipitation(grouped.get(station.id) ?? []);
      values.set(station.id, boundary.value);
    }
    return values;
  }, [precipitationSamples, selectedStations]);

  const comparisons = useMemo(() => {
    const byMetric = new Map<MetricKey, Map<string, PeerComparison>>();
    for (const metric of [...PRIMARY_METRICS, ...SECONDARY_METRICS]) {
      const values = selectedStations.map((station) => {
        if (metric === "precipitation") {
          const value = precipitationValues.get(station.id) ?? null;
          return {
            stationId: station.id,
            sourceId: station.source_id,
            value,
            sufficient: value !== null,
          };
        }
        const summary: MetricValue | null = periodMetricValue(statistics, station.id, metric);
        return {
          stationId: station.id,
          sourceId: station.source_id,
          value: summary?.value ?? null,
          sufficient: summary?.sufficient ?? false,
        };
      });
      const metricComparisons = new Map<string, PeerComparison>();
      for (const value of values) {
        metricComparisons.set(
          value.stationId,
          compareToPeerAverage({
            stationId: value.stationId,
            sourceId: value.sourceId,
            value: value.value,
            values,
            kind: METRIC_DEFINITIONS[metric].kind,
            sufficient: value.sufficient,
          }),
        );
      }
      byMetric.set(metric, metricComparisons);
    }
    return byMetric;
  }, [precipitationValues, selectedStations, statistics]);

  const panelRows = useMemo(() => {
    const byMetric = new Map<MetricKey, MetricStationRow[]>();
    for (const metric of [...PRIMARY_METRICS, ...SECONDARY_METRICS]) {
      byMetric.set(metric, selectedStations.map((station) => {
        const summary = metric === "precipitation"
          ? null
          : periodMetricValue(statistics, station.id, metric);
        const value = metric === "precipitation"
          ? precipitationValues.get(station.id) ?? null
          : summary?.value ?? null;
        return {
          station,
          value,
          min: summary?.min ?? null,
          max: summary?.max ?? null,
          sufficient: metric === "precipitation" ? value !== null : summary?.sufficient ?? false,
          loading: metric === "precipitation" ? precipitationLoading : loading,
          comparison: comparisons.get(metric)?.get(station.id) ?? {
            stationId: station.id,
            value,
            referenceValue: null,
            peerCount: 0,
            difference: null,
            reason: "insufficient_data",
          },
        };
      }));
    }
    return byMetric;
  }, [comparisons, loading, precipitationLoading, precipitationValues, selectedStations, statistics]);

  const latestHour = rows.length > 0
    ? rows.reduce((latest, row) => (row.hour > latest ? row.hour : latest), rows[0]!.hour)
    : null;
  const comparisonEnabled = selectedStations.length > 1;
  const window = windowLabel(hours, t);

  const renderComparison = (row: MetricStationRow, metric: MetricKey, scale: number) => {
    if (!comparisonEnabled) return null;
    if (row.loading) {
      return <span className="comparison-unavailable">{comparisonUnavailableText(row, t)}</span>;
    }
    const difference = row.comparison.difference;
    if (!difference || row.value === null) {
      return <span className="comparison-unavailable">{comparisonUnavailableText(row, t)}</span>;
    }
    const magnitude = comparisonMagnitude(row, metric, locale, t);
    const width = scale > 0
      ? Math.min(100, Math.max(8, (Math.abs(difference.percentage ?? difference.absolute) / scale) * 100))
      : 0;
    const showAbsolute = difference.percentage !== null
      && (metric === "solarRadiation" || metric === "precipitation")
      && difference.absolute !== 0;
    return <div className={`comparison-result ${difference.direction}`}>
      <div className="comparison-copy">
        <strong>{magnitude} {t(SEMANTIC_LABELS[difference.semantic])}</strong>
        {showAbsolute && (
          <small>
            {formatNumber(Math.abs(difference.absolute), METRIC_DEFINITIONS[metric].decimals, locale)} {METRIC_DEFINITIONS[metric].unit} {t("absolute difference")}
          </small>
        )}
      </div>
      {difference.direction !== "neutral" && scale > 0 && (
        <div className="comparison-bar" aria-hidden="true">
          <span style={{ width: `${width}%` }} />
        </div>
      )}
    </div>;
  };

  return (
    <section className="period-comparison" aria-label="Period comparison">
      <div className="period-heading">
        <div>
          <h2>Period comparison</h2>
          <p className="period-context">
            {window}
            {latestHour && <> · {t("Data through")} {formatHour(latestHour)}</>}
          </p>
          <p className="period-context period-context-note">{t("Rolling window, not a calendar day.")}</p>
        </div>
        <span className="peer-baseline">{t("Baseline: average of the other selected stations from the same source")}</span>
      </div>

      {selectedStations.length === 0 ? (
        <p className="comparison-notice">{t("No stations selected")}</p>
      ) : (
        <>
          {!comparisonEnabled && (
            <p className="comparison-notice">
              {t("Select at least two stations to compare them against the average of the other selected stations.")}
            </p>
          )}
          {comparisonEnabled && (
            <p className="comparison-methods">
              {t("Missing measurements are excluded; percentage comparisons are shown only when the baseline is non-zero.")}
            </p>
          )}
          <div className="primary-metric-grid">
            {PRIMARY_METRICS.map((metric) => {
              const metricRows = panelRows.get(metric) ?? [];
              const scale = maxMagnitude(metricRows);
              return (
                <article className="metric-panel primary-metric-panel" key={metric}>
                  <header className="metric-panel-header">
                    <div>
                      <h3>{t(METRIC_DEFINITIONS[metric].label)} — {t("Average")}</h3>
                      <p>{t("Selected-station range")}: {selectedRange(metricRows, metric, locale)}</p>
                    </div>
                    <span>{window}</span>
                  </header>
                  <div className="comparison-table-wrap">
                    <table className="comparison-table">
                      <thead>
                        <tr>
                          <th>{t("Station")}</th>
                          <th>{t("Average")}</th>
                          <th>{t("Min / Max")}</th>
                          {comparisonEnabled && <th>{t("Comparison")}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {metricRows.map((row) => (
                          <tr key={row.station.id}>
                            <td>
                              <span className="comparison-station-name">{stationNames.get(row.station.id) ?? row.station.id}</span>
                              <small className="comparison-source">{sourceLabel(row.station.source_id)}</small>
                              {row.value !== null && !row.sufficient && (
                                <small className="comparison-station-warning">{t("Limited data coverage")}</small>
                              )}
                            </td>
                            <td className="comparison-value">
                              {row.loading ? t("Loading…") : formatMetricValue(row.value, METRIC_DEFINITIONS[metric], locale)}
                            </td>
                            <td className="comparison-range">{rangeText(row, metric, locale, t)}</td>
                            {comparisonEnabled && <td className="comparison-cell">{renderComparison(row, metric, scale)}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              );
            })}
          </div>

          <h3 className="comparison-subtitle">{t("Secondary indicators")}</h3>
          <div className="secondary-metric-grid">
            {SECONDARY_METRICS.map((metric) => {
              const metricRows = panelRows.get(metric) ?? [];
              return (
                <article className="metric-panel secondary-metric-panel" key={metric}>
                  <header className="metric-panel-header">
                    <h3>{t(METRIC_DEFINITIONS[metric].label)}</h3>
                    <span>{window}</span>
                  </header>
                  <div className="secondary-metric-list">
                    {metricRows.map((row) => (
                      <div className="secondary-metric-row" key={row.station.id}>
                        <div className="secondary-station">
                          <span>{stationNames.get(row.station.id) ?? row.station.id}</span>
                          <small className="comparison-source">{sourceLabel(row.station.source_id)}</small>
                          <small>{rangeText(row, metric, locale, t)}</small>
                        </div>
                        <strong className="secondary-value">
                          {row.loading ? t("Loading…") : formatMetricValue(row.value, METRIC_DEFINITIONS[metric], locale)}
                        </strong>
                        {comparisonEnabled && <div className="secondary-comparison">
                          {renderComparison(row, metric, 0)}
                        </div>}
                      </div>
                    ))}
                  </div>
                  {metric === "precipitation" && (
                    <p className="metric-note">
                      {precipitationError || (!precipitationLoading && metricRows.every((row) => row.value === null))
                        ? t("Precipitation comparison unavailable")
                        : t("Derived from cumulative gauge readings.")}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
