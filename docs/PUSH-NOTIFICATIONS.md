# Alertas de chuva e Web Push

O aviso de início significa uma transição entre uma leitura seca recente e uma leitura com taxa ≥ 0,1 mm/h. Não representa a primeira gota física nem uma previsão. As estações são consultadas a cada cinco minutos; entrega depende da fonte, navegador, conexão e sistema operacional.

## Detector e entrega

- Bootstrap e recuperação após mais de 15 minutos sem leitura válida são silenciosos.
- Null, taxa inválida, data repetida, leitura com mais de 15 minutos ou mais de dois minutos no futuro não abrem episódios.
- Duas leituras secas distintas, separadas por pelo menos cinco minutos, rearmam o detector. Uma leitura seca isolada não cria novo episódio.
- Estado e evento são gravados no mesmo `D1.batch`, com versão otimista e token da transição vencedora.
- Eventos simultâneos formam um lote. Preparação de destinatários usa páginas de 100 e cursor persistido; cada dispositivo recebe somente suas estações.
- Drenagem processa até 50 entregas/ciclo, com concorrência 10, lease de 90 segundos e timeout cancelável de transporte de 20 segundos. A coleta falhar não impede a tentativa de drenar pendências.
- Máximo de três tentativas, separadas por pelo menos cinco minutos, respeitando `Retry-After`. Evento expira 15 minutos após a observação, sem reiniciar o TTL. Leitura seca posterior, falta de frescor ou preferência removida cancelam o envio.
- 404/410 removem assinatura; 400/401/403 encerram aquela entrega sem apagar assinaturas em massa. Erros persistidos não contêm endpoints.
- Pode haver duplicação se o provedor aceitar e o processo cair antes do ACK no D1. Tags estáveis e `renotify:false` reduzem repetição visível; não há garantia exactly-once.

## Assinatura por dispositivo

A UI apresenta as escolhas antes de pedir permissão. Novas assinaturas ativam somente chuva observada; previsões são opcionais. Preferências do gráfico não alteram as de notificações.

V2 usa `version:2`, endpoint/chaves do navegador, `controlToken` aleatório de 32 bytes em base64url e `preferences`:

```json
{"stationScope":"selected","stationIds":["ijui-iiJu3"],"rainStart":true,"rainForecast":false,"temperatureForecast":false,"locale":"pt-BR"}
```

O cliente persiste a capacidade antes do POST; o servidor guarda somente SHA-256. Perda de resposta permite repetição idempotente. Status só aparece ativo após confirmação remota. Perda da capacidade exige renovar a assinatura pelo navegador, sem recuperar acesso apenas com endpoint.

Assinaturas antigas permanecem com todas as estações/tipos e inglês. Promoção exige posse das mesmas chaves da assinatura antiga. Após promoção, clientes antigos não podem sobrescrever preferências nem cancelar sem capacidade. Preferências são um documento JSON validado, substituído atomicamente; esta escolha evita uma tabela de relacionamento para o pequeno catálogo atual e é reavaliável se a audiência exigir consultas por estação.

| Rota | Contrato |
| --- | --- |
| `GET /api/push/public-key` | Chave pública, versão e flag `paused`; 503 se indisponível. |
| `POST /api/push-subscribe` | Legado ou v2; v2 retorna ID opaco e preferências confirmadas. |
| `POST /api/push/status` | Endpoint/ID + bearer; legado pode apresentar endpoint e chaves correspondentes para exibir escolhas antes da promoção. |
| `POST /api/push/preferences` | Endpoint/ID + bearer + preferências completas. |
| `POST /api/push-unsubscribe` | Endpoint/ID + bearer para v2; idempotente. Legado mantém contrato antigo. |
| `POST /api/push/test-device` | Endpoint/ID + bearer; somente aquele dispositivo, uma vez/minuto. |
| `POST /api/push/test` | Endpoint administrativo antigo, protegido pelo segredo; broadcast. Não é usado pela interface. |

Mutações rejeitam origem estrangeira, corpos acima de 16 KiB, chaves malformadas e destinos fora dos provedores push permitidos. Registro com `CF-Connecting-IP` tem orçamento de 20/hora por hash temporário. Testes direcionados e chuva usam transporte com redirects bloqueados. Nenhum segredo deve entrar em URL, log ou bundle.

## VAPID e operação

Preservar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` e `VAPID_SUBJECT` existentes nos bindings/segredos do Worker. Não rotacionar chaves durante este upgrade sem necessidade: assinaturas existentes dependem delas. Usar um par exclusivo para homologação.

Aplicar migrations 0010 e 0011 antes de publicar este código. `DISABLE_ALERTS=true` interrompe o pipeline antes de leituras de alertas. `RAIN_ALERT_DELIVERY_MODE=shadow` persiste eventos shadow e suspende transporte de chuva e previsão; lotes shadow nunca são convertidos para live. Default é live. Para validar, usar ambiente isolado e somente dispositivos de teste, começando em shadow.

Resultados de entregas ficam por sete dias; eventos por 30 dias, com limpeza limitada e indexada. O forecast mantém o mecanismo anterior de deduplicação, agora com filtragem de tipos/idioma e leitura paginada de assinaturas; a recuperação durável é específica da chuva observada.

O service worker preserva tag e metadados, rejeita URLs externas e aguarda navegação antes de focar uma aba. Seu precache contém o shell, não respostas meteorológicas. O clique abre a estação ou o subconjunto de estações do aviso. Payload recebido depois da expiração é identificado como aviso anterior.

## Validação e implantação

Ver [registro de execução](planejamento-ui-ux-chuva/07-REGISTRO-DE-EXECUCAO.md) e [evidências](evidence/README.md). Testes de transporte simulados não demonstram recebimento no aparelho. Homologar Chromium, Firefox, Android real e iOS/PWA antes de produção. O PR não executa deploy, migrations remotas ou envio real.

Rollback: cortar com `DISABLE_ALERTS=true`; manter schema aditivo. Não reativar um Worker antigo que ignore preferências v2. Na retomada, pendências vencidas expiram e lacunas exigem nova referência silenciosa.
