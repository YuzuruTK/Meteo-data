# 05 — Validação, evidências e preparação de publicação

Esta é uma lista de verificações para o executor. **Não há resultados de testes ou screenshots produzidos nesta entrega de planejamento.** Não marcar os itens abaixo como passados sem executar.

## 1. Preparação e comandos existentes

Executar na raiz do repositório. Conferir scripts/versões antes caso a base tenha mudado.

```powershell
git status --short
git rev-parse HEAD
node --version
npm --version
npm ci
```

Na base examinada, `dashboard/` não possui lockfile. Para a primeira instalação reproduzível:

```powershell
npm --prefix dashboard install
```

Revisar e versionar o lockfile que for criado no lote E0. A partir daí, usar `npm --prefix dashboard ci`. Não apagar o lockfile da raiz nem atualizar indiscriminadamente todas as dependências para resolver um problema de instalação.

Checks dos pacotes são independentes:

```powershell
npm run typecheck
npm test
npm --prefix dashboard run typecheck
npm --prefix dashboard test
npm run build:dashboard
npm run build
```

`npm run build` é dry-run do Worker; o script `npm run deploy` **publica** e não é um teste. Construir dashboard antes do dry-run, pois `wrangler.jsonc` referencia `dashboard/dist`.

Confirmar que testes de `node:sqlite` foram executados, não apenas ignorados por incompatibilidade do runtime. Ajustar Node a uma versão suportada pelas dependências e que forneça SQLite; não considerar “suíte verde” suficiente se esses testes críticos foram skipped.

Para D1 local e desenvolvimento:

```powershell
npm run migrate:local
npm run dev
```

Em outro terminal, quando necessário:

```powershell
npm run dev:dashboard
```

O Vite encaminha `/api` para `localhost:8787`. Para simulação de scheduled, conferir flags em `npx wrangler dev --help` da versão instalada antes de seguir o guia antigo. Testes de migrations usam banco local isolado; nunca trocar `--local` por `--remote` para contornar erro de teste.

Não é necessário usar chave real de Weather.com para validar regras de chuva: use fixtures e adaptadores locais. Os testes unitários de transporte usam mock; os testes de integração de banco usam SQLite/D1 reais. Recebimento Web Push exige verificação adicional com infraestrutura de push e navegador, em ambiente isolado autorizado.

## 2. Matriz do detector — R

Executar com relógio injetado, datas UTC explícitas e parâmetros de 03.

| ID | Cenário | Resultado esperado |
|---|---|---|
| R01 | Primeira observação seca e primeira observação molhada, em bases separadas | Referência criada, zero eventos. |
| R02 | Seca válida → taxa `0.1` | Um evento, observado na segunda amostra. |
| R03 | `0`, `0.09`, `0.1`, `2.5`, `10` | Limiares respeitados; unidades e intensidade coerentes com regras existentes. |
| R04 | Molhado → `null` → molhado | Não rearmar nem produzir início falso. |
| R05 | Negativo, NaN, infinito, data inválida | Rejeitar como inválido; nenhum início; preservar referência válida. |
| R06 | Uma leitura seca entre duas molhadas | Mesmo episódio. |
| R07 | Duas secas com intervalo >= 5 min → chuva | Rearmar e criar novo início. |
| R08 | Mesmo timestamp seco repetido em três execuções; duas amostras com intervalo < 5 min | Não confirmar seco prematuramente. |
| R09 | Leitura anterior chega após posterior | Estado/data não retrocedem; não duplicar evento. |
| R10 | Idade exatamente 15 min; 15 min + 1 ms; futuro de 2 min e de 2 min + 1 ms | Fronteiras aceitas/rejeitadas conforme contrato, sem comparação lexicográfica inconsistente. |
| R11 | Lacuna > 15 min com retorno chuvoso; nulls intercalados; pausa longa dos alertas | Rebaseline silencioso; UI distingue dado recuperado de início comprovado. |
| R12 | Duas estações com evolução independente, uma com falha de sensor | Falha de uma não contamina a outra nem o estado regional. |

## 3. Persistência e concorrência — C

| ID | Cenário | Resultado esperado |
|---|---|---|
| C01 | Cron e trigger manual leem a mesma versão seca | Uma atualização vencedora e um evento. |
| C02 | UPDATE condicional afeta zero linhas | INSERT de evento não ocorre para essa tentativa. |
| C03 | Falha SQL após atualização de estado, antes de evento | Transação reverte; retry ainda pode criar evento correto. |
| C04 | Queda após commit de evento e antes do fanout | Preparação retoma a partir do lote/cursor. |
| C05 | Fanout repetido após timeout/perda de resposta D1 | Uma entrega por lote/assinatura. |
| C06 | Duas execuções tentam reclamar a mesma entrega | Apenas uma envia durante lease válido. |
| C07 | Lease expira após queda | Nova execução recupera; limitação de possível duplicação pós-aceite documentada. |
| C08 | Banco vazio e upgrade de 0009 com legado | Migrations aplicam sem perder observações, assinaturas ou estado necessário. |
| C09 | Summary recebe observação antiga ou timestamp equivalente com formatos diferentes | Não regredir; normalização temporal explícita. |

Não simular atomicidade exclusivamente por um Map ou fake que procura palavras no SQL. Reutilizar/adaptar os testes SQLite reais existentes e complementar com D1 local para `batch` e resultados `meta.changes`.

## 4. Transporte, retentativa e limites — T

| ID | Cenário | Resultado esperado |
|---|---|---|
| T01 | Aceite do provedor | Marcar `accepted`, sem alegar leitura/recebimento pelo aparelho. |
| T02 | 404 ou 410 | Remover inscrição e relações; cancelar pendências dela. |
| T03 | 429/5xx/rede/timeout | Retry controlado, sem exceder 3 tentativas ou prazo. |
| T04 | 400 e 401/403 | Falha apropriada, sem remoção indevida de toda a base. |
| T05 | Evento expira antes do próximo cron | Expirar sem envio; TTL não reinicia a cada retry. |
| T06 | Já há leitura seca, ou dado perdeu frescor | Cancelar/remover esse evento do envio pendente. |
| T07 | Duas estações iniciam juntas | Um push por assinatura com só o subconjunto permitido. |
| T08 | Coleta atual falha; há entrega elegível anterior | Drenar dentro do prazo, respeitando flags e estado mais recente disponível. |
| T09 | Muitas assinaturas e múltiplas páginas | Memória/concorrência limitadas, cursor recuperável, sem duplicação em fronteiras de página. |

Simular a queda depois de o transporte aceitar e antes da confirmação no D1. Documentar a duplicação residual possível e testar tag estável; não “resolver” o teste fingindo transação entre D1 e o provedor.

## 5. API, preferências e privacidade — P

| ID | Cenário | Resultado esperado |
|---|---|---|
| P01 | Nova inscrição v2; repetir request e perder resposta inicial | Uma inscrição, token estável e preferências idempotentes. |
| P02 | Cliente legado em schema novo | Continuar compatível; defaults preservam comportamento legado. |
| P03 | Promover legado com chaves correspondentes; tentar com chaves divergentes | Promoção válida; tentativa divergente rejeitada. |
| P04 | Cliente antigo tenta alterar uma inscrição promovida | Não sobrescrever preferências/chaves; orientar atualização quando necessário. |
| P05 | Trocar seleção para somente Itaí | Próximos eventos de outras estações não são enviados; pendências são reavaliadas. |
| P06 | Chuva observada habilitada, forecast desabilitado | Nenhum alerta previsto de chuva/frio/variação para esse cliente. |
| P07 | Renovar chaves/endpoints; token perdido | Fluxos definidos, sem inscrição falsa nem acesso com credencial ausente. |
| P08 | Cancelar e repetir cancelamento | Idempotência e limpeza de relações/pendências; distinguir falha local/remota. |
| P09 | Teste direcionado e chamadas repetidas em 1 minuto | Só aquele dispositivo; rate limit atômico e resposta apropriada. |
| P10 | URL não HTTPS, localhost, IP privado, redirect externo, body enorme, keys malformadas | Rejeitar antes de fetch ao destino. |
| P11 | Token errado, ID de outra inscrição, origin incompatível | Sem leitura/mutação de dados privados; nenhum endpoint vazado na resposta. |
| P12 | Novas estações; escopo `all`; lista selecionada vazia/inválida; todos tipos pausados | Semântica explícita, validada e refletida pela UI. |

Revisar também logs de exceções da biblioteca: o próprio texto de erro pode conter endpoint. Sanitizar antes de persistir ou emitir. Não capturar VAPID privado em snapshots ou artifacts de teste.

## 6. Dashboard — U

| ID | Cenário | Resultado esperado |
|---|---|---|
| U01 | Summary diverge da média da última hora | Cartão usa summary; histórico usa média, com rótulos próprios. |
| U02 | Rápida mudança A→B→C, respostas invertidas e StrictMode | Tela final pertence a C; sem loading preso. |
| U03 | Forecast falha, push falha ou histórico retorna 503 | Demais seções continuam funcionais; mensagens locais e claras. |
| U04 | Taxa null, zero, fresca, stale e timestamp inválido | Estados distintos, nunca `null → 0` ou stale → seco. |
| U05 | “Todas”, uma estação atrasada e outras com chuva | Contagem só de dados recentes e visibilidade das indisponíveis. |
| U06 | Horas ausentes no histórico | Lacunas visíveis; tabela/tooltip coerentes; sem linha ligando ausência. |
| U07 | Dia UTC difere do dia local; abrir à tarde; trocar idioma | Próximas 6/24h corretas, fuso fixo da estação e números localizados. |
| U08 | URL válida/inválida, back/forward e evento agregado | Seleção correta ou recuperação clara; preferências de alertas intactas. |
| U09 | Aba parada por 20 min | Zero novas consultas periódicas; frescor local muda para stale. |
| U10 | Refresh manual com erro e mudança de estação | Contexto anterior não aparece como atual sob nome novo. |

## 7. Navegador, PWA e push — B

| ID | Cenário | Resultado esperado |
|---|---|---|
| B01 | Primeira visita sem gesto | Nenhum pedido de permissão nativo. |
| B02 | Permissão granted, POST subscribe falha | `sync-pending`, botão de retentar; não “ativo”. |
| B03 | Permissão negada, revogada, API não suportada ou contexto inseguro | Orientação apropriada, dashboard preservado. |
| B04 | Inscrição existente apenas local ou apenas remota | Reconciliação explícita e idempotente; não concluir sucesso sem evidência. |
| B05 | Clique no push com aba aberta/fechada | Mesmo origin, estação correta, foco em chuva; nada de abrir URL externa. |
| B06 | Payload antigo, malformado, URL maliciosa ou evento agregado | Compatibilidade/fallback seguro, sem chuva inventada. |
| B07 | Atualizar SW/build com assinatura ativa | Mesmo escopo, assinatura preservada, manifest/precache corretos. |
| B08 | Cancelamento com falha HTTP e `unsubscribe()` false | Estado parcial recuperável; sem feedback falso. |
| B09 | Aparelho recebe depois da hora observada; notificação com tag repetida | Horário honesto e mitigação de duplicação; aviso não rotulado “agora” se atrasado. |
| B10 | Instalação/PWA e recebimento em dispositivos reais | Evidência separada por plataforma, versão e origin de teste. |

Matriz mínima de plataforma: Chromium desktop, Firefox desktop, Chrome Android real e Safari/iOS como app da tela inicial quando disponível. Ausência de aparelho é limitação a registrar, não resultado aprovado. Validar capabilities atuais e permitir orientação de instalação específica sem tratar todos os usuários iOS como unsupported.

Se um push chegar já expirado apesar do TTL, não apresentar condição atual inventada. Verificar a política da plataforma para notificações visíveis e, se exibir, identificar como aviso histórico recebido com atraso e direcionar à condição atual. Não usar push silencioso como substituto de atualização de dashboard.

## 8. Acessibilidade e inspeção visual

Larguras: 320, 360, 768, 1024 e 1440 px. Testar zoom de 200%, navegação somente por teclado e preferência de movimento reduzido. Verificar três idiomas com valores longos e nome “Mundstock”.

Capturas mínimas: geral seco, estação com chuva, leitura stale, null de chuva com outras métricas válidas, forecast indisponível, manutenção de histórico, formulário de preferências, permissão bloqueada, sincronização pendente e assinatura ativa. Organizar artefatos com tamanho de viewport e cenário no nome.

Medir contraste nos tokens efetivamente usados. Validar labels, ordem de foco, foco após deep link, alternativa tabular, announcements sem repetição, botão sem corte e ausência de scroll horizontal da página. A tabela pode rolar dentro do próprio contêiner.

Automação recomendada quando adicionada: testes de componente para estados/concorrência e smoke de navegador para caminhos principais. Escolher ferramenta compatível com o projeto, por exemplo Playwright, somente no pacote de desenvolvimento e sem substituir teste real de push. Evitar snapshots enormes que apenas espelham JSX.

## 9. Desempenho e regressões obrigatórias

- Executar testes atuais de rollups, paridade e comparação de timestamps depois das migrations.
- Documentar número de requests no carregamento, troca de período, troca de estação e refresh. Meta: uma consulta por recurso necessário, nenhuma periódica em idle e nenhum refetch por render.
- Summary e status por estação custam proporcionalmente ao número de estações; histórico usa rollups e janela limitada; entregas usam páginas e índices.
- Em `READ_ONLY_EMERGENCY`, stations/aggregate preservam 503 sem consultar D1; summary e forecast continuam tratados como recursos independentes.
- Em `DISABLE_ALERTS`, avaliação, retry e fanout não consultam tabelas de alertas. Em `DISABLE_ROLLUPS`, coleta e materialização de última leitura continuam.
- Registrar bundle inicial e comparação com E0. A meta é não crescer mais de 10% comprimido sem justificativa; se crescer, avaliar carregamento sob demanda dos gráficos antes de aceitar.
- Sem regressão mensurada de leitura/escrita D1 por causa de audiência global carregada em memória ou limpeza sem índice. Valores de produção são evidência posterior, não estimativa apresentada como medição.
- Não cachear resposta meteorológica privada/pública de forma a ocultar frescor; confirmar SW não intercepta APIs com resposta velha silenciosa.

## 10. Roteiro de homologação

1. Criar ambiente isolado com D1, bindings, VAPID e origin próprios; não reaproveitar assinantes de produção.
2. Aplicar migrations nele e cadastrar somente dispositivos de teste consentidos.
3. Operar `RAIN_ALERT_DELIVERY_MODE=shadow`; executar sequências de fixtures sem chamar o provedor.
4. Conferir eventos, razões de supressão, agrupamento, leases, contadores e custo de queries.
5. Mudar esse ambiente para `live`; lotes shadow antigos continuam não enviáveis.
6. Executar dry→wet com leitura atual e endpoint de teste por dispositivo, validando separadamente detecção e transporte.
7. Forçar falha de envio, reinício do Worker, stale, erro de forecast e flags de emergência.
8. Validar upgrade de SW, cliente legado, promoção v2 e cancelamento.
9. Registrar evidências e defeitos; nenhuma base de produção deve receber chuva sintética.

## 11. Preparação da implantação

Este roteiro é para uma etapa futura autorizada. Não executar deploy, migration remota ou push real só porque o documento contém comandos de teste.

Ordem proposta: export/backup e conferência de migrations → aplicar alterações aditivas → Worker compatível com clientes antigos → frontend/SW novo → ativação monitorada. Como Worker e assets são publicados juntos neste projeto, preparar uma versão transitória compatível e validar atualização de SW antes do corte; não pressupor deploy independente dos dois.

Antes de publicar, registrar: hash do código, banco/ambiente alvo, flags atuais, chaves presentes por nome (sem valor), backup recuperável, versão de retorno e smoke tests. Não rotacionar VAPID junto do redesign sem necessidade comprovada: isso pode exigir novas assinaturas.

Nos primeiros ciclos, conferir ausência de picos de duplicação, erros 401/403, crescimento de pendências, regressão D1 e leituras stale. Observar ao menos um ciclo de recuperação e o comportamento em dados reais; chuva sintética fica no ambiente isolado.

## 12. Retorno e falhas operacionais

Se houver tempestade de avisos ou erro de audiência, `DISABLE_ALERTS=true` é o corte imediato já disponível, preservando coleta. Não apagar assinaturas, histórico ou eventos como procedimento de retorno.

Como o schema é aditivo, retornar binário pode ser possível, mas o Worker antigo ignora preferências e a outbox. **Não reativar o emissor antigo em produção após usuários configurarem preferências v2**, pois ele faria broadcast. Manter alertas desabilitados ou usar uma versão de compatibilidade que respeite preferências até corrigir.

Ao retomar a versão corrigida: expirar backlog vencido, rebaseline após lacuna, confirmar que lotes shadow não enviam e liberar envio apenas para eventos recentes. Rollback não consiste em desfazer migrations destrutivamente.

## 13. Evidência de conclusão

O relatório final do executor deve incluir: commit/base, lotes concluídos, arquivos principais, comandos e resultados, contagem de testes executados/ignorados, capturas, plataformas realmente testadas, status das migrations locais, limitações de produção e passos remotos ainda pendentes.

Não usar frases como “push funcionando em todos os celulares” sem a matriz de evidência. Não marcar “fim a fim” se só foi mockado o transporte. O registro 07 deve permitir que outro modelo retome o trabalho sem deduzir o que já foi feito.
