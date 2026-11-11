# Meteo-data — plano de evolução do dashboard e dos alertas de chuva

**Entrega:** planejamento para execução por outro modelo. **Nenhuma funcionalidade deste plano foi implementada nesta etapa.**

**Data:** 10/11/2026, America/Sao_Paulo. **Base examinada:** branch `main`, commit `84b9552b1e2b83a66ac6d0ca1c6fcc3ff4ee7b91`.

O objetivo é melhorar a experiência do dashboard existente e transformar o aviso de início de chuva em uma funcionalidade confiável, compreensível e fácil de ativar. A implementação deve aproveitar React, Vite, Recharts, Cloudflare Workers, D1, Web Push e o coletor que já existem.

## Como usar esta entrega

1. Leia o [diagnóstico do código atual](01-DIAGNOSTICO.md).
2. Use a [especificação de UI/UX](02-ESPECIFICACAO-UI-UX.md) como contrato de experiência.
3. Use a [especificação de chuva e push](03-ESPECIFICACAO-CHUVA-PUSH.md) como contrato de comportamento e persistência.
4. Execute os lotes do [plano de execução](04-PLANO-EXECUCAO.md), respeitando as dependências.
5. Comprove os resultados com a [matriz de validação e rollout](05-VALIDACAO-E-ROLLOUT.md).
6. Para iniciar uma nova conversa com o executor, copie o [prompt de handoff](06-PROMPT-EXECUTOR.md).
7. Atualize o [registro de execução](07-REGISTRO-DE-EXECUCAO.md) a cada lote concluído.

Os documentos distinguem **comportamento existente**, **problema identificado por leitura** e **decisão proposta**. A análise foi estática: não foram instaladas dependências, executados testes, renderizada a interface ou acessados dados de produção. As verificações práticas estão explicitamente atribuídas ao executor.

## Resultado esperado para a pessoa que usa o produto

- Entender rapidamente se há chuva na estação escolhida e de quando é a leitura.
- Diferenciar observação da estação, média histórica e previsão regional.
- Escolher as estações e os tipos de alerta que deseja receber, sem criar conta.
- Receber um aviso de início de chuva observada, sem repetição a cada coleta.
- Tocar no aviso e abrir o dashboard no contexto da estação correspondente.
- Reconhecer dados atrasados, indisponibilidade e bloqueio de permissões sem interpretar ausência de dado como ausência de chuva.

## Decisões propostas para destravar a execução

Estas são escolhas deste planejamento, não preferências adicionais já confirmadas pelo usuário. O executor pode ajustar um detalhe se apresentar evidência técnica e registrar a decisão.

| Tema | Decisão para a primeira entrega |
|---|---|
| Plataforma | Manter Cloudflare Workers + D1 + assets; sem migração de hospedagem. |
| Frontend | Manter React 18, Vite e Recharts; CSS com tokens e componentes pequenos. |
| Identidade | Manter Meteo Data; interface clara, meteorológica, acessível e prioritariamente em português. |
| Idiomas | Preservar pt-BR, inglês e espanhol; aproveitar o provider e substituir gradualmente a tradução por mutação do DOM. |
| Chuva observada | Usar `precipitation_rate` da leitura recente; limiar inicial existente de `0.1 mm/h`. |
| Promessa | Aviso após detecção na coleta; cron continua a cada 5 minutos. Sem prometer instante exato ou entrega garantida em 5 minutos. |
| Anti-repetição | Uma abertura de episódio por transição seca → chuva; duas leituras secas distintas, separadas por pelo menos 5 minutos, para rearmar. |
| Lacunas | Mais de 15 minutos sem leitura válida exige reestabelecer referência silenciosamente. |
| Preferências | Novas adesões: chuva observada ativada e previsões opcionais desativadas. Seleção explícita de estações. |
| Legado | Preservar assinaturas e escolhas existentes; não migrar silenciosamente todos para um novo consentimento. |
| Notificações | Manter Web Push/VAPID; persistir eventos e entregas pendentes no próprio D1. |
| Consultas | Continuar sem polling de rede em aba parada. Atualização manual e carregamentos motivados por navegação/filtros. |
| Escopo territorial | Quatro estações configuradas em Ijuí/região; previsão Open-Meteo continua regional nas coordenadas atuais. |

## Limites de escopo

Fazem parte da entrega: hierarquia visual, experiência móvel, semântica dos dados, estados de erro e vazio, internacionalização dos fluxos alterados, acessibilidade, preferências de alertas, robustez do detector, entrega com recuperação limitada, service worker, deep links, testes e documentação operacional.

Ficam para evolução posterior: contas, aplicativo nativo, WhatsApp/SMS/e-mail, mapas de radar, geolocalização obrigatória, novas fontes meteorológicas, previsão por estação, machine learning, notificações de fim de chuva, horários de silêncio, painel administrativo, analytics de terceiros e troca de framework. Nenhum deles é necessário para executar este plano.

O histórico de eventos de chuva será persistido para confiabilidade e suporte. Uma central pública de notificações não é requisito da primeira entrega. A interface pode mostrar o início do episódio atual quando esse dado existir, sem inventar um horário para episódios anteriores à implantação.

## Ordem e critérios de saída

| Marco | Lotes | Evidência exigida |
|---|---|---|
| Base reproduzível | E0 | Dependências, build e testes de referência registrados; falhas preexistentes separadas. |
| Dados e detector corretos | E1–E3 | Última leitura correta, dados ausentes preservados, eventos atômicos e testes de concorrência. |
| Entrega e preferências | E4–E5 | Retentativas limitadas, filtragem por estação/tipo, compatibilidade com assinaturas legadas. |
| Dashboard e experiência push | E6–E8 | Layout responsivo, fluxos completos, idiomas e clique da notificação funcionando. |
| Qualidade e preparação de publicação | E9 | Matriz de testes, evidências visuais e roteiro de implantação/retorno completos. |

O produto só estará concluído quando a interface e o caminho completo `observação → evento → destinatário → push → estação no dashboard` tiverem sido verificados. Um layout com dados fictícios, testes apenas com mocks ou um POST aceito pelo provedor push, isoladamente, não comprovam essa conclusão.

## Restrições herdadas que devem sobreviver

- `DISABLE_ROLLUPS`, `DISABLE_ALERTS` e `READ_ONLY_EMERGENCY` continuam funcionando.
- Os caminhos de leitura continuam usando tabelas materializadas e rollups.
- O coletor continua genérico, configurável, tolerante a falhas parciais e sem segredos no frontend.
- O identificador de estação é o `location.id`, por exemplo `ijui-iiJu2`, não o código externo `IIJU2`.
- Não alterar migrations `0001` a `0009` já existentes; adicionar novas migrations.
- Não usar `/api/push/test` em produção para validar a interface: esse endpoint atualmente envia para todos os inscritos.
- Esta entrega autoriza somente documentação. Publicação, migrations remotas e disparos reais não foram executados nem solicitados nesta etapa.
