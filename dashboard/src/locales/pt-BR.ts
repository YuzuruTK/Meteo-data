export const ptBR = {
  "Meteo Data Dashboard": "Painel Meteo Data",
  "Station": "Estação",
  "All stations": "Todas as estações",
  "Range": "Período",
  "Show pressure": "Mostrar pressão",
  "Loading…": "Carregando…",
  "Latest readings": "Leituras mais recentes",
  "Temperature": "Temperatura",
  "Humidity": "Umidade",
  "UV Index": "Índice UV",
  "UV index": "Índice UV",
  "Solar radiation": "Radiação solar",
  "Rain": "Chuva",
  "Wind": "Vento",
  "Pressure": "Pressão",
  "Today": "Hoje",
  "Forecast": "Previsão",
  "Rain next 6h": "Chuva nas próximas 6h",
  "Forecast provided by Open-Meteo": "Previsão fornecida por Open-Meteo",
  "Dry": "Seco",
  "Comfortable": "Confortável",
  "Humid": "Úmido",
  "Very Humid": "Muito úmido",
  "Low": "Baixo",
  "Moderate": "Moderado",
  "High": "Alto",
  "Very High": "Muito alto",
  "Extreme": "Extremo",
  "Very Low": "Muito baixa",
  "Drizzle": "Garoa",
  "Heavy Rain": "Chuva forte",
  "Storm": "Tempestade",
  "Calm": "Calmo",
  "Light": "Fraco",
  "Strong": "Forte",
  "Very Strong": "Muito forte",
  "Rising": "Subindo",
  "Falling": "Descendo",
  "Stable": "Estável",
  "Latest hourly averages": "Médias horárias mais recentes",
  "Average of latest readings": "Média das leituras mais recentes",
  "Hour": "Horário",
  "Temperature Forecast": "Previsão de temperatura",
  "Humidity Forecast": "Previsão de umidade",
  "Cloud Cover Forecast": "Previsão de nebulosidade",
  "Pressure Forecast": "Previsão de pressão",
  "Wind Speed Forecast": "Previsão de velocidade do vento",
  "Precip. Rate Forecast": "Previsão de taxa de precipitação",
  "Precipitation Forecast": "Previsão de precipitação",
  "Precip. rate": "Taxa de precipitação",
  "Precip. total": "Precipitação total",
  "Wind speed": "Velocidade do vento",
  "Wind gust": "Rajada de vento",
  "Wind direction": "Direção do vento",
  "Status": "Status",
  "Allowed": "Permitido",
  "Blocked": "Bloqueado",
  "Ask": "Solicitar",
  "Unavailable": "Indisponível",
  "Alerts": "Alertas",
  "Checking…": "Verificando…",
  "Subscribed to rain alerts": "Inscrito nos alertas de chuva",
  "Not subscribed": "Não inscrito",
  "Subscribe": "Inscrever-se",
  "Unsubscribe": "Cancelar inscrição",
  "Rain Alerts": "Alertas de chuva",
  "Push notifications are not supported in this browser.": "As notificações push não são compatíveis com este navegador.",
  "You'll get a notification when rain starts at a station. No account needed.": "Você receberá uma notificação quando começar a chover em uma estação. Não é necessário ter uma conta.",
  "Language": "Idioma",
} as const;

/**
 * Locale-specific post-processing rules for pt-BR.
 *
 * Handles patterns that are difficult to express as simple dictionary entries
 * (dynamic numbers, inline fragments, word-level substitutions).
 */
export function postProcessPtBR(s: string): string {
  return s
    .replace(/(\d+)\s+hours\b/g, "$1 horas")
    .replace(/\bstations\b/g, "estações")
    .replace(/\bstation\b/g, "estação")
    .replace(/\bgust\b/g, "rajada")
    .replace(/\bno data\b/g, "sem dados");
}
