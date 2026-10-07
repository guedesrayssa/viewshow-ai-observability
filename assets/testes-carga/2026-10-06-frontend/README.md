# Frontend — coleta sequencial de 06/10/2026

A análise está em [Testes de carga finais do frontend](../../../artefatos/sprint5/testes-carga-finais-front.md).
Esta rodada usa Apple M5/16 GiB, Node 24.19.0, serve 14.2.5 sem request logging,
Autocannon 8.0.0, Lighthouse 13.5.0 e Chrome for Testing 153.0.8010.36.
Não compare diretamente seus valores ao host Windows, logging e auditor de 05/10.

| Arquivo | Evidência |
| --- | --- |
| `environment.json` | Revisão, host, SHA-256 de cada arquivo da exportação, fingerprint do pacote, PID do servidor e cronologia dos quatro perfis |
| `static-smoke.json` | 2 conexões, 15 s; MIME/corpo por resposta e hash de preflight contra exportação |
| `static-load.json` | 50 conexões, 60 s; todos os thresholds aprovados |
| `static-spike.json` | 200 conexões, 30 s; todos os thresholds aprovados neste leito |
| `static-load-recovery.json` | 50 conexões, 60 s; começa 0,424 s depois do pico, sem sleep/reinício |
| `lighthouse-executions.json` | Seis intervalos não sobrepostos; revisão, versão, configuração e hash de cada relatório |
| `lighthouse-{desktop,mobile}-{1,2,3}.json` | Relatórios completos, com métricas principais finitas e nenhuma auditoria em estado de erro |

Os 28 recursos Next.js e sete HTMLs foram comparados com os arquivos do build.
Todos os callbacks verificaram o conteúdo das respostas concluídas. O mesmo
servidor, PID 55713, permaneceu vivo durante a bateria. O runner Lighthouse
terminou cada Chrome/perfil antes de abrir o seguinte; Autocannon começou
depois de terminar todas as auditorias.

Os relatórios de Lighthouse 12.8.2 que retornaram `NO_LCP` foram descartados
como amostras inválidas e não aparecem nesta pasta. O auditor 13.5.0 ainda
emitiu diagnóstico interno do trace engine, mas os seis LHR possuem FCP, LCP,
Speed Index, TBT e CLS finitos, sem auditorias com erro ou warnings no LHR.

Reprodução em `apps/frontend`, Node 22.19+, servidor do build já iniciado:

```bash
LIGHTHOUSE_URL=http://127.0.0.1:4173/login/ RESULTS_DIR=../../assets/testes-carga/<data>-frontend npm run loadtest:lighthouse
BASE_URL=http://127.0.0.1:4173 OUT_DIR=out SERVER_PID=<pid> RESULTS_DIR=../../assets/testes-carga/<data>-frontend npm run loadtest:battery
```

Não execute as etapas em paralelo. Configure `CHROME_PATH` quando necessário.
São medições locais de entrega estática e `/login/`, não de experiência
autenticada, API, CDN ou séries de Grafana em produção.
