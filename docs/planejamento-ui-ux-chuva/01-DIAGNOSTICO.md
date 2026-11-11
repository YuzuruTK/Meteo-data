# 01 — Diagnóstico baseado no repositório

Base: `84b9552b1e2b83a66ac6d0ca1c6fcc3ff4ee7b91`. Os caminhos abaixo são relativos à raiz do projeto. “Confirmado” significa identificado no código, não reproduzido em navegador ou produção.

## 1. Arquitetura que deve ser aproveitada

| Área | Arquivos | O que já existe |
|---|---|---|
| Entrada do Worker | `src/worker.ts`, `wrangler.jsonc` | Cron `*/5 * * * *`, coleta manual protegida, APIs e assets no mesmo Worker. |
| Coleta | `src/collector/collector.ts`, `src/config/weather-sources.json` | Configuração por fonte/local, concorrência limitada, normalização, deduplicação e logs de execução. |
| Última observação | `src/db/latest.ts`, migration `0007` | Uma linha por estação; proteção contra chegada de observação anterior; filtro de frescor de 15 minutos. |
| Resumo atual | `src/dashboard/summary.ts`, migration `0004` | Uma linha com as variáveis mais recentes por estação; exposta por `GET /api/summary`. |
| Histórico | `src/dashboard/aggregate.ts`, `src/db/rollups.ts`, migrations `0005`, `0008`, `0009` | Agregados horários/diários incrementais e reparo limitado; leituras públicas já otimizadas. |
| Push observado | `src/push/rain.ts`, `alerts.ts`, `send.ts`, `subscriptions.ts`, `api.ts` | Limiar, estado por estação, agregação de alertas simultâneos, VAPID, remoção de endpoints 404/410. |
| Push previsto | `src/push/forecast.ts`, migration `0006` | Alertas de frio, variação de temperatura e previsão de chuva, com estado próprio. |
| Forecast | `src/forecast/open-meteo.ts`, `api.ts` | Previsão regional fixa em Ijuí; cache de 30 minutos no Worker e resposta com cache de 10 minutos. |
| Dashboard | `dashboard/src/App.tsx`, `api.ts`, `types.ts`, `index.css` | Filtros de estação/período, cartões, bússolas, gráficos Recharts e tabela. |
| PWA | `dashboard/vite.config.ts`, `public/sw.js`, `src/push.ts` | `injectManifest`, ícones, registro de SW, adesão/cancelamento e notificação de sistema. |
| Idiomas | `dashboard/src/i18n.tsx`, `locales/*`, `LanguageSelector.tsx` | pt-BR/en/es, preferência local, tradução com MutationObserver e testes específicos. |

As quatro estações habilitadas são Ijuí (`ijui-iiJu2`), Floresta (`ijui-iiJu3`), Mundstock (`ijui-iiJu5`) e Itaí (`ijui-iiJu7`). São exemplos reais para fixtures e textos de avaliação; não devem virar lista fixa no frontend.

## 2. Fluxo atual, em sequência

1. `scheduled()` ou o POST manual chama `runCollection()`.
2. O coletor grava a observação e tenta atualizar `dashboard_summary`, `latest_weather_observations` e rollups.
3. Havendo ao menos uma coleta bem-sucedida, `maybeRunWeatherAlerts()` verifica flags/VAPID.
4. `loadLatestStations()` retorna apenas estações com leitura recente e taxa de chuva, sem entregar o timestamp ao detector.
5. `checkAndRecordRainState()` compara taxa com `0.1`, lê o estado anterior e grava o novo estado.
6. `runRainAlerts()` monta uma mensagem única quando várias estações iniciam chuva no mesmo ciclo.
7. `sendPushNotifications()` percorre todas as assinaturas em lotes de 50 e usa TTL de uma hora.
8. O mesmo ciclo também avalia alertas de previsão para as mesmas assinaturas.
9. O SW mostra título/corpo e abre `/`, descartando o contexto de estação do payload.

## 3. Achados prioritários

| ID | Evidência no código | Consequência | Prioridade / destino |
|---|---|---|---|
| D01 | `rain.ts`: `null` resulta em `raining=false` e é persistido. | Uma falha de sensor pode rearmar o detector; a leitura chuvosa seguinte vira falso novo início. | P0, E2. |
| D02 | `LatestStation` não inclui `observed_at`; estado só tem `raining/updated_at`. | Não distingue nova leitura de repetição; não conhece intervalo sem observações válidas nem horário observado do início. | P0, E2/E3. |
| D03 | SELECT seguido de UPSERT separado em `checkAndRecordRainState()`. | Comentário “transactionally” não torna a operação atômica. Cron e trigger manual concorrentes podem decidir o mesmo evento. | P0, E3. |
| D04 | Estado muda antes de enviar; não há outbox ou resultado durável por assinatura. | Uma falha depois da transição pode perder o aviso; repetir o ciclo não o recria. | P0, E3/E4. |
| D05 | `listSubscriptions()` é global; schema não tem preferências. | Usuário recebe todas as estações e também previsões, apesar do rótulo de chuva. | P1, E5/E8. |
| D06 | `App.tsx` deriva `current` de médias da última hora e entre estações. | Cartão de chuva não representa necessariamente chuva na última observação; `summary` existente fica sem uso. | P0, E1/E7. |
| D07 | `updateDashboardSummary()` não tem guarda de timestamp; `upsertLatestObservation()` tem. | Uma observação atrasada pode regredir cartões novos e divergir do detector. | P0, E1. |
| D08 | Refs `aggregateInFlight/forecastInFlight` impedem nova execução enquanto requisição antiga roda. | Troca rápida de filtro pode cancelar a aplicação do resultado antigo e não iniciar o novo; StrictMode merece reprodução. | P0, E1. |
| D09 | `sw.js` só preserva título/corpo e fixa `data.url='/'`. | Estação/evento se perdem ao tocar na notificação. | P1, E8. |
| D10 | `getExistingSubscription()` só consulta navegador; UI chama isso de inscrito. | Assinatura local com falha de persistência no servidor aparenta estar ativa. | P0, E5/E8. |
| D11 | `INSERT OR IGNORE` de assinatura não atualiza chaves; unsubscribe ignora HTTP e retorno booleano local. | Renovação e cancelamento parcial não são representados corretamente. | P1, E5/E8. |
| D12 | `forecastSummary` usa as primeiras 6/24 horas do array. | Se array começa à meia-noite UTC, “próximas 6h” e “hoje” podem estar errados. | P1, E1/E7. |
| D13 | Mesma `forecast.precipitation` é mostrada em `mm` e no gráfico de taxa em `mm/h`. | Acumulado previsto no intervalo é apresentado como taxa instantânea observada. | P1, E7. |
| D14 | Linhas observadas têm `connectNulls`; eixo temporal usa strings e só horas presentes. | Lacunas podem parecer continuidade; ausências de buckets nem sempre aparecem. | P1, E7. |
| D15 | `LanguageSelector` está fora de `App`, fixo no topo direito; textos principais são ingleses mutados depois. | Risco de sobreposição em telas pequenas e fragilidade em texto dinâmico/React. | P1, E6. |
| D16 | Erro de push e erro de dados compartilham `setError`; loading depende de `!data`. | Falhas independentes se misturam; indisponibilidade parcial e troca de filtro têm pouca orientação. | P1, E7/E8. |
| D17 | `Station` no frontend omite `stale/last_observed_at` já enviados pelo backend. | Usuário não vê frescor disponível; estações ausentes podem desaparecer do seletor conforme janela. | P1, E1. |
| D18 | `send.ts` carrega todas as assinaturas antes de lotear; resultado contém endpoint completo. | Crescimento do uso aumenta memória; logs/respostas de diagnóstico exigem cuidado com URLs de assinatura. | P1, E4/E5. |
| D19 | `sw.js` tem duas ocorrências executáveis de `self.__WB_MANIFEST`; `workbox-precaching` não é dependência direta no package do dashboard. | Risco de build/resolução, a confirmar em instalação limpa. Não afirmar falha sem executar. | E0/E8. |
| D20 | `isPushSupported()` não verifica `window.isSecureContext`; erros sugerem causa Android específica genericamente. | Mensagens podem orientar incorretamente o usuário; faltam instruções específicas para instalação PWA quando necessária. | P1, E8. |

Não foram confirmadas condições de produção: chaves VAPID válidas, número de assinantes, qualidade/calibração do sensor, frequência real da fonte, estado das flags, domínio publicado ou entrega efetiva em dispositivos. O executor deverá registrar esses limites, sem inventar métricas.

## 4. Contratos existentes que não devem ser quebrados

| Endpoint | Contrato atual / observação |
|---|---|
| `GET /api/stations?hours=N` | `{ stations }`; backend já inclui `last_observed_at` e `stale`. |
| `GET /api/observations/aggregate?hours=N&station=ID` | `{ columns, rows, filters }`; horas UTC no formato `YYYY-MM-DD HH:00`. |
| `GET /api/summary` | `{ summaries }`; campos em snake_case e timestamps `observed_at/updated_at`. |
| `GET /api/forecast` | `{ generatedAt, hourly }`; coordenadas fixas, sem seleção por estação. |
| `GET /api/push/public-key` | `{ publicKey }`, valida chave pública; falha atual retorna 500. |
| `POST /api/push-subscribe` | `{ endpoint, keys: { p256dh, auth } }` → `{ ok: true }`. |
| `POST /api/push-unsubscribe` | `{ endpoint }` → `{ ok: true }`. |
| `POST /api/push/test` | Segredo `x-collector-trigger`; dispara para todos os inscritos. |
| `POST /` | Coleta manual protegida pelo mesmo header. |

## 5. Testes e documentação aproveitáveis

- `tests/push.test.ts`: limiar, inicialização silenciosa, transição, agrupamento, VAPID e persistência; fake D1 não comprova atomicidade.
- `tests/latest-observations.test.ts`: última observação, antiguidade e pipeline de chuva.
- `tests/timestamp-comparison.test.ts`: comparações de datas com SQLite real.
- `tests/read-path-parity.test.ts`, `tests/incremental-rollups.test.ts`: paridade e plano de consultas com SQLite real; podem ser ignorados pelo runner quando `node:sqlite` não existe.
- `tests/dashboard.test.ts`, `tests/emergency-mode.test.ts`: agregados, summary, filtros e modo de emergência.
- `tests/forecast.test.ts`, `tests/forecast-alerts.test.ts`: previsão e seus alertas; preservar cobertura ao introduzir preferências.
- `dashboard/src/i18n.test.ts`: comportamento atual de idiomas; migrar testes junto da estratégia, sem manter dependência do MutationObserver como objetivo de produto.

`docs/emergency-d1-mode.md` contém números e descrições de etapas anteriores: hoje `aggregate.ts` já lê rollups. `docs/RUNNING-LOCALLY.md` também menciona Node 20 e placeholder de database_id que não descrevem integralmente a árvore atual. Confirmar scripts, engines e configurações reais em E0 antes de corrigir os guias.

## 6. Consequência para a estratégia

Não criar outro sistema de notificações, outro banco ou outro dashboard. Fortalecer os módulos existentes, separar aquisição de dados da apresentação, usar a API summary para o presente, manter os rollups para o histórico e transformar a adesão ao push em um fluxo explícito e verificável.

A estabilidade dos dados é parte da melhoria visual: nenhuma reformulação deve exibir “agora”, “começou” ou “ativo” sem o dado correspondente que sustenta essa afirmação.
