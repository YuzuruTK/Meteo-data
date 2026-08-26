export const es = {
  "Meteo Data Dashboard": "Panel Meteo Data",
  "Station": "Estación",
  "All stations": "Todas las estaciones",
  "Range": "Período",
  "Show pressure": "Mostrar presión",
  "Loading…": "Cargando…",
  "Latest readings": "Lecturas más recientes",
  "Temperature": "Temperatura",
  "Humidity": "Humedad",
  "UV Index": "Índice UV",
  "UV index": "Índice UV",
  "Solar radiation": "Radiación solar",
  "Rain": "Lluvia",
  "Wind": "Viento",
  "Pressure": "Presión",
  "Today": "Hoy",
  "Forecast": "Pronóstico",
  "Rain next 6h": "Lluvia en las próximas 6 h",
  "Forecast provided by Open-Meteo": "Pronóstico proporcionado por Open-Meteo",
  "Dry": "Seco",
  "Comfortable": "Confortable",
  "Humid": "Húmedo",
  "Very Humid": "Muy húmedo",
  "Low": "Bajo",
  "Moderate": "Moderado",
  "High": "Alto",
  "Very High": "Muy alto",
  "Extreme": "Extremo",
  "Very Low": "Muy bajo",
  "Drizzle": "Llovizna",
  "Heavy Rain": "Lluvia intensa",
  "Storm": "Tormenta",
  "Calm": "Calma",
  "Light": "Ligero",
  "Strong": "Fuerte",
  "Very Strong": "Muy fuerte",
  "Rising": "Subiendo",
  "Falling": "Bajando",
  "Stable": "Estable",
  "Latest hourly averages": "Promedios horarios más recientes",
  "Average of latest readings": "Promedio de las lecturas más recientes",
  "Hour": "Hora",
  "Temperature Forecast": "Pronóstico de temperatura",
  "Humidity Forecast": "Pronóstico de humedad",
  "Cloud Cover Forecast": "Pronóstico de nubosidad",
  "Pressure Forecast": "Pronóstico de presión",
  "Wind Speed Forecast": "Pronóstico de velocidad del viento",
  "Precip. Rate Forecast": "Pronóstico de tasa de precipitación",
  "Precipitation Forecast": "Pronóstico de precipitación",
  "Precip. rate": "Tasa de precipitación",
  "Precip. total": "Precipitación total",
  "Wind speed": "Velocidad del viento",
  "Wind gust": "Ráfaga de viento",
  "Wind direction": "Dirección del viento",
  "Status": "Estado",
  "Allowed": "Permitido",
  "Blocked": "Bloqueado",
  "Ask": "Solicitar",
  "Unavailable": "No disponible",
  "Alerts": "Alertas",
  "Checking…": "Comprobando…",
  "Subscribed to rain alerts": "Suscrito a las alertas de lluvia",
  "Not subscribed": "No suscrito",
  "Subscribe": "Suscribirse",
  "Unsubscribe": "Cancelar suscripción",
  "Rain Alerts": "Alertas de lluvia",
  "Push notifications are not supported in this browser.": "Las notificaciones push no son compatibles con este navegador.",
  "You'll get a notification when rain starts at a station. No account needed.": "Recibirás una notificación cuando empiece a llover en una estación. No necesitas una cuenta.",
  "Language": "Idioma",
} as const;

/**
 * Locale-specific post-processing rules for es.
 *
 * Handles patterns that are difficult to express as simple dictionary entries
 * (dynamic numbers, inline fragments, word-level substitutions).
 */
export function postProcessEs(s: string): string {
  return s
    .replace(/(\d+)\s+hours\b/g, "$1 horas")
    .replace(/\bstations\b/g, "estaciones")
    .replace(/\bstation\b/g, "estación")
    .replace(/\bgust\b/g, "ráfaga")
    .replace(/\bno data\b/g, "sin datos");
}
