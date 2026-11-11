# 04 — Orquestração da execução por lotes

Executar mudanças pequenas e verificáveis. A numeração organiza dependências; não representa horas ou prazo prometido. O executor pode trabalhar sequencialmente sozinho. Não é necessário usar subagentes.

## 1. Protocolo de trabalho

Antes de cada lote: ler os documentos de contrato pertinentes, conferir alterações locais e atualizar o diagnóstico se a base mudou. Depois: registrar arquivos, decisões, testes efetivamente rodados e limitações em [07](07-REGISTRO-DE-EXECUCAO.md).

Não marcar lote concluído por ter escrito código. Exigir os critérios de saída e revisão de regressões. Não misturar refatoração de rollups, atualização geral de dependências e redesign num único lote.

| Lote | Depende de | Entrega | Tamanho relativo |
|---|---|---|---|
| E0 | — | Referência reproduzível e fixtures | Pequeno |
| E1 | E0 | Dados atuais, concorrência de fetch e contratos temporais | Médio |
| E2 | E0 | Detector puro com semântica de episódios | Médio |
| E3 | E2 | Persistência atômica e outbox | Grande |
| E4 | E3 | Entrega durável e integração Worker | Grande |
| E5 | E3; integrar com E4 | Preferências/API v2/compatibilidade | Grande |
| E6 | E0; contratos de E1 definidos | Fundação visual e i18n | Médio |
| E7 | E1, E6; metadados E3 para início do episódio | Dashboard completo | Grande |
| E8 | E4, E5, E6, E7 | Jornada push, SW e deep links | Grande |
| E9 | Todos | Validação integrada e preparação de rollout | Médio |

Se houver delegação futura explicitamente autorizada, fronteiras naturais são backend E2–E5 e frontend E6–E7, após combinar contratos de E1. `worker.ts`, `types.ts`, migrations e `push.ts` devem ter um responsável por vez. E8 exige integração conjunta; não é trabalho isolado independente de API.

## 2. E0 — Reproduzir a base e preparar dados de teste

**Arquivos:** `package.json`, `package-lock.json`, `dashboard/package.json`, `dashboard/vite.config.ts`, configurações de TS/Vitest e guias locais. Só alterar o mínimo necessário para tornar a base reproduzível.

**Ações:**

1. Conferir commit, branch, estado local e instruções do repositório. Comparar base com `84b9552`.
2. Identificar versão Node compatível com engines das dependências e `node:sqlite`; registrar Node/npm.
3. Instalar raiz via lockfile; dashboard tem package separado e não possui lockfile nesta base. Resolver dependências de forma explícita, salvar lockfile próprio para reprodutibilidade se adotado.
4. Rodar checks atuais dos dois pacotes. Não corrigir uma falha de referência silenciosamente dentro de redesign; descrevê-la e aplicar reparo mínimo necessário.
5. Verificar especificamente build do SW, ocorrências do manifest Workbox e dependência direta `workbox-precaching`.
6. Preparar fixtures locais de summary, stations, agregados e forecast com as quatro estações, timestamps controlados e cenários secos/chuvosos/nulos/atrasados. Mock fica restrito ao desenvolvimento/teste.
7. Capturar interface atual em desktop/mobile se o ambiente permitir; registrar se só houve auditoria de código.

**Aceite:** relatório com comandos e resultados; suites SQLite não ignoradas; build dos dois pacotes reproduzível ou bloqueio precisamente descrito; nenhum segredo nem dado real de assinatura em fixtures.

**Instrução de lote:** “Estabeleça a referência técnica desta revisão. Não comece o redesign antes de distinguir falhas preexistentes das novas. Use a matriz 05 e registre E0 em 07.”

## 3. E1 — Fontes de dados corretas e estado assíncrono

**Arquivos existentes:** `src/dashboard/summary.ts`, `src/dashboard/api.ts`, `src/dashboard/aggregate.ts`, `src/forecast/open-meteo.ts`, `dashboard/src/api.ts`, `types.ts`, `forecast.ts`, `App.tsx`. **Propostas:** hooks e utilitários de seleção/formatação.

**Ações:**

1. Proteger `updateDashboardSummary()` contra observações anteriores, com normalização temporal consistente com o projeto. Definir tratamento de igualdade: não deixar payload conflitante na mesma data regredir dado válido sem regra explícita de correção.
2. Tipar/consumir `/api/summary`; manter contrato antigo aditivo. Usar `observed_at` nos cartões.
3. Aproveitar `last_observed_at/stale` de stations; oferecer catálogo completo sem sumir com estação temporariamente atrasada. Sugestão: modo aditivo `includeInactive=true` que parte de `weather_locations LEFT JOIN latest_weather_observations`, mantendo semântica antiga para clientes sem parâmetro. Fallback com timestamp nulo deve ser “sem dado”, não “recente”.
4. Separar recursos assíncronos; substituir guardas que bloqueiam filtro novo por abort/identificador de request; testar sob StrictMode.
5. Manter ausência de polling, adicionar refresh explícito e distinguir loading inicial de atualização parcial.
6. Normalizar UTC do forecast e corrigir seleção de próximas 6/24h. Preservar campos legados e explicitar semântica de `generatedAt`; se adicionar `fetchedAt`, armazená-lo no envelope cacheado.
7. Tratar manutenção 503 sem derrubar summary/forecast.

**Aceite:** nenhuma leitura antiga substitui nova; seleção A→B→C termina em C mesmo com respostas fora de ordem; sem erro de push impedindo clima; API pública não perde campos; testes temporais em UTC e America/Sao_Paulo.

**Instrução de lote:** “Faça os dados apresentados corresponderem à última observação e à seleção atual, reaproveitando summary/rollups. Não introduza consultas periódicas nem recálculo do histórico bruto.”

## 4. E2 — Detector puro e regras de chuva

**Arquivos:** `src/push/rain.ts`, `src/db/latest.ts`, tipos associados; `tests/push.test.ts`, `tests/latest-observations.test.ts` e novo teste focado no reducer, se útil.

**Ações:** acrescentar timestamps à entrada; extrair função pura; implementar bootstrap silencioso, frescor, limite futuro, null inválido, monotonicidade, candidato de seco, rebaseline e identificação de evento. Preservar limiar/intensidades existentes, sem inferir tempestade elétrica de taxa de chuva.

**Aceite:** todas as sequências R01–R12 de 05 passam com relógio controlado; cron repetindo a mesma amostra não conta como nova amostra; títulos e intensidade podem ser localizados sem alterar regra de detecção.

**Instrução de lote:** “Implemente a máquina de estados de 03 como transformação pura e prove seus casos-limite. Não confunda ausência de leitura com tempo seco e não envie rede neste lote.”

## 5. E3 — Estado atômico, eventos e migrations

**Arquivos:** migrations novas, `src/push/rain.ts`, `alerts.ts`; propostos `src/push/events.ts` e `src/push/outbox.ts`; adapters de teste SQLite.

**Ações:**

1. Acrescentar colunas e tabelas definidas em 03 sem reescrever migrations existentes.
2. Implementar CAS/token e inserção de evento na mesma transação `db.batch`; provar que UPDATE sem alteração não cria evento.
3. Definir lote estável de eventos simultâneos e preparação paginada retomável de destinatários.
4. Criar índices e constraints; testar instalação limpa e upgrade a partir da migration 0009 com estados/assinaturas legados.
5. Implementar somente acesso a tabelas pequenas/materializadas; registrar planos de execução de consultas novas volumosas.
6. Preparar metadado opcional de evento corrente em summary sem forçar leitura de alertas em modo desabilitado.

**Aceite:** duas execuções concorrentes não criam dois eventos nem dois lotes enviáveis para a mesma transição; rollback de uma escrita impede estado sem evento; recuperação após queda retoma preparação; migração não envia alertas históricos; nenhuma consulta nova varre `weather_observations`.

**Instrução de lote:** “Torne inseparáveis a transição persistida e o registro do evento. Use transações D1 compatíveis e testes SQLite reais; a fake D1 atual é insuficiente para esse aceite.”

## 6. E4 — Entrega, falhas e orçamento de recursos

**Arquivos:** `src/push/send.ts`, `alerts.ts`, `outbox.ts`, `src/worker.ts`, `src/db/types.ts`; testes do Worker/transporte.

**Ações:**

1. Separar envio a um destinatário de escolha de audiência. Reutilizar `web-push-neo` e helpers atuais.
2. Implementar páginas, leases, orçamento por ciclo, timeout e retry limitado. Conferir suporte real da biblioteca ao timeout; `Promise.race` sozinho não cancela envio.
3. TTL restante calculado por evento; cancelar aviso já seco/expirado; 404/410 limpam assinatura e pendências.
4. Processar pendências independentemente da criação de evento no ciclo, inclusive com coleta falha, respeitando `DISABLE_ALERTS` antes de qualquer leitura.
5. Integrar logs sanitizados, flag shadow e limpeza indexada/limitada.
6. Preservar contrato de resultado do coletor e isolamento de falha do forecast.

**Aceite:** cenários T01–T09; envio agrupado preservado; memória/concorrência limitadas; nenhum broadcast duplicado entre caminho antigo e outbox. Antes de E5, usar fixtures de audiência; não considerar pronto para produção com broadcast provisório.

**Instrução de lote:** “Entregue a chuva observada pela outbox, com recuperação limitada e métricas honestas de aceite do provedor. Não alegue garantia exactly-once no aparelho.”

## 7. E5 — Preferências, API v2 e compatibilidade

**Arquivos:** `src/push/api.ts`, `subscriptions.ts`, `send.ts`, `forecast.ts`, `src/worker.ts`, migrations de preferências e testes de API.

**Ações:**

1. Implementar campos/relacionamentos e migração legacy; manter rotas atuais.
2. Validar v2 e guardar capacidade de controle por hash; status, update, cancelamento e teste direcionados.
3. Aplicar seleção de estação antes do agrupamento por destinatário e seleção por tipo também no forecast.
4. Validar destino push, body, origin, credencial e limites; impedir uso como emissor para URLs arbitrárias.
5. Tratar renovação de chaves, resposta perdida, token perdido e edição concorrente; preferências atualizadas atomicamente.
6. Implementar teste para um dispositivo com limite persistente; manter `/api/push/test` administrativo protegido e fora da interface pública.

**Aceite:** cenários P01–P12; cliente legado não sobrescreve escolhas v2; nenhuma mensagem contém estação não escolhida; forecast não chega a quem só optou por chuva; ausência de segredo/endpoint nos logs e APIs públicas.

**Instrução de lote:** “Evolua a assinatura anônima existente sem criar login e sem invalidar a base de inscritos. O contrato 03 define defaults distintos para legado e novas adesões.”

## 8. E6 — Fundação de UI e internacionalização

**Arquivos:** `dashboard/src/index.css`, `main.tsx`, `LanguageSelector.tsx`, `i18n.tsx`, `locales/*`, componentes visuais propostos.

**Ações:** tokens de 02, layout responsivo, controles de foco/loading, idioma no header, componentes de cartão/estado sem abstração excessiva; migração de traduções para chaves e parâmetros com ponte temporária explícita para conteúdo antigo.

**Aceite:** estrutura de tela com conteúdo real tipado ou fixtures somente em teste; três idiomas sem texto misturado/dupla tradução; controle por teclado e contraste verificado; ausência de colisão do seletor no mobile.

**Instrução de lote:** “Construa a base visual descrita em 02 preservando stack e identidade. Use CSS e componentes adequados ao tamanho do projeto; não instale um framework de UI por conveniência.”

## 9. E7 — Dashboard integrado

**Arquivos:** `App.tsx`, componentes/hook/utilitários de 02, APIs e tipos do frontend.

**Ações:**

1. Construir header/contexto, hero de chuva e cartões atuais com summary.
2. Diferenciar modo geral/estação e cada estado de qualidade de leitura.
3. Montar gráfico principal, seleção de variável, lacunas reais e tabela acessível; preservar acesso às variáveis atuais.
4. Separar forecast regional, unidades e intervalos temporais; tratar falha independente.
5. Implementar query string validada, back/forward, atualização manual e relógio local de frescor.
6. Revisar todos os estados com fixtures, inclusive dados parciais e manutenção.

**Aceite:** checklist de 02, cenários U01–U10; horários/unidades corretos; layout em cinco larguras; nenhuma request periódica em idle; nenhuma informação da estação anterior sob o título da nova.

**Instrução de lote:** “Entregue o dashboard funcional usando os contratos corretos, com chuva, qualidade do dado e ativação de alertas na hierarquia principal. Não troque dados reais por mock de demonstração.”

## 10. E8 — Jornada de push e service worker

**Arquivos:** `NotificationSettings.tsx`, `push.ts`, hook de assinatura, `public/sw.js`, `vite.config.ts`, i18n e navegação do dashboard.

**Ações:**

1. Construir todos os estados e escolhas de 02; permissão somente por gesto.
2. Preparar chave/capability, confirmar persistência e reconciliar estado local/remoto sem duplicar inscrição sob StrictMode.
3. Tratar salvamento/cancelamento parciais, permissão negada/revogada e retorno à aba; checagem de foco não pode gerar loop de rede.
4. Preservar metadata/tag no SW, compatibilidade de payload, URL de mesmo origin e navegação aguardada.
5. Implementar entrada da notificação única/agregada e foco acessível na seção chuva.
6. Validar SW compilado, atualização da PWA sem perder assinatura, shell offline e mensagens de instalação quando aplicáveis.
7. Integrar teste direcionado com aviso correto de envio aceito e cooldown.

**Aceite:** cenários B01–B10; fluxo real em navegador/aparelho isolado; abrir pelo aviso mostra a estação correta; permissão concedida com POST falho nunca aparece como ativo.

**Instrução de lote:** “Complete a experiência de ponta a ponta no navegador, usando a infraestrutura já existente. Teste service worker compilado e contexto seguro; mocks do DOM não provam recebimento.”

## 11. E9 — Integração, revisão e entrega

Executar a matriz 05; consolidar evidência visual, SQL e comportamento. Atualizar `README.md`, `docs/PUSH-NOTIFICATIONS.md`, `docs/RUNNING-LOCALLY.md`, `docs/MIGRATIONS.md` e guia de emergência apenas para refletir o que foi implementado. Evitar manter texto antigo que promete comportamento diferente do código.

Revisar tamanho do bundle, número de requests por ação, acessibilidade, rollback, retenção e limites. Confirmar que o endpoint administrativo não virou público e que nenhuma chave foi adicionada ao bundle/configuração versionada.

**Aceite:** todos os requisitos obrigatórios mapeados para evidência; pendências explicitadas; build e migrations locais aprovados; roteiro de publicação pronto, sem implantação remota automática neste escopo.

**Instrução de lote:** “Faça a revisão integrada do produto, não apenas de arquivos isolados. Entregue evidências e limitações reais; somente depois prepare a publicação para autorização quando necessária.”

## 12. Formato de PR/checkpoint sugerido

Título com comportamento concreto, por exemplo `fix: usar a última observação nos cartões do dashboard` ou `feat: enviar alertas de chuva por estação escolhida`.

Descrição curta: problema, comportamento resultante, contratos/migrations afetados, testes realizados e limitações. Não apresentar uma implementação parcial como funcionalidade completa. Checkpoints/PRs são uma proposta de organização; não abrir, publicar ou mesclar PR nesta etapa de planejamento.

Caso apareça bloqueio técnico real, concluir as partes independentes e registrar: comando/erro, alcance, alternativa tentada e informação necessária. Não substituir testes críticos por mocks para marcar um lote como pronto.
