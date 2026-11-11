# Evidências locais

Capturas de Chromium headless com APIs interceptadas por fixtures de teste. Nenhuma fixture é usada pelo dashboard em produção. Os testes reproduzíveis estão em `dashboard/e2e/dashboard.spec.ts`.

- [Desktop 1440 px](dashboard-1440.png)
- [Mobile 320 px](dashboard-320.png), [360 px](dashboard-360.png)
- [768 px](dashboard-768.png), [1024 px](dashboard-1024.png)
- [Sem chuva](dashboard-dry.png), [leitura atrasada](dashboard-stale.png), [chuva nula](dashboard-null.png)
- [Histórico/previsão indisponíveis](dashboard-maintenance.png)
- [Ativação confirmada](push-active.png), [ativação pendente](push-pending.png)

Permissão negada aparece nas capturas responsivas. Nos dois cenários de ativação, a API do navegador e o servidor são simulados; isso valida a lógica visual, não recebimento real. Testes também verificam ausência de overflow, teclado, texto ampliado em 200%, três idiomas, navegação e ausência de polling após avanço do relógio em 20 minutos.

Screenshots foram inspecionados visualmente em desktop/mobile. Firefox, Android e iOS físicos e entrega pelo provedor ainda precisam de homologação isolada.
