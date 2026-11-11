import { useI18n } from "./i18n";
const messages = {
  moreReadings: ["More readings", "Mais leituras", "M?s lecturas"],
  cancelPending: [
    "Cancellation incomplete. Retry to finish disabling this device.",
    "Cancelamento incompleto. Tente novamente para concluir a desativa??o neste dispositivo.",
    "Cancelaci?n incompleta. Reintenta para desactivar este dispositivo.",
  ],
  firstRain: [
    "First reading with rain",
    "Primeira leitura com chuva",
    "Primera lectura con lluvia",
  ],
  newNotice: [
    "New weather alert received. Refresh to see current readings.",
    "Novo aviso recebido. Atualize para consultar as leituras atuais.",
    "Nuevo aviso recibido. Actualiza para consultar las lecturas actuales.",
  ],
  subtitle: [
    "Weather near you",
    "O tempo perto de você",
    "El tiempo cerca de ti",
  ],
  station: ["Station", "Estação", "Estación"],
  all: ["All stations", "Todas as estações", "Todas las estaciones"],
  refresh: ["Refresh data", "Atualizar dados", "Actualizar datos"],
  current: [
    "Latest observations",
    "Últimas observações",
    "Últimas observaciones",
  ],
  rain: ["Rain detected", "Chuva detectada", "Lluvia detectada"],
  dry: [
    "No rain detected in this reading",
    "Sem chuva detectada nesta leitura",
    "Sin lluvia detectada en esta lectura",
  ],
  unknown: [
    "No rain reading available",
    "Sem leitura de chuva disponível",
    "Sin lectura de lluvia disponible",
  ],
  stale: [
    "Outdated reading",
    "Leitura desatualizada",
    "Lectura desactualizada",
  ],
  invalid: [
    "Reading time unavailable",
    "Horário da leitura indisponível",
    "Hora de lectura no disponible",
  ],
  recent: [
    "stations with recent rain readings",
    "estações com leitura recente de chuva",
    "estaciones con lectura reciente de lluvia",
  ],
  missing: [
    "stations without recent rain readings",
    "estações sem leitura recente de chuva",
    "estaciones sin lectura reciente de lluvia",
  ],
  rainTitle: [
    "Rain around Ijuí",
    "Chuva em Ijuí e região",
    "Lluvia en Ijuí y región",
  ],
  observed: ["Reading", "Leitura", "Lectura"],
  updated: ["Dashboard updated", "Painel atualizado", "Panel actualizado"],
  temperature: ["Temperature", "Temperatura", "Temperatura"],
  humidity: ["Humidity", "Umidade", "Humedad"],
  pressure: ["Pressure", "Pressão", "Presión"],
  wind_speed: ["Wind speed", "Velocidade do vento", "Velocidad del viento"],
  wind_direction: [
    "Wind direction",
    "Direção do vento",
    "Dirección del viento",
  ],
  wind_gust: ["Wind gust", "Rajada de vento", "Ráfaga de viento"],
  solar_radiation: ["Solar radiation", "Radiação solar", "Radiación solar"],
  uv_index: ["UV index", "Índice UV", "Índice UV"],
  precipitation_rate: ["Rain rate", "Taxa de chuva", "Tasa de lluvia"],
  precipitation_total: [
    "Station-reported accumulation",
    "Acumulado informado pela estação",
    "Acumulado informado por la estación",
  ],
  cloud_cover: ["Cloud cover", "Cobertura de nuvens", "Nubosidad"],
  visibility: ["Visibility", "Visibilidade", "Visibilidad"],
  history: [
    "Observation history",
    "Histórico de observações",
    "Historial de observaciones",
  ],
  averages: [
    "Hourly averages · America/Sao_Paulo",
    "Médias horárias · America/Sao_Paulo",
    "Promedios horarios · America/Sao_Paulo",
  ],
  variable: ["Variable", "Variável", "Variable"],
  hours: ["hours", "horas", "horas"],
  table: ["View data table", "Ver tabela de dados", "Ver tabla de datos"],
  time: ["Time", "Horário", "Hora"],
  forecast: [
    "Forecast for Ijuí and region",
    "Previsão para Ijuí e região",
    "Pronóstico para Ijuí y región",
  ],
  next6: [
    "Rain probability · next 6 hours",
    "Probabilidade de chuva · próximas 6 horas",
    "Probabilidad de lluvia · próximas 6 horas",
  ],
  next24: [
    "Temperature · next 24 hours",
    "Temperatura · próximas 24 horas",
    "Temperatura · próximas 24 horas",
  ],
  loading: ["Loading…", "Carregando…", "Cargando…"],
  empty: [
    "No data available",
    "Nenhum dado disponível",
    "Sin datos disponibles",
  ],
  error: [
    "Could not load this section. Try refreshing.",
    "Não foi possível carregar esta seção. Tente atualizar.",
    "No se pudo cargar esta sección. Intenta actualizar.",
  ],
  maintenance: [
    "History temporarily unavailable",
    "Histórico temporariamente indisponível",
    "Historial temporalmente no disponible",
  ],
  invalidStation: [
    "Unknown station in link. Select a station below.",
    "Estação desconhecida no link. Selecione uma estação abaixo.",
    "Estación desconocida en el enlace. Selecciona una estación.",
  ],
  alerts: [
    "Know when rain is detected",
    "Saiba quando a chuva for detectada",
    "Entérate cuando se detecte lluvia",
  ],
  benefit: [
    "Choose stations. No account needed. Settings apply to this browser.",
    "Escolha as estações. Sem criar conta. As escolhas valem para este navegador.",
    "Elige estaciones. Sin crear una cuenta. Los ajustes se aplican a este navegador.",
  ],
  configure: ["Configure alerts", "Configurar alertas", "Configurar alertas"],
  rainStart: [
    "Observed rain start",
    "Início de chuva observado",
    "Inicio de lluvia observado",
  ],
  rainForecast: [
    "Regional rain forecast",
    "Previsão regional de chuva",
    "Pronóstico regional de lluvia",
  ],
  temperatureForecast: [
    "Regional cold / temperature change forecast",
    "Previsão regional de frio / variação de temperatura",
    "Pronóstico regional de frío / cambio de temperatura",
  ],
  activate: [
    "Enable notifications on this device",
    "Ativar notificações neste dispositivo",
    "Activar notificaciones en este dispositivo",
  ],
  save: ["Save preferences", "Salvar preferências", "Guardar preferencias"],
  cancel: ["Disable alerts", "Desativar alertas", "Desactivar alertas"],
  test: [
    "Send test to this device",
    "Enviar teste para este dispositivo",
    "Enviar prueba a este dispositivo",
  ],
  accepted: [
    "Test accepted for sending",
    "Teste aceito para envio",
    "Prueba aceptada para envío",
  ],
  active: [
    "Alerts active on this device",
    "Alertas ativos neste dispositivo",
    "Alertas activos en este dispositivo",
  ],
  paused: ["Alerts paused", "Alertas pausados", "Alertas pausadas"],
  pending: [
    "Activation incomplete. Retry to sync with the server.",
    "Ativação incompleta. Tente novamente para sincronizar com o servidor.",
    "Activación incompleta. Reintenta para sincronizar con el servidor.",
  ],
  denied: [
    "Notifications blocked. Enable them in your browser site settings.",
    "Notificações bloqueadas. Libere nas configurações do site no navegador.",
    "Notificaciones bloqueadas. Actívalas en los ajustes del sitio.",
  ],
  unsupported: [
    "Notifications unavailable. On iPhone/iPad, add this site to your Home Screen and open it there.",
    "Notificações indisponíveis. No iPhone/iPad, adicione este site à tela inicial e abra por lá.",
    "Notificaciones no disponibles. En iPhone/iPad, añade este sitio a la pantalla de inicio y ábrelo allí.",
  ],
  insecure: [
    "Open this site using HTTPS to enable notifications.",
    "Abra este site em HTTPS para ativar notificações.",
    "Abre este sitio con HTTPS para activar notificaciones.",
  ],
  latency: [
    "Stations are checked every 5 minutes. Delivery also depends on station updates, your connection and device permissions.",
    "As estações são consultadas a cada 5 minutos. O recebimento também depende da atualização da estação, da conexão e das permissões do dispositivo.",
    "Las estaciones se consultan cada 5 minutos. La recepción también depende de las actualizaciones, la conexión y los permisos del dispositivo.",
  ],
  pushError: [
    "Could not complete this action. Your changes are not confirmed. Try again.",
    "Não foi possível concluir. Suas alterações não foram confirmadas. Tente novamente.",
    "No se pudo completar. Los cambios no están confirmados. Inténtalo de nuevo.",
  ],
  selectOne: [
    "Choose at least one station",
    "Escolha pelo menos uma estação",
    "Elige al menos una estación",
  ],
  legacy: [
    "Existing subscription: confirm preferences to manage it here.",
    "Assinatura existente: confirme as preferências para gerenciá-la aqui.",
    "Suscripción existente: confirma las preferencias para gestionarla aquí.",
  ],
  tokenLost: [
    "Device credentials missing. Reset the browser notification permission, reload, and subscribe again.",
    "Credencial local ausente. Redefina a permissão de notificações do site, recarregue e ative novamente.",
    "Falta la credencial local. Restablece el permiso de notificaciones del sitio, recarga y activa de nuevo.",
  ],
  skip: ["Skip to weather", "Ir para condições do tempo", "Ir al tiempo"],
  fromNotice: [
    "Stations from this notification",
    "Estações deste aviso",
    "Estaciones de esta notificación",
  ],
} as const;
export type MessageKey = keyof typeof messages;
export function useMessages() {
  const { locale } = useI18n();
  return {
    locale,
    t: (key: MessageKey) =>
      messages[key][locale === "en" ? 0 : locale === "pt-BR" ? 1 : 2],
  };
}
