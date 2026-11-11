# 02 — Especificação do dashboard e da experiência de alertas

Este documento descreve o resultado a implementar sobre `dashboard/`. Os nomes de novos componentes são propostas de organização, não arquivos já existentes.

## 1. Hierarquia de informação

A primeira tela deve responder, nesta ordem: **onde estou olhando; há chuva; de quando é a leitura; como recebo o aviso; quais são as condições e a evolução**.

### Desktop, a partir de 1024 px

1. Cabeçalho: marca Meteo Data, contexto “Estações de Ijuí e região”, idioma no fluxo normal.
2. Barra de contexto: seletor de estação, horário/frescor da leitura e botão “Atualizar dados”.
3. Faixa principal em duas colunas: situação da chuva em aproximadamente 2/3 da largura e adesão/estado dos alertas em 1/3.
4. Condições atuais: cartões compactos de temperatura, umidade, vento e acumulado informado; UV, pressão e radiação em uma segunda faixa ou seção “Outras condições”.
5. Histórico: título, filtro de período e escolha de variável; um gráfico principal e opção de comparar estações.
6. Previsão regional: seção própria, com próximas horas e origem Open-Meteo.
7. Detalhes: tabela de médias horárias e identificação das estações, em expansão acessível.

Não colocar o seletor de período como se alterasse a condição atual. Ele pertence ao histórico. A estação selecionada contextualiza os cartões e o histórico, mas não altera automaticamente as preferências de notificações já salvas.

### Tablet, 768–1023 px

Cabeçalho pode quebrar linha. Hero de chuva e cartão de alertas podem ficar lado a lado se mantiverem texto e controles legíveis; caso contrário, empilhar. Cartões de condições em duas ou três colunas, conforme espaço. Gráfico ocupa a largura útil.

### Mobile, 320–767 px

Uma coluna para chuva e alertas; cartões simples em duas colunas apenas quando couberem sem truncar valores. Seletor de estação ocupa largura total. Botão principal tem pelo menos 44 px de altura. Configurações de alertas expandem em seção inline, evitando um modal adicional como requisito. Histórico usa seleção compacta de variável; tabela tem rolagem horizontal contida e indicação de que há mais colunas.

Preservar a ordem visual e de leitura por teclado. Não usar header/rodapé fixo que cubra conteúdo. Idioma sai da posição fixa atual e passa para o cabeçalho.

## 2. Direção visual executável

Estética clara, limpa e orientada a leitura de dados. A chuva é o destaque por hierarquia, título e conteúdo, sem animações permanentes ou decoração que pareça um radar inexistente.

| Token CSS proposto | Valor inicial | Uso |
|---|---|---|
| `--color-bg` | `#F4F7FA` | Fundo geral. |
| `--color-surface` | `#FFFFFF` | Cartões e controles. |
| `--color-text` | `#162A3A` | Texto principal e valores. |
| `--color-muted` | `#526574` | Metadados; medir contraste no fundo real. |
| `--color-border` | `#D8E2EA` | Separadores; não usar como único indicador de foco. |
| `--color-primary` | `#075985` | CTA, links e foco. |
| `--color-rain-bg` | `#E8F4FC` | Destaque de chuva detectada. |
| `--color-rain-text` | `#075985` | Texto/ícone de chuva. |
| `--color-warning-bg` | `#FFF4D6` | Leitura atrasada e atenção. |
| `--color-warning-text` | `#7A4800` | Texto em aviso. |
| `--color-error-text` | `#A61B2B` | Erros acionáveis. |
| `--radius-card` | `16px` | Cartões principais. |
| `--radius-control` | `10px` | Botões, selects e inputs. |
| `--content-max` | `1200px` | Largura máxima. |

Escala de espaçamento: 4, 8, 12, 16, 24, 32 e 48 px. Padding externo: 16 px no mobile e 24–32 px no desktop. Fonte de sistema já disponível; valores com `font-variant-numeric: tabular-nums`. Corpo 16 px, metadados preferencialmente 13–14 px, títulos 20–28 px, métrica principal 36–48 px responsiva.

Usar ícones consistentes em SVG, locais e decorativos com `aria-hidden` quando acompanhados de texto. Reutilizar recursos existentes sempre que adequados; não introduzir imagens geradas, biblioteca visual inteira ou fontes remotas por padrão. Paleta de gráficos estável por ID de estação, não pelo índice da lista filtrada. Validar contraste de cada combinação efetivamente utilizada.

## 3. Fontes de verdade e regras de apresentação

| Informação | Fonte | Regra |
|---|---|---|
| Condição atual | `GET /api/summary` | Última observação da estação; nunca derivar de média horária. |
| Data da leitura | `summary.observed_at` | Data observada, não horário do fetch nem `updated_at`. |
| Atualização do painel | Horário local de conclusão do fetch | Rótulo distinto: “Painel atualizado às…”. |
| Histórico | `/api/observations/aggregate` | Explicitar “médias horárias”; filtros atuais de 6, 12, 24, 48, 72 e 168 h. |
| Chuva observada | Taxa válida, fresca e `>= 0.1 mm/h` | Mesmo limiar de entrada do detector. |
| Horário de início | Evento persistido, quando disponível e aplicável ao episódio atual | Mostrar “Primeira leitura com chuva às…”, não o instante físico da primeira gota. |
| Previsão | `/api/forecast` | “Previsão para Ijuí e região”; independente da estação selecionada. |
| Preferências de alertas | Confirmação da API de assinatura | Não deduzir do filtro visual nem apenas de `Notification.permission`. |

No modo “Todas as estações”, não fabricar uma estação média. O hero mostra quantas estações recentes reportam chuva e seus nomes. Condições como temperatura podem mostrar intervalo observado entre estações frescas, com rótulo explícito; se isso complicar o primeiro lote, usar cartões por estação. Nunca usar média aritmética de direção do vento. Acumulados de chuva de estações diferentes não devem ser somados.

Os valores em `precipitation_total` mantêm a semântica da fonte. Até validar documentalmente o período/reset do provedor, usar “Acumulado informado pela estação”. Não rotular uma média de acumulados como “Chuva de hoje” nem calcular soma de acumulados sucessivos.

## 4. Estados do hero de chuva

| Condição | Título recomendado | Complemento / ação |
|---|---|---|
| Taxa válida recente >= 0.1 | “Chuva detectada em Floresta” | `1,2 mm/h · Leitura às 16:10`; horário do evento só se existir. |
| Taxa válida recente < 0.1 | “Sem chuva detectada nesta leitura” | Nome da estação e horário; não assegurar ausência de chuva em toda a cidade. |
| Taxa `null`, inválida ou ausente | “Sem leitura de chuva disponível” | Outras variáveis válidas continuam visíveis. |
| Observação com mais de 15 minutos | “Leitura desatualizada” | Última leitura e botão de atualização; não pintar estado atual como seco/chuvoso confirmado. |
| Timestamp inválido ou excessivamente futuro | “Horário da leitura indisponível” | Dado não serve para afirmar condição atual. |
| Nenhuma estação configurada/disponível | “Nenhuma estação disponível” | Orientação curta, sem seletor vazio funcional. |
| Todas as estações, algumas com chuva | “Chuva em 2 de 3 estações com leitura recente” | Listar nomes e “1 estação sem leitura recente”. |
| Todas as estações, nenhuma fresca | “Sem leituras recentes” | Mostrar últimas leituras por estação quando existirem. |

O rearmamento do detector e a apresentação da leitura são conceitos distintos: uma taxa de zero pode ser mostrada como “sem chuva nesta leitura” enquanto o backend ainda aguarda a segunda leitura seca para encerrar o episódio. Não publicar uma notificação de fim de chuva.

Um cronômetro local pode atualizar “há X minutos” sem fazer requests. Ao ultrapassar 15 minutos, a interface deve se tornar desatualizada mesmo sem nova resposta da API. Não trocar a hora observada pela hora atual.

Aplicar exatamente a fronteira de frescor do backend: idade **maior que** 15 minutos é desatualizada; exatamente 15 minutos ainda é válida. O relógio visual muda de estado assim que ultrapassa a fronteira. Usar `meta.serverTime` para estimar diferença de relógio quando disponível, preservando `observed_at` como origem da leitura.

Não arredondar uma taxa abaixo de `0.1` para `0,1 mm/h` enquanto o texto diz seco. Para `0 < taxa < 0.1`, apresentar “< 0,1 mm/h”; para zero, “0 mm/h”. Formatar intensidades maiores com precisão coerente, preservando o valor bruto para regras e tooltip detalhado.

## 5. Fluxo de adesão a alertas

### Primeira visita

Mostrar um cartão curto: **“Saiba quando a chuva for detectada”**. Texto: “Receba avisos das estações que você escolher. Sem criar conta.” CTA: **“Configurar alertas”**. Não abrir o diálogo nativo automaticamente.

Ao expandir, apresentar estações com checkbox e opções separadas: “Início de chuva observado”, “Previsão de chuva”, “Previsão de frio ou variação de temperatura”. Para novas adesões, somente o primeiro tipo vem marcado. Pré-selecionar a estação visível, se houver; no modo geral, mostrar explicitamente “Todas as estações” e permitir ajustar antes da confirmação. A escolha deve ficar visível antes de pedir permissão.

CTA final: **“Ativar notificações neste dispositivo”**. A chamada de permissão deve partir diretamente desse gesto; preparar chave pública/configuração antes, quando possível, sem tirar o pedido de permissão da interação do usuário. Permissão concedida seguida de falha no servidor vira estado de sincronização pendente, e não sucesso.

Mensagem curta de latência: “As estações são consultadas a cada 5 minutos. O recebimento também depende da atualização da estação, da conexão e das permissões do dispositivo.”

### Estados obrigatórios do componente

| Estado | Conteúdo e ação |
|---|---|
| `checking` | “Verificando alertas…”; ações que dependem do estado ficam desabilitadas. |
| `unsupported` | Explicar indisponibilidade por recurso; dashboard continua útil. |
| `insecure` | Orientar uso do endereço HTTPS; localhost pode ser contexto seguro. |
| `install-required` | Quando aplicável, instruções para adicionar à tela inicial e abrir por lá. |
| `not-subscribed` | Benefício, escolhas e ação de ativação. |
| `permission-denied` | “Notificações bloqueadas no navegador”; instruções, sem insistir no prompt. |
| `subscribing` | Progresso curto e prevenção de clique duplo. |
| `sync-pending` | “Permissão concedida; falta concluir a ativação”; ação “Tentar concluir”. |
| `subscribed` | “Alertas ativos neste dispositivo”; resumo de estações/tipos e “Editar preferências”. |
| `service-paused` | Assinatura existente, mas serviço temporariamente pausado; não confundir com cancelamento. |
| `saving` | Mantém escolhas anteriores até confirmação; falha preserva formulário para nova tentativa. |
| `unsubscribing` | Cancelamento em andamento, sem duplo envio. |
| `unsubscribe-partial` | Informar o que falta concluir; manter contexto para retentar a limpeza. |
| `error` | Mensagem local ao componente, com recuperação adequada; não apagar o dashboard. |

“Ativo” exige permissão, assinatura local e sincronização confirmada pelo backend. Exibir claramente que a preferência vale para este navegador/dispositivo. Não apresentar o segredo administrativo de teste nem um botão de teste global.

Após sucesso, permitir **“Enviar teste para este dispositivo”** somente quando o endpoint direcionado E5 estiver disponível, com rate limit e resposta “Teste aceito para envio”. A entrega visível ainda depende do dispositivo.

### Plataformas

Detectar recursos (`Notification`, `PushManager`, service worker e contexto seguro), evitando matriz rígida baseada apenas em User-Agent. No fluxo de instalação para iOS/iPadOS, instruir abertura como app da tela inicial quando necessário. A implementação deve ser testada em dispositivos reais; suporte e interação exigida são descritos por [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) e [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static).

## 6. Gráficos, previsão e tabela

- Exibir um gráfico principal por variável selecionada, preservando acesso a todas as variáveis já disponíveis. Não remover dados existentes para conseguir um layout menor.
- Montar eixo temporal completo para a janela, com `null` nos buckets ausentes. Desativar `connectNulls` para séries observadas. Tooltip mostra estação, data, hora, unidade e “Sem dado” quando necessário.
- Cor da estação permanece igual ao mudar filtros. Tooltip e legenda não dependem somente da cor; oferecer tabela acessível com os mesmos dados.
- Separar a seção de previsão da seção de observações por padrão. Se houver overlay de temperatura/umidade/pressão, usar linha tracejada, rótulo “Previsão regional” e domínio temporal apropriado.
- Não sobrepor precipitação prevista em `mm` à taxa observada em `mm/h`. Precipitação horária prevista vai em gráfico/barras com intervalo explícito. [Semântica das variáveis do Open-Meteo](https://open-meteo.com/en/docs).
- Normalizar timestamps previstos para UTC explícito na borda da API; formatar em `America/Sao_Paulo`, exibindo o fuso. A opção de idioma não muda o fuso da estação.
- Selecionar a janela “próximas 6 horas” a partir de `now` injetável, não pelo início do array. Min/max de “próximas 24 horas” usam esse intervalo. “Hoje” só pode usar o calendário local correto.
- `generatedAt` hoje é regenerado inclusive no cache: não chamá-lo de “hora de emissão do modelo”. Acrescentar `fetchedAt` estável no cache se necessário e rotular como horário de obtenção.
- Manter atribuição Open-Meteo e tornar a indisponibilidade da previsão independente da observação.
- Tabela: cabeçalhos com unidades, ordenação previsível por estação/hora, indicação de médias e filtros. Não construir `0` a partir de `null`.

## 7. Comportamento de carregamento e navegação

`App` coordena; hooks separados controlam summary, stations, aggregate e forecast. Cada recurso tem `idle/loading/success/empty/error/maintenance`, timestamp de obtenção e, quando útil, dados anteriores identificados como anteriores.

Ao trocar estação/período, cancelar a requisição anterior com `AbortController` e/ou ignorar sua resposta por identificador de requisição. Uma requisição antiga nunca pode sobrescrever a seleção atual. Não usar uma ref global de “em andamento” que bloqueie o novo filtro. A referência oficial de [effects do React](https://react.dev/reference/react/useEffect) orienta cleanup e tratamento de resultados obsoletos; manter a versão do projeto.

Em erro de atualização, pode manter o último resultado bem-sucedido somente com aviso visível de que ele pertence ao contexto anterior ou está desatualizado. Se a estação mudou, não mostrar números da estação anterior sob o novo nome.

Usar query string `?station=ijui-iiJu3&hours=24` como estado compartilhável. Ordem: URL válida, preferência local válida, padrão atual de todas as estações/24h. Validar IDs e períodos; ID desconhecido mostra aviso e opção de voltar ao geral. `popstate` deve atualizar a interface. Não é obrigatório adicionar roteador.

No clique de notificação, `?station=...&event=...#chuva` destaca/foca o contexto de chuva. Evento agregado usa `?stations=id1,id2&event=...#chuva`, com subconjunto validado e indicação temporária das estações do aviso. Não substituir a preferência permanente de notificações por esse subconjunto.

Não adicionar polling periódico, retry infinito, refetch em cada render ou requests para recalcular “há X minutos”. “Atualizar dados” inicia um ciclo controlado; estações e summary podem ser compartilhados por componentes sem fetch duplicado. Expandir gráficos ocultos não deve repetir requests já válidos para o mesmo filtro.

## 8. Componentização proposta

| Unidade | Responsabilidade |
|---|---|
| `App.tsx` | Compor recursos e seleção; sem concentrar classificação, tradução e gráficos inline. |
| `components/DashboardHeader.tsx` | Marca, idioma, estação e ação de atualização. |
| `components/RainStatusCard.tsx` | Estado da chuva e qualidade temporal; sem enviar push. |
| `components/CurrentConditions.tsx` | Valores atuais por estação ou conjunto explicitamente identificado. |
| `components/HistoryPanel.tsx` / `WeatherChart.tsx` | Filtros históricos, eixo temporal, legenda e alternativa tabular. |
| `components/ForecastPanel.tsx` | Previsão regional e sua janela temporal. |
| `NotificationSettings.tsx` | Evoluir arquivo atual; preferências e estados de adesão. |
| `hooks/useWeatherData.ts` | Recursos e controle de concorrência; pode ser dividido se crescer. |
| `hooks/usePushSubscription.ts` | Estado de permissão/assinatura/sincronização; helpers em `push.ts`. |
| `lib/weather-format.ts` | Formatação de datas, números e unidades com locale/fuso explícitos. |
| `lib/weather-selectors.ts` | Transformações puras de summary, histórico e previsão. |

Esses limites importam mais que os nomes. Não criar um design system genérico maior que a aplicação.

## 9. Idiomas e acessibilidade

Reaproveitar `I18nProvider`, persistência `meteo-data-locale`, `LanguageSelector` e dicionários. Migrar textos alterados para chaves semânticas, pluralização e parâmetros, por exemplo `rain.detectedAtStation({ stationName })`. Durante a transição, marcar subárvores já traduzidas com `data-i18n-ignore`, evitando dupla tradução. Remover o MutationObserver somente quando as telas antigas cobertas por ele tiverem sido migradas e testadas. Push deve usar locale persistido da assinatura; o SW não depende do DOM da página.

Critérios: navegação completa por teclado, foco visível, labels reais em selects/checkboxes, headings ordenados, contraste AA medido, zoom de 200%, suporte a `prefers-reduced-motion`, mensagens de sucesso em `aria-live='polite'` e erro urgente em `role='alert'` sem repetição a cada render. Mudanças do relógio de frescor não devem gerar anúncio por minuto. A tabela oferece alternativa às curvas. Referência: [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/).

O idioma de notificações é salvo ao ativar/editar a assinatura. Uma mudança posterior do idioma do painel pode sincronizar esse campo no servidor uma vez, como consequência do gesto, se houver credencial v2; falha nessa sincronização não deve alterar as estações/tipos nem fingir que o push já usa o novo idioma.

Alvos de toque de 44 px são a meta de design do projeto. Todas as informações de status devem ter texto além de cor. Testar três idiomas com strings longas e preservar acentos/nome das estações.

## 10. Aceite de UI/UX

- [ ] Em 360 px e 1440 px, estação, chuva, frescor e acesso aos alertas são encontrados sem depender de gráficos.
- [ ] “Agora” utiliza summary, não médias; stale/null/zero são distintos.
- [ ] Todos os controles têm loading, vazio, erro e recuperação coerentes.
- [ ] Preferências de push não mudam ao filtrar um gráfico.
- [ ] Histórico, forecast e observação são identificáveis pelo texto e unidades.
- [ ] O resultado da troca rápida de filtros sempre corresponde ao filtro final.
- [ ] Três idiomas funcionam após atualização de dados e troca de filtros.
- [ ] O layout foi inspecionado em 320, 360, 768, 1024 e 1440 px, teclado e zoom 200%.
- [ ] Telas de permissão bloqueada, falha de backend, assinatura ativa e dado atrasado têm evidência visual.
- [ ] Nenhum requisito foi substituído por dados fictícios em produção.
