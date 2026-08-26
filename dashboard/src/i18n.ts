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
  "Average of latest readings": "Média das leituras mais recentes",
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

const translationEntries = Object.entries(translations).sort(([a], [b]) => b.length - a.length);
const sourcePattern = new RegExp(
  translationEntries.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
);

function translateText(text: string): string {
  if (!sourcePattern.test(text) && !/\b\d+\s+hours\b/.test(text)) return text;
  let result = text;
  for (const [source, target] of translationEntries) result = result.replaceAll(source, target);
  return result.replace(/(\d+)\s+hours/g, "$1 horas");
}

function translateTextNodes(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    const textNode = root as Text;
    const translated = translateText(textNode.nodeValue ?? "");
    if (translated !== textNode.nodeValue) textNode.nodeValue = translated;
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) nodes.push(node as Text);
  for (const textNode of nodes) {
    const translated = translateText(textNode.nodeValue ?? "");
    if (translated !== textNode.nodeValue) textNode.nodeValue = translated;
  }
}

function translateAttributes(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[title], [aria-label]")) {
    for (const attribute of ["title", "aria-label"] as const) {
      const value = element.getAttribute(attribute);
      if (value) {
        const translated = translateText(value);
        if (translated !== value) element.setAttribute(attribute, translated);
      }
    }
  }
}

export function installPortugueseTranslation(): () => void {
  if (typeof document === "undefined" || !document.body) return () => undefined;
  document.documentElement.lang = "pt-BR";
  document.title = translations["Meteo Data Dashboard"];

  translateTextNodes(document.body);
  translateAttributes(document.body);

  const pending = new Set<Node>();
  let frame: number | null = null;
  const flush = () => {
    frame = null;
    for (const node of pending) {
      if (node.isConnected) {
        translateTextNodes(node);
        if (node instanceof Element) translateAttributes(node);
      }
    }
    pending.clear();
  };
  const schedule = (node: Node) => {
    pending.add(node);
    if (frame === null) frame = window.requestAnimationFrame(flush);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") schedule(mutation.target);
      else {
        for (const node of mutation.addedNodes) schedule(node);
        if (mutation.target instanceof Element) schedule(mutation.target);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  return () => {
    observer.disconnect();
    if (frame !== null) window.cancelAnimationFrame(frame);
    pending.clear();
  };
}
