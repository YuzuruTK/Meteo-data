const translations: Record<string, string> = {
  "Meteo Data Dashboard": "Painel Meteo Data",
  "Station": "Estação",
  "All stations": "Todas as estações",
  "Range": "Período",
  "Show pressure": "Mostrar pressão",
  "hours": "horas",
  "Loading…": "Carregando…",
  "Latest readings": "Leituras mais recentes",
  "Temperature": "Temperatura",
  "Humidity": "Umidade",
  "UV Index": "Índice UV",
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
  "Hour": "Horário",
  "station": "estação",
  "stations": "estações",
  "gust": "rajada",
  "no data": "sem dados",
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
};

function translateText(text: string): string {
  let result = text;
  for (const [source, target] of Object.entries(translations)) {
    result = result.replaceAll(source, target);
  }
  result = result.replace(/(\d+)\s+hours/g, "$1 horas");
  result = result.replace(/Average of latest readings/g, "Média das leituras mais recentes");
  return result;
}

export function installPortugueseTranslation(): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.documentElement.lang = "pt-BR";

  const translate = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) nodes.push(node as Text);
    for (const textNode of nodes) {
      const translated = translateText(textNode.nodeValue ?? "");
      if (translated !== textNode.nodeValue) textNode.nodeValue = translated;
    }
  };

  translate(document.body);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const textNode = mutation.target as Text;
        const translated = translateText(textNode.nodeValue ?? "");
        if (translated !== textNode.nodeValue) textNode.nodeValue = translated;
      } else {
        for (const node of mutation.addedNodes) translate(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
