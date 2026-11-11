# 03 — Contrato funcional e técnico de chuva observada e Web Push

Tudo neste documento que excede o diagnóstico é **proposta de implementação**. Evoluir `src/push/*`, o Worker e o SW existentes. Não introduzir serviço externo de notificações, banco novo ou conta de usuário.

## 1. Significado do diferencial

O evento significa: **a estação passou de uma referência seca recente para uma observação de chuva**. Não significa previsão, primeira gota física, chuva em toda a cidade ou confirmação de que o usuário leu a notificação.

Preservar cron de cinco minutos e limiar `RAIN_THRESHOLD_MM_H = 0.1`. `observedAt` é o tempo fornecido pela estação; `detectedAt` é quando o Worker identifica a transição; `acceptedAt` é quando o provedor aceita o envio. Esses tempos não são intercambiáveis.

Sucesso de envio HTTP significa aceitação pelo serviço push, não exibição no aparelho. A API é apropriada para entrega mesmo com a página fechada, mas o comportamento depende do navegador/SO. Referência: [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

## 2. Entradas e parâmetros

Estender `LatestStation` e `AlertSendingContext.stations` para conter `stationId`, `stationName`, `observedAt`, `collectedAt` ou `updatedAt` de origem e `rainRateMmH`. Preservar `loadLatestStations()` como leitura de tabela materializada; não voltar a buscar MAX no histórico.

O horário de processamento deve ser injetável nos testes. Validar na borda: data parseável, taxa finita e não negativa, unidade já normalizada em mm/h, ID de estação conhecido. O filtro SQL atual rejeita observações antigas, mas também deve haver limite superior contra relógio futuro.

| Parâmetro | Valor inicial proposto | Observação |
|---|---|---|
| Limiar de entrada | `0.1 mm/h` | Valor já existente; não recalibrar sensores nesta entrega. |
| Frescor máximo | 15 minutos | Valor já existente; exatamente 15 ainda é aceito, acima disso é stale. |
| Tolerância futura | 2 minutos | Decisão operacional, não precisão meteorológica; data além disso é inválida. |
| Confirmação de seco | 2 amostras distintas `< 0.1`, intervalo de pelo menos 5 minutos | Contagem de leituras, nunca contagem de execuções cron. |
| Intervalo máximo entre válidas | 15 minutos | Acima disso, rebaseline silencioso na próxima leitura válida. |
| Expiração do aviso de início | `observedAt + 15 minutos` | Não anunciar como recente uma chuva antiga; calcular TTL restante no envio. |
| Retentativas | No máximo 3 tentativas no total, antes da expiração | Inicial + duas oportunidades nos ciclos seguintes, quando houver tempo. |
| Concorrência de envio inicial | 10 requisições | Mais conservadora que o lote atual de 50; medir antes de aumentar. |

Centralizar constantes e validações, evitando números diferentes em frontend/backend. Se houver compartilhamento de módulo, colocar apenas constantes/tipos puros em caminho importável pelos dois builds; nunca importar bindings, config com segredos ou banco no dashboard. Ajustar includes dos tsconfigs somente quando necessário.

## 3. Máquina de estados

O estado persistido representa um episódio conhecido; a qualidade da última leitura é informação separada. Reaproveitar `weather_alert_state.raining` e acrescentar metadados. Não representar `null` como seco.

| Estado anterior | Nova observação | Novo estado / evento |
|---|---|---|
| Sem referência válida | Seca | Inicializa seco; nenhum push. |
| Sem referência válida | Chuvosa | Inicializa molhado; nenhum push. |
| Seco, referência recente | Chuvosa válida e posterior | Abre episódio e cria um `rain-start`. |
| Seco | Seca válida posterior | Mantém seco e atualiza referência. |
| Molhado | Chuvosa válida posterior | Mantém episódio; zera candidato de seco; sem novo evento. |
| Molhado | Primeira seca válida | Mantém episódio e inicia candidato de seco. |
| Molhado, candidato seco | Segunda seca distinta, intervalo >= 5 min | Fecha episódio/rearma; sem push de encerramento. |
| Molhado, candidato seco | Chuvosa | Cancela candidato; mantém mesmo episódio. |
| Qualquer | Taxa nula/inválida | Não muda seco/molhado; não cria evento; interrompe confirmação de seco. |
| Qualquer | Timestamp repetido ou anterior ao processado | Ignora para transição/contagem; não retrocede. |
| Qualquer | Observação stale ou > 2 min no futuro | Não usa para transição; registrar motivo em contador/log. |
| Qualquer | Nova válida após lacuna > 15 min desde a última válida | Reinicializa referência silenciosamente; limpa candidato/episódio antigo. |

Após lacuna, uma leitura chuvosa não prova que a chuva começou naquele instante. O dashboard pode mostrar chuva detectada nessa leitura, mas não deve enviar um aviso tardio de “começou”.

### Campos mínimos de estado propostos

- `station_id`: PK existente, ID local estável.
- `raining`: compatível com a coluna atual; representa episódio aberto ou referência molhada.
- `last_processed_observed_at`: maior timestamp fresco aceito, inclusive de amostra com taxa ausente; impede reprocessamento.
- `last_valid_observed_at`: última amostra com taxa finita e não negativa; determina lacunas reais.
- `dry_since_observed_at`, `dry_sample_count`: confirmação temporal de seco.
- `episode_started_observed_at`: primeira amostra chuvosa de uma transição comprovada; `null` no bootstrap molhado.
- `last_event_id`: referência ao último início comprovado; não preencher com evento inventado.
- `version`: inteiro para atualização condicional concorrente.
- `transition_token`: identificador da tentativa de persistência vencedora, para vincular SQL condicional ao evento.
- `updated_at`: horário de processamento, preservado como metadado.

Numa taxa ausente com timestamp novo e fresco, avançar `last_processed_observed_at`, limpar candidato seco e manter `last_valid_observed_at/raining`. Em amostra repetida, não incrementar contador nem alterar candidato. Em observação stale, não avançar referência válida. Na recuperação, comparar a nova data com a última válida antes de decidir transição.

Migrations de estado existente deixam novos campos temporais nulos. A primeira amostra válida após a migração estabelece referência silenciosa, mesmo que a coluna antiga diga seco. Não fabricar timestamp histórico a partir de `updated_at`.

### Exemplos determinísticos

| Leituras de uma estação (UTC, taxa mm/h) | Resultado |
|---|---|
| 12:00 `0`; 12:05 `0.3`; 12:10 `0.6` | Um evento às 12:05. |
| 12:00 `0.4`; 12:05 `null`; 12:10 `0.5` | Bootstrap molhado; nenhum evento novo provocado por null. |
| 12:00 `0`; 12:05 `0.3`; 12:10 `0`; 12:15 `0.4` | Um único episódio; uma leitura seca não rearma. |
| 12:00 `0`; 12:05 `0.3`; 12:10 `0`; 12:15 `0`; 12:20 `0.4` | Dois eventos: 12:05 e 12:20. |
| 12:00 `0`; nenhuma válida até 12:25 `0.4` | Rebaseline molhado sem aviso de início. |
| 12:00 `0`; 12:05 `0.3` processado em duas execuções | Um evento persistido; entrega deduplicada por destinatário. |

Usar a data da amostra, não a hora do cron, na lógica de intervalos. A amostra inicial seca é referência suficiente para o primeiro início; a regra de duas amostras secas aplica-se ao rearmamento de um episódio molhado.

“Duas” significa pelo menos duas: se a fonte emitir várias amostras em menos de cinco minutos, continuar aguardando até haver pelo menos cinco minutos desde a primeira seca da sequência. Uma taxa inválida ou chuvosa interrompe essa sequência. Normalizar timestamps para uma representação UTC canônica antes de comparações/IDs; verificações em JavaScript preservam a precisão necessária às fronteiras dos testes, mesmo se um pré-filtro SQL usar resolução em segundos.

## 4. Atomicidade: estado e evento não podem se separar

Extrair primeiro uma função pura `evaluateRainTransition(previous, sample, now)` que retorna próximo estado, razão e eventual evento. A função não envia rede nem escreve banco. `checkAndRecordRainState()` passa a coordenar leitura, cálculo e persistência condicional.

Usar uma atualização otimista por `version` e timestamp, com evento condicionado à mesma atualização vencedora. SELECT seguido de UPDATE sem condição continua incorreto. `UNIQUE(station_id, observed_at, type)` é uma segunda proteção, não substituto da proteção de estado.

Estratégia a concretizar em E3:

1. Ler os estados atuais das poucas estações candidatas.
2. Calcular transições puras e gerar token de tentativa por estação e ID estável de evento (`rain-start:<stationId>:<observedAt>` ou hash canônico equivalente).
3. Num `db.batch()` transacional, fazer inicialização/UPDATE condicional por versão e data; inserir evento apenas se o estado persistido tiver o token desta tentativa e indicar aquela transição.
4. Criar/selar o lote de eventos desse processamento dentro da mesma unidade atômica. Lote sem evento não fica pendente.
5. Inspecionar os resultados. Se houve conflito de versão, recarregar e reavaliar com um número pequeno de tentativas (máximo 3); não enviar a decisão calculada sobre estado obsoleto.
6. Nenhuma chamada Web Push ocorre dentro da transação.

O SQL exato deve ser testado em SQLite real e D1 local. Um UPDATE afetando zero linhas não é erro SQL e não aborta `batch`; por isso a inserção do evento precisa da condição do token vencedor. Não presumir transações interativas ou locks de processo compartilhados entre Workers. A semântica de `batch` está na [documentação D1](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## 5. Eventos, lotes e entregas duráveis

Adicionar migrations após `0009`; numeração sugerida `0010_rain_events.sql` e `0011_push_preferences.sql`, ajustada se a branch avançar. Não modificar migrations aplicadas. SQL final é responsabilidade de E3/E5, com estes contratos mínimos:

| Tabela | Conteúdo / invariantes |
|---|---|
| `weather_alert_state` | Colunas atuais + estado temporal/versão acima. |
| `rain_events` | `id` PK, `station_id`, `type='rain-start'`, `observed_at`, `detected_at`, `rate_mm_h`, intensidade, nome da estação no momento, `batch_id`, `expires_at`; unique lógico por estação/tipo/data. |
| `push_batches` | `id` PK, criação, modo `live/shadow`, estado de preparação, cursor de fanout; lote só fica pronto quando a lista de eventos estiver completa. |
| `push_deliveries` | `batch_id`, `subscription_id`, eventos correspondentes ao destinatário, `status`, `attempt_count`, `next_attempt_at`, `expires_at`, `lease_token`, `lease_until`, `accepted_at`, erro sanitizado. Unique `(batch_id, subscription_id)`. |
| `push_subscriptions` | Manter endpoint/chaves; acrescentar ID opaco estável e preferências/credencial de controle descritas abaixo. |
| `push_subscription_stations` | Relação de assinatura com estações para escopo selecionado; PK composta e índice por estação/assinatura. |

IDs opacos de assinatura podem ser preenchidos pela migration com valores aleatórios únicos, preservando endpoint como chave atual de compatibilidade. Não colocar endpoint completo na chave pública de evento, tag de notificação ou log.

Índices obrigatórios: eventos por estação/data; entregas por status/próxima tentativa; entregas por assinatura; relação por estação; retenção por expiração/data. Demonstrar `EXPLAIN QUERY PLAN` nas consultas volumosas. Leitura completa das quatro linhas de estado é aceitável; scan do histórico bruto não é.

### Preparação dos destinatários

Após commit dos eventos, preparar entregas de forma idempotente e paginada. Cada lote contém os eventos de início detectados juntos; cada assinatura recebe somente o subconjunto de estações permitido. Uma assinatura inscrita em Floresta não deve receber nomes de estações fora da seleção.

Persistir um cursor e congelar a elegibilidade temporal (`subscription.created_at <= batch.created_at`, timestamps normalizados). Uma pessoa que se inscreve depois do evento não recebe o início antigo. A escolha de todas as estações pode ser um escopo explícito `all`; nesse caso novas estações entram automaticamente, conforme texto mostrado ao usuário.

Deduplicar preparação com a chave única de entrega. Se o Worker cair durante fanout, continuar do cursor sem recriar entregas já feitas. Mudanças de preferência posteriores não adicionam destinatários retroativamente; antes de enviar/repetir, remover eventos que deixaram de ser permitidos e cancelar a entrega se não restar nenhum.

### Processamento e retentativas

Estados: `pending`, `sending`, `accepted`, `retry`, `expired`, `cancelled`, `permanent-failure`; `shadow` pode ser tratado no lote sem criar entregas reais.

Uma entrega é reclamada por UPDATE condicional com lease/token; só o vencedor envia. Prazo inicial de lease: 90 segundos, maior que o timeout de transporte planejado. A atualização do resultado também exige o token atual. Limitar tentativas e orçamento total de processamento; não usar `Promise.all` sobre a base inteira.

| Resultado | Conduta |
|---|---|
| Provedor aceita | `accepted`; não reenviar nos ciclos normais. |
| 404/410 | Remover assinatura e preferências; cancelar pendências relacionadas; preservar métricas sem endpoint. |
| Timeout, falha de rede, 429 ou 5xx | `retry` antes da expiração; respeitar Retry-After dentro do prazo; backoff compatível com cron. |
| 400 de payload | Falha permanente desta entrega; log sanitizado para corrigir payload. |
| 401/403 do provedor | Tratar como configuração/autorização a investigar; não apagar assinaturas em massa. |
| Prazo vencido ou escolha removida | Expirar/cancelar; não enviar. |

Antes de cada tentativa, checar se o episódio ainda é pertinente. Se já há leitura seca posterior ou dado deixou de ser recente, cancelar o início pendente em vez de anunciar uma condição possivelmente encerrada. Para lotes mistos, filtrar eventos individualmente. O `expires_at` da entrega não pode permitir reter um evento além do seu próprio prazo.

O cron deve drenar pendências mesmo quando não houve transição nova ou quando a coleta do ciclo falhou. Estruturar `worker.ts` para separar coleta, avaliação de novas observações e drenagem; capturar falhas de alerta sem perder o resultado da coleta. `DISABLE_ALERTS=true` corta todo processamento/consulta de alertas antes de acessar D1. Sem VAPID, não tentar transporte. Retomada nunca dispara backlog expirado.

**Garantia honesta:** persistência deduplica eventos e impede concorrência normal de envio, mas queda após aceite pelo provedor e antes do ACK no D1 deixa uma janela de duplicação. Não prometer exactly-once na rede. Usar tag estável por entrega e `renotify:false` para reduzir repetição visível; validar o comportamento nos navegadores suportados. Não descartar silenciosamente todo push duplicado no SW sem considerar as exigências de notificações visíveis da plataforma.

Conservar a agregação existente: dois inícios no mesmo lote geram uma notificação por assinatura, não N. Tags distintas para episódios distintos permitem avisos futuros legítimos. Previsões usam namespace separado de tag.

### Retenção e crescimento

Proposta inicial: eventos por 30 dias; resultados terminais de entrega por 7 dias; pendentes sempre limitados pela expiração de 15 minutos. Limpeza em lotes pequenos no trabalho horário já existente ou rotina equivalente, por índices e sem remover eventos com entrega ainda referenciada. Ordem: entregas terminais, lotes sem dependências, eventos antigos elegíveis. Medir antes de aumentar retenção. Não copiar chaves/endpoint para histórico de eventos.

## 6. Preferências e compatibilidade

Manter adesão anônima e os caminhos atuais. Acrescentar versão explícita de protocolo para novos clientes.

```json
{
  "version": 2,
  "endpoint": "<endpoint privado do navegador>",
  "keys": { "p256dh": "<base64url>", "auth": "<base64url>" },
  "controlToken": "<capability aleatória gerada e guardada neste dispositivo>",
  "preferences": {
    "stationScope": "selected",
    "stationIds": ["ijui-iiJu3"],
    "rainStart": true,
    "rainForecast": false,
    "temperatureForecast": false,
    "locale": "pt-BR"
  }
}
```

O token de controle é uma capacidade anônima, não uma conta. Gerar 32 bytes aleatórios com Web Crypto no cliente e persistir antes do request; armazenar somente hash no servidor. Assim retry de inscrição após perda da resposta pode repetir o mesmo token. Não usar ID incremental, endpoint ou chave VAPID como token. Se armazenamento local estiver indisponível, explicar limitação e não alegar que a gestão persistente está garantida.

### Endpoints e respostas propostos

| Rota | Comportamento novo |
|---|---|
| `POST /api/push-subscribe` | Aceitar contrato antigo e v2; upsert idempotente; v2 retorna `{ok, subscriptionId, syncedAt, preferences}`. |
| `POST /api/push/status` | Body com `subscriptionId/endpoint`; bearer de controle; retorna somente estado/preferências dessa assinatura, `Cache-Control: no-store`. |
| `POST /api/push/preferences` | Bearer + ID e preferências; validar e substituir seleção atomicamente. |
| `POST /api/push-unsubscribe` | v2 exige token/ID; remove preferências e cancela entregas; chamadas repetidas são sucesso idempotente. Compatibilidade legada delimitada abaixo. |
| `POST /api/push/test-device` | Bearer + ID; só a assinatura correspondente, máximo 1 teste/minuto/dispositivo; nunca usa `sendPushNotifications()` global. |
| `GET /api/push/public-key` | Preservar `{publicKey}`; pode acrescentar disponibilidade/capabilities sem segredos. |
| `GET /api/summary` | Preservar `{summaries}`; acrescentar metadados de disponibilidade e evento atual opcionais. |

Não fornecer GET público que liste assinaturas, endpoints ou tokens. `status/preferences/test-device` não aceitam apenas ID opaco como autorização. Padronizar erros `{error:{code,message,retryable}}` no v2, aceitando que o cliente antigo ainda recebe o formato legado onde necessário.

Validar tamanho de body (sugestão: 16 KiB), limites de strings, enums, locale, IDs existentes/habilitados, lista sem duplicatas e pelo menos uma estação em `selected` quando chuva observada estiver ativa. Um tipo regional de previsão independe da seleção de estação, e isso deve aparecer no formulário. Configuração sem nenhum tipo ativo representa alertas pausados, não inscrição funcionando para chuva.

Datas de criação/sincronização, IDs de assinatura e limites de teste são definidos pelo servidor. O cliente não pode fornecer um `created_at` para receber eventos anteriores ou contornar o filtro temporal de audiência.

### Migração de assinaturas existentes

1. Preservar endpoint/chaves, timestamp original e comportamento conhecido: escopo `all`, chuva e três categorias existentes de forecast habilitadas; locale legado `en`, correspondente ao texto atual. Marcar origem `legacy`.
2. Mostrar essas escolhas ao editar, sem afirmar que novas permissões foram concedidas. Novas adesões v2 têm os defaults diferentes definidos no plano.
3. Uma assinatura legada sem token pode ser promovida uma única vez quando o cliente apresentar endpoint **e as mesmas chaves armazenadas**; criar hash do token fornecido. Essa posse é a capacidade disponível no modelo anônimo, não verificação de identidade humana. Não divulgar esses valores em logs.
4. Após promoção, mutações v2 exigem token. Requisição legada de subscribe com mesmas chaves pode confirmar existência, mas nunca sobrescrever preferências v2. Não permitir substituição de chaves/token por request não autenticado.
5. Preservar unsubscribe legado com endpoint somente para linhas ainda legadas. Para linha promovida, responder com código de atualização necessária ao cliente antigo; validar a transição de SW para não deixar cancelamento silenciosamente sem efeito.
6. Token perdido em cliente v2: orientar renovação local da assinatura; limpar subscription antiga pelo fluxo autenticado quando possível ou pela limpeza 404/410 após revogação local. Nunca reemitir credencial de linha promovida apenas com endpoint público.
7. Rotação de chaves para o mesmo endpoint exige token válido e atualiza via UPSERT; endpoint novo cria nova assinatura e cancela a anterior quando a capacidade antiga estiver disponível. Não usar `INSERT OR IGNORE` para esconder chaves desatualizadas.

O executor pode simplificar a capacidade de controle somente se registrar modelo de ameaça equivalente e provar compatibilidade; não adicionar login para resolver este fluxo.

### Validação de endpoints e abuso

O endpoint recebido será destino de uma requisição do servidor. Exigir HTTPS, proibir credenciais na URL, IP literal/local, localhost e destinos não reconhecidos como serviços push suportados. Manter allowlist explícita e testada para os provedores efetivamente usados; incluir Apple quando suportada. Não seguir redirects para destinos arbitrários. Confirmar como a versão instalada de `web-push-neo` permite controlar esse transporte; falha nessa capacidade deve ser resolvida antes de expor teste direcionado.

Validar `Origin`/Fetch Metadata para mutações do dashboard e limitar taxa de registro/teste, sem tratar CORS como autenticação. Não montar allowlist apenas com o domínio de exemplo codificado hoje: suportar origin real do Worker e desenvolvimento local autorizado. Token não aparece em query string, deep link, analytics, mensagem de erro ou resposta pública. Endpoints e chaves também são privados.

## 7. Relação com alertas de previsão já existentes

Preservar `runForecastAlerts()` e seus testes. Acrescentar filtragem por `rainForecast/temperatureForecast` e locale, separando claramente previsão de início observado. As regras/limiares de previsão continuam como estão, salvo correção necessária de timestamp.

Não deixar a adaptação de `sendPushNotifications()` transformar forecast novamente em broadcast para quem só escolheu chuva observada. Dar ao helper um alvo explícito/tipo de alerta ou funções distintas que não permitam esquecer a seleção.

A outbox desta entrega é obrigatória para chuva observada. Migrar a confiabilidade completa do forecast para essa outbox é evolução separada; registrar que a deduplicação/recuperação atual de forecast continua com suas limitações. Falha no forecast não bloqueia chuva observada, e falha de chuva não impede registrar a coleta.

## 8. Payload e service worker

Exemplo proposto de notificação única, localizada no servidor:

```json
{
  "version": 2,
  "type": "rain-start",
  "title": "Chuva detectada em Floresta",
  "body": "Primeira leitura com chuva às 16:10: 1,2 mm/h.",
  "tag": "rain:<deliveryId>",
  "data": {
    "eventId": "<id estável>",
    "stationIds": ["ijui-iiJu3"],
    "observedAt": "2026-11-10T19:10:00.000Z",
    "expiresAt": "2026-11-10T19:25:00.000Z",
    "url": "/?station=ijui-iiJu3&event=<id-codificado>#chuva"
  }
}
```

Para múltiplas estações, título “Chuva detectada em 2 estações”; corpo limitado, por exemplo “Floresta e Mundstock. Veja as leituras.” Nomear apenas estações autorizadas para aquele destinatário. Fixar limite de tamanho do payload serializado (meta <= 3 KiB) e cortar lista com “e mais N”, sem perder IDs necessários dentro do orçamento.

Em `dashboard/public/sw.js`:

- Preservar `data`, `tag` e tipo após validação; continuar aceitando payload antigo só com título/corpo.
- Não transformar payload malformado em início de chuva inventado; usar fallback genérico.
- Usar `event.waitUntil()` para exibição e click; `renotify:false`; ícones existentes.
- Ao clicar, resolver a URL e exigir `target.origin === self.location.origin`; rejeitar schemes e destinos externos. Fallback `/`.
- Focar/navegar janela do mesmo origin, aguardando `navigate()` antes de `focus()`; abrir nova somente quando necessário.
- Avisar a aba aberta via `postMessage` para marcar “Novo aviso recebido” e oferecer atualização, sem iniciar polling. Listener valida origem/controlador e remove-se no cleanup.
- Registrar um único SW no mesmo escopo. Resolver a duplicidade de `self.__WB_MANIFEST` durante validação de build; não substituir o arquivo por outro que perca precache ou push.
- API meteorológica não deve ser servida de cache antigo sem identificação. Shell offline pode funcionar, mas dado offline precisa de rótulo e horário.

Opções de `showNotification`, incluindo `data` e `tag`, são documentadas pela [MDN](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification). Preservar o fluxo customizado de [injectManifest](https://vite-pwa-org.netlify.app/guide/inject-manifest) já usado no projeto.

## 9. Summary e contrato para UI

Estender a resposta sem remover campos:

```ts
interface SummaryMeta {
  serverTime: string;
  staleAfterMinutes: number;
  alerting: { rainAvailable: boolean; reason?: 'disabled' | 'unconfigured' | 'shadow' };
}
// Cada summary pode receber rainEvent?: { id; observedAt; detectedAt } | null.
// summaries e todos os campos atuais permanecem; meta é aditivo.
```

`rainEvent` só descreve início comprovado aplicável ao episódio atual; não expor `last_event_id` histórico como se fosse início da leitura atual. JOIN restrito por PK ao estado/evento é suficiente. Quando `DISABLE_ALERTS=true`, retornar indisponibilidade sem ler tabelas de alerta; summary meteorológico continua disponível. Estado meteorológico da UI deriva da taxa/frescor da observação, não do último push enviado.

## 10. Operação e observabilidade

Logs estruturados por ciclo/lote: observações válidas, ignoradas por razão, transições, conflitos CAS, eventos criados, entregas preparadas/aceitas/repetidas/expiradas/canceladas, remoções 404/410, duração e erro sanitizado. IDs de assinatura podem ser opacos; sem endpoint, auth, p256dh ou VAPID privado.

Medir separadamente atraso `detectedAt-observedAt` e `acceptedAt-detectedAt`. Sem telemetria do cliente, não chamar isso de latência até a tela. Amostras de produção e dashboard da Cloudflare devem confirmar custo D1; não criar analytics de terceiros para esta entrega.

Flag proposta `RAIN_ALERT_DELIVERY_MODE=shadow|live`, default documentado `live` para preservar serviço existente após ativação da versão. Configurar explicitamente `shadow` no ambiente de homologação: avalia/persiste eventos de simulação sem entrega real. Lotes shadow nunca viram live retroativamente. Ao mudar modo ou voltar de pausa longa, aplicar rebaseline e expirar pendências antigas. `DISABLE_ALERTS` continua prevalecendo e realiza zero consultas do pipeline.
