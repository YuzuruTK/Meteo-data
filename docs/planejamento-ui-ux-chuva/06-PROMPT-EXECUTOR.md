# 06 — Prompt para entregar ao modelo executor

Copie o conteúdo do bloco abaixo para uma nova sessão com acesso ao repositório. Ele orienta execução local; publicação e ações remotas dependem do escopo autorizado nessa sessão futura.

```text
Você vai executar a evolução do projeto Meteo-data usando o planejamento que já está no repositório.

Repositório: https://github.com/YuzuruTK/Meteo-data
Workspace original: C:\Users\Administrador\Desktop\meteo-data
Base auditada: main, 84b9552b1e2b83a66ac6d0ca1c6fcc3ff4ee7b91.

Objetivo: melhorar o frontend/UI/UX do dashboard existente e consolidar o diferencial de avisar quando o início da chuva é detectado nas estações escolhidas pelo usuário. Aproveite a implementação atual. Não recrie o produto nem mude a stack.

Leia integralmente, nesta ordem:
1. docs/planejamento-ui-ux-chuva/README.md
2. docs/planejamento-ui-ux-chuva/01-DIAGNOSTICO.md
3. docs/planejamento-ui-ux-chuva/02-ESPECIFICACAO-UI-UX.md
4. docs/planejamento-ui-ux-chuva/03-ESPECIFICACAO-CHUVA-PUSH.md
5. docs/planejamento-ui-ux-chuva/04-PLANO-EXECUCAO.md
6. docs/planejamento-ui-ux-chuva/05-VALIDACAO-E-ROLLOUT.md
7. docs/planejamento-ui-ux-chuva/07-REGISTRO-DE-EXECUCAO.md

Confira AGENTS.md/instruções aplicáveis, git status e diferenças entre a base atual e a auditada. Preserve alterações do usuário. Atualize o diagnóstico quando encontrar divergência real; não siga uma referência antiga cegamente.

Contexto essencial:
- Já existem Cloudflare Workers + Cron de 5 minutos + D1, coletor genérico, última observação materializada e rollups.
- Já existe Vite + React 18 + Recharts + PWA, Web Push/VAPID, detector de início de chuva e alertas separados de previsão.
- /api/summary já existe e deve alimentar condições atuais. Agregados horários continuam para histórico.
- Hoje o detector trata null como seco, não recebe observed_at e não tem persistência atômica de evento/entrega. Corrija os casos previstos no contrato.
- O SW descarta metadata de estação; a inscrição não possui preferências e o envio é global. Evolua esses módulos.
- O frontend tem guardas de requisição que podem perder trocas de filtro. Corrija com cancelamento/identificação de requests, sem polling periódico.
- Existem pt-BR/en/es e provider próprio; reaproveite e migre traduções de forma controlada.

Regras obrigatórias:
1. Preserve stack, hospedagem, coletor configurável, segredos e otimizações D1.
2. Mantenha DISABLE_ALERTS, DISABLE_ROLLUPS e READ_ONLY_EMERGENCY.
3. Não altere migrations já existentes. Adicione migrations aditivas e prove instalação/upgrade local.
4. Não infira tempo seco de null, atraso ou ausência de leitura. Não prometa instante exato da chuva nem entrega garantida em 5 minutos.
5. Não reenvie chuva contínua a cada cron. Implemente episódios, rebaseline, persistência atômica, outbox e retry limitado definidos em 03.
6. Preserve assinaturas legadas e aplique preferências por estação/tipo; forecast não pode ser enviado para quem só escolheu chuva observada.
7. Nunca exponha chaves privadas, endpoints de assinatura ou token de controle em bundle/log/URL pública.
8. Não use /api/push/test para testar um único usuário: atualmente ele envia para todos. Implemente/teste a alternativa direcionada em ambiente isolado.
9. Não substitua dados reais por mocks em produção, nem mude framework/banco para facilitar a tarefa.
10. Registre resultados reais: testes SQLite skipped não equivalem a aprovação; mock de push não equivale a recebimento no aparelho.

Execute E0 a E9 conforme dependências. Faça checkpoints pequenos e verificáveis; em cada um, registre o que mudou, por quê, como foi testado e o que falta em 07. Não execute somente a parte visual e declare o projeto concluído.

As decisões de produto já estão especificadas. Resolva detalhes rotineiros com base no código e no contrato. Se uma escolha precisar mudar por evidência técnica, registre a alternativa e o impacto antes de continuar. Pergunte apenas quando faltar uma decisão realmente necessária; avance nas partes independentes.

O planejamento anterior foi apenas estático e documental: não há testes/build/screenshots comprovados nele. Comece pela reprodução E0; não herde resultados fictícios.

Implemente e valide localmente tudo que estiver autorizado nesta sessão. Prepare uma entrega revisável com diffs, testes, evidências visuais, migrations e roteiro de implantação. Não publique, aplique migrations remotas, dispare mensagens reais para terceiros ou mescle PRs sem autorização correspondente. Não é necessário parar para pedir confirmação de decisões já cobertas por este plano.

Na entrega final, informe resultado concreto, validação realizada, limitações verificadas e links para arquivos/evidências. Mantenha o registro pronto para continuidade por outro modelo.
```

## Prompt de retomada após interrupção

```text
Continue a execução do plano em docs/planejamento-ui-ux-chuva/.
Leia primeiro 07-REGISTRO-DE-EXECUCAO.md, git status e os diffs locais.
Confira a última evidência e o próximo lote pendente; não refaça alterações concluídas nem descarte trabalho local.
Releia os contratos 02/03 e a matriz 05 relevantes ao lote atual.
Se houver testes ou decisões registrados sem evidência, valide antes de confiar.
Continue até concluir o escopo autorizado, atualizando o registro a cada checkpoint.
```
