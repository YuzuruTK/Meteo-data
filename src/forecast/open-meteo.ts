import type { ForecastHourly, ForecastResponse, OpenMeteoResponse } from "./types";

/**
 * Open-Meteo forecast client.
 *
 * Fetches hourly forecast data for a fixed location and serves it through
 * /api/forecast. Forecast data is intentionally NOT stored in D1 yet; instead
 * the response is cached in the Cloudflare Cache API for up to 30 minutes to
 * avoid calling Open-Meteo on every frontend request.
 *
 * Future work (forecast verification / history) will add persistence here.
 */

/** Fixed forecast location: primary Ijuí station (Ijuí — IIJU2). */
export const FORECAST_LATITUDE = -28.391268;
export const FORECAST_LONGITUDE = -53.926267;

const OPEN_METEO_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_SECONDS = 30 * 60;

/** Open-Meteo hourly variables requested. */
const HOURLY_VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "cloud_cover",
  // Fetched now for future forecast verification / calibration / alerts.
  "dew_point_2m",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
].join(",");

function buildUrl(latitude: number, longitude: number): string {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: HOURLY_VARIABLES,
    // UTC keeps forecast timestamps aligned with observation timestamps,
    // which are stored in UTC ("YYYY-MM-DD HH:00").
    timezone: "UTC",
    forecast_days: "2",
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

function numberOrUndefined(value: number | undefined | null): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return value;
}

/** Map a raw Open-Meteo response into the /api/forecast shape. */
export function mapOpenMeteoResponse(raw: OpenMeteoResponse): ForecastResponse {
  const hours = raw.hourly;
  const count = hours.time.length;

  const hourly: ForecastHourly[] = [];
  for (let i = 0; i < count; i++) {
    hourly.push({
      time: hours.time[i]!,
      temperature: hours.temperature_2m[i]!,
      humidity: hours.relative_humidity_2m[i]!,
      precipitationProbability: hours.precipitation_probability[i]!,
      precipitation: hours.precipitation[i]!,
      cloudCover: hours.cloud_cover[i]!,
      dewPoint: numberOrUndefined(hours.dew_point_2m?.[i]),
      surfacePressure: numberOrUndefined(hours.surface_pressure?.[i]),
      windSpeed: numberOrUndefined(hours.wind_speed_10m?.[i]),
      windDirection: numberOrUndefined(hours.wind_direction_10m?.[i]),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    hourly,
  };
}

/**
 * Fetch and map hourly forecast data. Uses the Cloudflare Cache API when
 * available so repeated requests within the 30-minute window reuse the cached
 * response. Throws on network or parsing failure (the caller converts this
 * into a 502 response).
 */
export async function getForecast(): Promise<ForecastResponse> {
  const url = buildUrl(FORECAST_LATITUDE, FORECAST_LONGITUDE);

  // Use the Cloudflare Cache API as a lightweight forecast cache.
  const cache = (caches as unknown as { default?: Cache }).default;
  if (cache) {
    const cachedResponse = await cache.match(url);
    if (cachedResponse) {
      const raw = (await cachedResponse.json()) as OpenMeteoResponse;
      return mapOpenMeteoResponse(raw);
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status}`);
  }

  const raw = (await response.json()) as OpenMeteoResponse;

  // Cache the raw Open-Meteo JSON for the configured TTL. The Cache API
  // honors the response's own freshness headers, so set an explicit max-age.
  if (cache) {
    await cache.put(
      url,
      new Response(JSON.stringify(raw), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
        },
      }),
    );
  }

  return mapOpenMeteoResponse(raw);
}

export { CACHE_TTL_SECONDS };