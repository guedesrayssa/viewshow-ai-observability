# Evidências brutas — testes de carga em AWS, 11/09/2026

&emsp; Primeira bateria da API TypeScript executada **na nuvem** com bruto
versionado. Substitui o relato sem evidência de `609b822` (ver
[`artefatos/testes-carga-inicial.md`](../../../artefatos/testes-carga-inicial.md) §8.7)
e é o contraste direto com o leito local de
[`2026-09-11/`](../2026-09-11/README.md).

&emsp; Cada `resumo-*.json` é a saída de `handleSummary()` de um `k6 run` real;
cada `metadados-*.json` registra comando (segredo redigido), início e fim em
UTC, duração, `exit code`, versão do k6, commit, ambiente e o resultado de cada
threshold. Os dois foram gravados pelo runner
[`loadtest/k6/bateria.sh`](../../../apps/backend/api/loadtest/k6/bateria.sh).

## Ambiente

| Item | Valor |
| --- | --- |
| Aplicação | `apps/backend/api` em **ECS Fargate**, 1 vCPU / 2.048 MB, **1 task** |
| Entrada | ALB `g05-s3-alb` (`g05-s3-alb-2121584483.us-east-1.elb.amazonaws.com:80`) |
| Imagem | `798295516003.dkr.ecr.us-east-1.amazonaws.com/g05-s3-api:d70e2f4f01b4` (`linux/amd64`) |
| Persistência | DynamoDB `g05-s3-operacional`, `PAY_PER_REQUEST`, GSI `trace-index` |
| Região / conta | `us-east-1` / `798295516003` (AWS Academy Learner Lab) |
| Gerador | k6 v2.2.0 **fora da AWS**, macOS arm64, tráfego pela internet pública |
| Limite de taxa | `RATE_LIMIT_PER_MINUTE=20000` na janela do teste (padrão de produção é 180) |
| Seed | `ALLOW_REMOTE_SEED=1 node scripts/seed-carga.cjs` (300 incidentes; 2.303 + 10 itens), ~07:31 UTC |
| Observabilidade | EC2 `t3.medium` `i-0686c7b5a2216a726` com Grafana, Prometheus, Loki, Tempo e Alloy |
| Janela | `2026-09-11T07:32:42Z` → `07:52:54Z` |

&emsp; **Uma task de propósito.** O Prometheus da EC2 raspa `/metrics`
**através do ALB**; com duas ou mais tasks cada scrape cairia numa task
diferente, cada uma com contadores próprios, e `rate()` interpretaria a
alternância como reset. Com uma task a série é coerente. O dashboard de
CloudWatch não sofre disso porque agrega no serviço.

## Rodadas

| Arquivo | Janela UTC | Requisições | Erro cliente | p95 (cliente) | Descartes | `exit` | Leitura |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `smoke` | 07:32:42→07:33:13 | 34 | 0% | 217,1 ms | 0 | 0 | sanidade aprovada, 53/53 checks |
| `load` | 07:33:13→07:37:16 | 13.199 | 1,11% | **34.648 ms** | 15.547 | **99** | **3 de 5 thresholds reprovados** — a rodada de referência do RNF14 |
| `breakpoint` | 07:37:17→07:43:24 | 9.633 | 0% | 10.482 ms | 14.653 | 0 | rampa 1→220 req/s; sem thresholds |
| `estresse` | 07:43:25→07:49:25 | 28.929 | 51,44% | 60.000 ms | 74.695 | 0 | 411 req/s; sem thresholds |
| `spike` | 07:49:26→07:52:46 | 21.240 | 63,07% | 59.880 ms | 37.032 | 0 | 1.000 req/s; sem thresholds |
| `auth-check` | 07:52:47→07:52:53 | 40 | — | 135,0 ms | 0 | 0 | **37/37 checks — RNF04 aprovado na AWS** |
| `ingestao-drenagem` | 07:52:53→07:52:54 | 1 | 100% | 123,0 ms | 0 | 107 | aborta em `setup()`: `503 FEATURE_UNAVAILABLE` |

&emsp; `exit=99` é threshold violado; `exit=107` é exceção de script (aqui, o
aborto deliberado do `setup()`).

### Thresholds da rodada `load`

| Threshold | Resultado |
| --- | --- |
| `http_req_duration{status:200} p(95)<2000` | **reprovado** — 34.648 ms |
| `http_reqs{status:200} rate>130` | **reprovado** — vazão útil não chegou lá |
| `http_req_failed rate<0.001` | **reprovado** — 1,11% (147 de 13.199) |
| `checks rate>0.99` | ok |
| `rate_limited_rate rate<0.001` | ok — zero 429, o teto elevado funcionou |

&emsp; Distribuição de latência do `load`: p50 **11.126 ms**, p90 20.844 ms,
p95 34.648 ms, máximo 60.003 ms. O máximo é o **timeout de 60 s do cliente k6**,
não uma resposta da API.

## Leitura: erro de cliente ≠ erro de servidor

&emsp; O lado cliente contou 14.881 falhas no `estresse` e 13.397 no `spike`,
mas o servidor registrou no máximo **2,16 erros/s** em toda a janela. A
diferença são **timeouts**: a API não recusou, ela enfileirou até o cliente
desistir em 60 s. `http_requests_in_flight` chegou a **1.311 requisições
simultâneas**.

&emsp; Dos 2.117 logs com status ≥ 400 na janela, **2.080 são `503` em
`/api/v1/monitoring/overview`** — o snapshot de projeção envelhecendo para fora
da janela de 15 min ao longo de uma bateria de 20 min, comportamento que o
próprio `seed-carga.cjs` avisa e que não é falha da API. Os 401 restantes são o
`auth-check` exercitando o RNF04. **Não houve erro inesperado de servidor.**

## Séries do Prometheus (`prometheus/`)

Respostas de `query_range` da instância da EC2, janela
`2026-09-11T07:32:00Z` → `07:54:00Z`, passo 15 s — a mesma dos painéis.

| Arquivo | Faixa medida | Consulta |
| --- | --- | --- |
| `latencia-p95.json` | 0,089 s → **24,943 s** | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{job="view-show-api",status_code="200"}[5m])))` |
| `throughput.json` | 0,098 → **58,46 req/s** | `sum(rate(http_requests_total{job="view-show-api",status_code="200"}[5m]))` |
| `erros-por-segundo.json` | 0 → **2,159/s** | `sum(rate(http_requests_failed_total{job="view-show-api"}[5m]))` |
| `erros-por-segundo-por-status.json` | só `503` tem valor; 401 e 404 em zero | `sum by (status_code) (rate(http_requests_failed_total{job="view-show-api"}[5m]))` |
| `cpu.json` | 0,219% → 139,65% | `100 * (rate(view_show_process_cpu_user_seconds_total{job="view-show-api"}[5m]) + rate(view_show_process_cpu_system_seconds_total{job="view-show-api"}[5m]))` |
| `inflight.json` | 0 → **1.311** | `max(http_requests_in_flight{job="view-show-api"})` |
| `targets.json` | 5 de 5 `up` | `GET /api/v1/targets?state=active` |

&emsp; **Throughput nunca alcançou os 137 req/s pedidos** — o teto observado foi
58,46 req/s. Essa é a capacidade real de uma task de 1 vCPU neste desenho.

&emsp; **Sobre o `cpu.json`:** é `process_cpu_*` do `prom-client`, que conta
tempo de CPU do processo e passa de 100% ao somar threads; **não** é a
utilização da task. O número autoritativo é o `CPUUtilization` do CloudWatch,
no dashboard `View Show — AWS`: o serviço **fixou em 100%** entre 07:33 e 07:49
(média por minuto chegando a 99,9%).

&emsp; **Buckets de latência.** Esta bateria já roda com o histograma estendido
até 60 s (`src/observability/metrics.ts`). Com o teto anterior de 10 s o p95 do
Prometheus teria travado em platô e o painel mostraria 10 s no lugar dos 24,9 s
medidos.

## Comparação com o leito local

| Medida (carga de 137 req/s) | Local (`2026-09-11/`) | **AWS (aqui)** |
| --- | ---: | ---: |
| p95 `status:200` | 8,95 ms | **34.648 ms** |
| Vazão útil | 133,12 req/s | **< 58,5 req/s** |
| Erro inesperado | 0% | 1,11% |
| Descartes do gerador | 0 | 15.547 |
| Thresholds | 5 de 5 ✓ | **2 de 5** |

&emsp; O leito local media o código; esta bateria mede o sistema. A diferença de
**três ordens de grandeza** no p95 é a razão pela qual RNF09 e RNF14 não podiam
ser aprovados a partir do leito local.

## Séries do CloudWatch (`cloudwatch/`)

Saída de `aws cloudwatch get-metric-statistics`, janela
`2026-09-11T07:30:00Z` → `07:56:00Z`, período de 60 s.

| Arquivo | Métrica | Medido |
| --- | --- | --- |
| `ecs-cpu.json` | `AWS/ECS CPUUtilization` | média até **99,89%**, máximo **100%** |
| `ecs-memoria.json` | `AWS/ECS MemoryUtilization` | média até 40,47%, máximo 52,81% |
| `alb-request-count.json` | `RequestCount` | 73.229 no total |
| `alb-target-2xx.json` | `HTTPCode_Target_2XX_Count` | 42.645 |
| `alb-target-5xx.json` | `HTTPCode_Target_5XX_Count` | 2.073 |
| `alb-elb-5xx.json` | `HTTPCode_ELB_5XX_Count` | **25.118** (pico de 5.000 em um minuto) |
| `alb-target-response-time.json` | `TargetResponseTime` p50/p95/p99 | 17,01 s / **52,76 s** / 58,37 s (máximos) |
| `dynamodb-read-throttle.json` | `ReadThrottleEvents` | **zero pontos — throttling não ocorreu** |

&emsp; CPU saturada, memória com folga e banco sem throttling: o gargalo desta
configuração é **CPU da task**.

## Alertas

&emsp; `prometheus/alertas-disparados.json` é a série `ALERTS{alertstate="firing"}`
na janela. Três regras dispararam:

| Alerta | `for:` | Disparou | Observação |
| --- | ---: | --- | --- |
| `ViewShowIncidentQuerySlow` | 5m | `07:39:30Z` | ~6 min 17 s após o início do `load` |
| `ViewShowApiTargetDown` | 2m | `07:47:30Z` | alvo saiu do ar sob `estresse` |
| `ViewShowApiHighErrorRate` | 5m | `07:48:00Z` | — |

## Capturas

| Arquivo | O que mostra |
| --- | --- |
| `grafana-aws-01-api-red.png` | `View Show — API (RED)`: os quatro indicadores da rubrica com dado da nuvem |
| `grafana-aws-02-application-observability.png` | latência p95 por rota, request rate, memória do Node e o painel **Firing alerts** |
| `grafana-aws-03-cloudwatch-e-logs.png` | `View Show — AWS` rolado até `API — logs recentes`, com JSON real da API via CloudWatch |

&emsp; Duas ressalvas sobre as capturas, para que ninguém leia mais do que elas
mostram. O eixo de tempo está em **horário local (UTC−3)**: 04:33–04:49 na
imagem é 07:33–07:49 UTC. E na terceira captura os painéis `ALB — requisições e
respostas 5xx` e `DynamoDB — throttling` aparecem como **No data**: para o
DynamoDB esse é o valor correto (não houve throttling), mas para o ALB não é — a
consulta exata daquele painel, executada contra o mesmo Grafana pela API dele,
devolve os 73.233 pontos de `RequestCount` e os 2.073 de
`HTTPCode_Target_5XX_Count` registrados em `cloudwatch/`. A causa do "No data"
no instante da captura não foi determinada. O dashboard `View Show — API (RED)`
foi publicado na instância pela API do Grafana porque o `user-data` da EC2 não o
provisionava; a correção está no IaC e vale a partir do próximo `apply`.

## Redação de credenciais

&emsp; O k6 serializa o retorno de `setup()` em `setup_data`, e os scripts
forjam ali um cookie de sessão assinado. Em todos os `resumo-*.json` o campo
aparece como `<redigido: cookie de sessão>`, e em todos os `metadados-*.json` o
valor de `-e AUTH_COOKIE_SECRET=` aparece como `<segredo>`. A redação acontece
no `handleSummary()` dos scripts e no `bateria.sh`, então a evidência nasce sem
credencial em vez de ser saneada depois.
