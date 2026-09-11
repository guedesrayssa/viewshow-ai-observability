# Evidências brutas — testes de carga e observabilidade, 11/09/2026

Pasta de evidências da rodada consolidada em
[`artefatos/sprint3/testes-carga-inicial.md`](../../../artefatos/sprint3/testes-carga-inicial.md).
Nada aqui é template: cada `resumo-*.json` é a saída de `handleSummary()` de um
`k6 run` real, e cada `metadados-*.json` registra o comando, as datas UTC de
início e fim, a duração, o `exit code`, a versão do k6, o commit, o ambiente e o
resultado de cada threshold daquela execução.

## Ambiente comum a todas as execuções

| Item              | Valor                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| Código            | branch `feat/teste-de-carga` após o merge de `origin/develop` (`238ccec`)            |
| Janela            | `2026-09-11T05:28:00Z` → `05:57:00Z`                                                 |
| Gerador           | k6 v2.2.0 (`commit/00a9a1b7f5`, go1.26.5, darwin/arm64)                              |
| Host              | macOS 25.6.0 arm64; gerador e API na **mesma** máquina (origem única)                |
| API               | `node dist/index.js` (Node v26.3.0) direto no host — sem contêiner, sem limite de CPU |
| Persistência      | DynamoDB Local `127.0.0.1:18000` (`-inMemory -sharedDb`, JVM `-Xmx3g`)               |
| `BASE_URL`        | `http://127.0.0.1:3000`                                                              |
| Seed              | `CLEAN=1 node scripts/seed-carga.cjs` (300 incidentes; 2.303 + 10 itens) antes de cada rodada |
| Pilha de métricas | `docker compose -f apps/fullstack/docker-compose.observability.yml` (Prometheus v3.14.0, Grafana 13.2.1) |

## Resumos k6

| Arquivo                                             | Cenário                              | Limite de taxa | `exit` | Leitura                                                              |
| --------------------------------------------------- | ------------------------------------ | -------------: | -----: | -------------------------------------------------------------------- |
| `resumo-smoke.json`                                 | `consultas.js` `MODE=smoke`          |            180 |      0 | sanidade aprovada: 48/48 checks, sem 429 e sem erro                  |
| `resumo-load-limite-padrao.json`                    | `consultas.js` `MODE=load`           |            180 |     99 | **reprovada de propósito** — 97,06% de 429, mede o rate limiter      |
| `resumo-load-janela-controlada.json`                | `consultas.js` `MODE=load`           |        200.000 |      0 | rodada válida: 5 de 5 thresholds; 29.910 respostas, todas 200        |
| `resumo-breakpoint.json`                            | `consultas.js` `MODE=breakpoint`     |        200.000 |      0 | rampa 1→220 req/s, sem joelho; **o cenário não define thresholds**   |
| `resumo-spike.json`                                 | `consultas.js` `MODE=spike`          |        200.000 |      0 | rajada a 1.000 req/s; **sem thresholds**, ver `dropped_iterations`   |
| `resumo-estresse.json`                              | `consultas.js` `MODE=estresse`       |        200.000 |      0 | 411 req/s sustentados, zero erro; **sem thresholds**                 |
| `resumo-auth-check.json`                            | `auth-check.js`                      |            180 |      0 | **37/37 checks** — RNF04 aprovado nesta branch                       |
| `resumo-ingestao-drenagem.json`                     | `ingestao-batch.js` `MODE=drenagem`  |        200.000 |    107 | aborta em `setup()`: `503 FEATURE_UNAVAILABLE` (bloqueio por design) |

Um arquivo sobrevive de uma bateria anterior (04:15 UTC, contra `origin/develop`
puro, antes do merge desta branch), mantido porque documenta um limite do leito:

| Arquivo                                                  | `exit` | Leitura                                                          |
| -------------------------------------------------------- | -----: | ---------------------------------------------------------------- |
| `resumo-load-janela-controlada-tentativa1-ddb-caiu.json` |     99 | invalidada: o DynamoDB Local encerrou no meio (18.461 × HTTP 500) |

`exit=99` significa threshold violado; `exit=107` significa exceção de script
(aqui, o aborto deliberado do `setup()`).

**Redação de credenciais.** O k6 serializa o retorno de `setup()` em
`setup_data`, e os três scripts forjam ali um cookie de sessão assinado. Em
todos os `resumo-*.json` esse campo aparece como
`<redigido: cookie de sessão>`, e em todos os `metadados-*.json` o valor de
`-e AUTH_COOKIE_SECRET=` aparece como `<segredo>`. Os três scripts passaram a
fazer essa substituição no próprio `handleSummary()`, de modo que execuções
futuras já nascem sem credencial; os arquivos desta rodada foram saneados no
mesmo formato **sem tocar em nenhuma métrica, check ou threshold**.

## Séries do Prometheus (`prometheus/`)

Respostas de `GET /api/v1/query_range` da instância local, janela
`2026-09-11T05:28:00Z` → `2026-09-11T05:57:00Z`, passo 15 s — a mesma janela
das capturas do Grafana.

| Arquivo                            | Consulta PromQL                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latencia-p95.json`                | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="view-show-api",status_code="200"}[5m])))`                    |
| `throughput.json`                  | `sum(rate(http_requests_total{job="view-show-api",status_code="200"}[5m]))`                                                                        |
| `erros-por-segundo.json`           | `sum(rate(http_requests_failed_total{job="view-show-api"}[5m]))`                                                                                   |
| `erros-por-segundo-por-status.json`| `sum by (status_code) (rate(http_requests_failed_total{job="view-show-api"}[5m]))`                                                                  |
| `cpu.json`                         | `100 * (rate(view_show_process_cpu_user_seconds_total{job="view-show-api"}[5m]) + rate(view_show_process_cpu_system_seconds_total{job="view-show-api"}[5m]))` |
| `targets.json`                     | `GET /api/v1/targets?state=active` — os cinco alvos, todos `up`                                                                                    |

Recuperação por fase, com janela curta (`rate(...[30s])`, passo de 10 s), usada
na análise de resiliência do artefato:

| Arquivo                                  | Janela                          | Consulta                                                                                                                        |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `recuperacao-spike-p95.json`             | `05:46:00Z` → `05:49:40Z`       | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="view-show-api",status_code="200"}[30s])))` |
| `recuperacao-spike-throughput.json`      | `05:46:00Z` → `05:49:40Z`       | `sum(rate(http_requests_total{job="view-show-api",status_code="200"}[30s]))`                                                     |
| `recuperacao-estresse-p95.json`          | `05:50:00Z` → `05:56:30Z`       | mesma consulta de p95                                                                                                           |
| `recuperacao-estresse-throughput.json`   | `05:50:00Z` → `05:56:30Z`       | mesma consulta de throughput                                                                                                    |

## Capturas

| Arquivo                           | O que é                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `grafana-01-latencia-p95.png`     | painel 1 de `View Show — API (RED)`                                                                       |
| `grafana-02-throughput.png`       | painel 2 do mesmo dashboard                                                                               |
| `grafana-03-erros-por-segundo.png`| painel 3 do mesmo dashboard                                                                               |
| `grafana-04-cpu.png`              | painel 4 do mesmo dashboard                                                                               |
| `prometheus-targets.png`          | página `/targets` do Prometheus, filtrada em `view-show-api` (`1/1 up`)                                   |

As quatro imagens do Grafana foram renderizadas de
`GET /render/d-solo/view-show-api/...` sobre o JSON provisionado em
`apps/fullstack/observability/grafana/provisioning/dashboards/json/view-show-api.json`,
lendo o mesmo Prometheus da pilha. Como a imagem `grafana/grafana:13.2.1` é
Alpine/aarch64 e não roda o plugin de renderização embutido, a renderização usou
dois contêineres **temporários** (`grafana/grafana-image-renderer:3.12.9` e uma
segunda instância do mesmo Grafana apontada para ele), removidos em seguida; a
pilha do projeto não foi alterada. Os dados das séries são os mesmos do
Prometheus do projeto — as imagens não são mockups.
