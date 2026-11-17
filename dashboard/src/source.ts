/** Human-readable label for a configured weather source. */
export function sourceLabel(sourceId: string): string {
  if (sourceId.startsWith("weather-com")) return "Weather.com PWS";
  if (sourceId.startsWith("open-meteo")) return "Open-Meteo (estimate)";
  return sourceId;
}
