# Testes de carga — apps/backend/api

Suíte k6 da API operacional. A análise dos resultados está em
[`artefatos/sprint5/testes-de-carga-da-api.md`](../../../../artefatos/sprint5/testes-de-carga-da-api.md) e os
brutos de cada execução em [`assets/testes-carga/`](../../../../assets/testes-carga/README.md). Este README cobre
como executar e como interpretar.

## Conteúdo

| Arquivo | Para quê | Status |
| --- | --- | --- |
| `k6/front-api.js` | **Cenário principal.** Carga mista nas rotas de leitura que o painel consome, com perfis smoke, load, soak, breakpoint, spike e stress | Em uso |
| `local.sh` | Roda o cenário principal em um ambiente local descartável (DynamoDB Local em Docker, seed e API) | Em uso |
| `run-aws.mjs` | Roda o cenário principal contra a stack da AWS a partir desta máquina | Em uso |
| `scripts/backup-table.cjs`, `scripts/undo-remote-seed.cjs` | Backup completo da tabela e desfazer de um seed remoto | Em uso |
| `scripts/ensure-local-table.cjs` | Cria a tabela no DynamoDB Local (usado por `local.sh`) | Em uso |
| `../scripts/seed-carga.cjs` | Popula incidentes, evidências, hipóteses e projeções no DynamoDB | Em uso |
| `k6/auth-check.js` | RNF04: controle de acesso rota a rota (uma iteração) | Roda; hoje reprova 14 de 37 checks, porque as rotas de leitura respondem sem sessão |
| `k6/consultas.js`, `k6/rodadas.sh`, `k6/bateria.sh` | Suíte anterior (RNF14/RNF09, taxa alvo de 137 req/s) e seus runners | Legada; o cenário de monitoramento exige 200 e a rota hoje responde 503 |
| `k6/ingestao-batch.js` | RNF01, RNF02, RNF03 e RNF09: modos `smoke`, `drenagem`, `pico`, `limite` e `frescor` da Sprint 5 (upload multipart real até `READY`) | Em uso contra a stack da AWS (exige usuário Cognito e massa de dados) |
| `k6/ingestao-falhas.sh` | Injeção e reversão das falhas RS-01 a RS-05, métricas SQS e geração do dump corrompido M-07 | Em uso, com sessão válida do Learner Lab |
| `k6/lib/session.js`, `k6/lib/asserts.js` | Sessão (login real ou cookie forjado), `X-Request-Id` e checks de conteúdo | Compartilhados |

## O cenário principal

O painel é um site estático: todo o trabalho de servidor que ele causa é HTTP contra esta API. O cenário
`front-api.js` sorteia uma rota por iteração, com os pesos abaixo, que são uma estimativa e não uma
medição (quando houver tráfego real, derive-os de `http_request_duration_seconds` em `/metrics`).

| Rota (tag) | Chamada | Peso |
| --- | --- | ---: |
| `incidents_list` | `GET /api/v1/incidents?window=24h` e variantes com filtros | 24% |
| `incidents_chart` | `GET /api/v1/incidents?window=1h&chartMetric=affected_devices` | 8% |
| `dashboard_overview` | `GET /api/v1/dashboard/overview` | 16% |
| `incident_diagnosis` | `GET /api/v1/incidents/:id/diagnosis` | 16% |
| `incident_events` | `GET /api/v1/incidents/:id/events` | 10% |
| `global_events` | `GET /api/v1/events` (lista com `limit=50` e agregado com `limit=1`) | 10% |
| `monitoring_overview` | `GET /api/v1/monitoring/overview` | 7% |
| `auth_session` | `GET /auth/session` | 4% |
| `rum_beacon` | `POST /api/v1/telemetry/rum` (única escrita) | 4% |
| `argus_integration` | `GET /api/v1/integrations/argus` | 1% |

O cenário reproduz o cliente real em três pontos: timeout de 8 s por requisição (o painel desiste nesse
prazo, então é falha), validação do envelope `{data, meta}` que o painel exige e paginação por cursor na
lista de eventos, a única tela que a usa. Não há login no Cognito, ingestão, reanálise nem importação:
a sessão é um cookie assinado preparado uma vez no `setup()`.

### Perfis e critérios

`RATE` é a taxa de chegada em iterações por segundo (cada iteração faz uma requisição; o modelo é aberto, então
a pressão não cai quando a API fica lenta).

| Modo | Perfil |
| --- | --- |
| `smoke` | 1/s por 30 s (ignora `RATE`) |
| `load` | rampa a `RATE` em 30 s, `RATE` por 5 min, saída em 15 s |
| `stress` | `RATE` por 1 min, rampa a 2 × `RATE`, 2 × `RATE` por 3 min, volta a `RATE` |
| `spike` | `RATE` por 1 min, rampa a 4 × `RATE` em 10 s, 4 × `RATE` por 30 s, volta a `RATE` |
| `breakpoint` | degraus de `BREAKPOINT_STEPS` (padrão 10, 20, 30, 40, 50, 75, 100, 150), cada um sobe em 10 s e segura 50 s |
| `soak` | `RATE` por `DURATION` (padrão 30 min) |

| Métrica | Smoke | Load e soak | Stress, spike e breakpoint |
| --- | --- | --- | --- |
| `checks` e sucesso do contrato | `==1` | `>0.999` | `>0.98` |
| `http_req_failed` (503 só conta como esperado no monitoramento) | `==0` | `<0.001` | `<0.02` |
| p95 / p99 em `status:200`, global e por rota | < 2 s / < 5 s | idem | idem |
| Falha e contrato por rota | `==0` | `<0.02` | `<0.02` |
| 429 (exceto o beacon), timeouts de 8 s e iterações descartadas | `==0` | `==0` | `==0` |

Load e soak seguem o RNF09 (99,9%). O RNF14 pede 137 req/s (`RATE=137`).

## Executar localmente

Pré-requisitos: Docker, Node.js 22, k6 no `PATH` e as dependências npm de `apps/backend/api` instaladas. A
partir desta pasta:

```bash
./local.sh smoke                  # primeiro: curto e conservador
RATE=50 ./local.sh load
RATE=50 ./local.sh stress
RATE=50 ./local.sh spike
RATE=50 DURATION=30m ./local.sh soak
./local.sh breakpoint
```

Cada execução sobe um DynamoDB Local descartável, cria uma tabela isolada, semeia 300 incidentes, inicia a
API em loopback e remove o contêiner ao final; nada vai para a AWS. O resultado em JSON vai para
`results/` (ignorado pelo Git). O limite de taxa local é de 30.000 req/min (`API_RATE_LIMIT_PER_MINUTE` ajusta).

Os resultados locais medem esta máquina e o DynamoDB Local, não a AWS. Para aproximar a tarefa implantada,
limite a CPU da API (`docker run --cpus=0.25 --memory=512m` com a imagem da AWS apontando para o DynamoDB
Local; um exemplo está em
[`assets/testes-carga/2026-09-30-local/`](../../../../assets/testes-carga/2026-09-30-local/README.md)).

### Variáveis do cenário

| Variável | Padrão | Efeito |
| --- | --- | --- |
| `BASE_URL`, `MODE`, `RATE`, `DURATION` | `smoke`, 50, 30m | Alvo, perfil, taxa e duração do soak |
| `AUTH_COOKIE_SECRET` ou `AUTH_USERNAME` e `AUTH_PASSWORD` | | Cookie forjado (mesmo segredo da API, 32+ caracteres) ou login real no Cognito |
| `INCIDENT_COUNT` | 300 | Sorteia `inc-000001` a `inc-<INCIDENT_COUNT>` |
| `INCIDENT_IDS`, `WINDOW_OVERRIDE` | `synthetic` | `discover` lê os IDs na própria API (`window=all`) para medir um dataset real; `WINDOW_OVERRIDE=all` troca as janelas de incidentes e eventos |
| `MONITORING_EXPECTED` | `either` | `unavailable`, `available` ou `either`: quais respostas do monitoramento contam como sucesso |
| `FOLLOWUP_PROBABILITY` | 0,15 | Fração das listas de eventos que pedem a segunda página |
| `PREFLIGHT` | 1 | Confere massa e IDs antes da rodada; 0 desliga |
| `ROUTE_P95_MS`, `ROUTE_P99_MS` | 2000, 5000 | Limites por rota |
| `MAX_VUS` | taxa × 8 × 1,2 | Teto de VUs (veja "Dimensionar o gerador") |
| `BREAKPOINT_STEPS` | `10,20,30,40,50,75,100,150` | Degraus do breakpoint |
| `RESULTS_DIR` | `.` | Pasta do JSON de resumo |

## Interpretar o resultado

O sumário impresso mostra os thresholds reprovados, o resultado por rota, por fase (ou por degrau, no
breakpoint) e por status HTTP (0 é timeout ou erro de rede), seguido de observações. Antes de confiar numa
rodada, confira:

- **A carga pedida foi entregue.** O sumário avisa quando há iterações descartadas. Numa API lenta cada
  requisição fica presa até o timeout de 8 s e o k6 precisa de `taxa × 8` VUs para continuar emitindo; com
  menos, a carga efetiva fica abaixo da pretendida e a falha medida é um limite inferior. Cada VU custa
  cerca de 1 MB de RAM: uma máquina de 0,9 GB sustenta no máximo ~700 VUs.
- **O gerador não é o limite.** Acompanhe o CPU e a memória dele; na AWS, rode-o na mesma região da stack.
  De fora, a latência medida é majoritariamente rede (~150 ms contra ~20 ms de dentro da VPC).
- **No breakpoint, leia só até o primeiro degrau que falha.** Depois dele o serviço já está degradado (fila,
  tarefa reiniciada pelo health check do ALB).
- **As rotas fazem trabalho real.** O sumário sinaliza o monitoramento quando 100% das respostas são 503,
  e conta respostas parciais (`meta.partial`) e snapshots desatualizados (`STALE_SNAPSHOT`).
- **O volume de dados é realista.** O seed cria 300 incidentes. Incidentes, diagnóstico e overview carregam
  a projeção inteira (um item do DynamoDB) a cada requisição, então o custo cresce com o volume: de 300 para
  2.500 incidentes a CPU por requisição mais que dobrou. Para medir com mais dados, use
  `INCIDENTS_PER_HOUR=100 node scripts/seed-carga.cjs` e `INCIDENT_COUNT=2500`; o limite físico é o item de
  400 KB do DynamoDB.

### Limites conhecidos da API que o cenário evidencia

- `monitoring/overview` é um stub: responde sempre `503 DATA_UNAVAILABLE`. Quando a projeção existir, use
  `MONITORING_EXPECTED=available`.
- `GET /api/v1/incidents` devolve `hasMore=true` com `nextCursor=null`: a lista de incidentes não pagina. O
  contador `front_api_has_more_without_cursor_total` expõe o desvio.
- Com o seed, `events` volta com 0 itens (`SEED_EVENTS_NOT_MATERIALIZED`) e incidentes e diagnóstico com
  `meta.partial=true`. Cerca de 27% da mistura (eventos e monitoramento) toca rotas sem trabalho real.
- O limite de taxa (180 req/min por IP) é um teto para o gerador: acima dele o k6 mede o 429, não a API. O
  limitador do beacon de telemetria é fixo em 600/min e responde 429 sem contar como falha.

## Executar na AWS

1. **Conta.** O ID da conta muda a cada laboratório; use `aws sts get-caller-identity`.
2. **Dados.** O cenário precisa dos incidentes sintéticos. **Não semeie uma tabela que tenha dados
   ingeridos:** `seed-carga.cjs` com `ALLOW_REMOTE_SEED=1` grava `CONTROL#DATASET/ACTIVE` e troca o dataset
   ativo pelo sintético. Use uma stack isolada, ou tire antes um backup e desfaça depois:

   ```bash
   cd apps/backend/api
   export OPERATIONAL_TABLE_NAME=<tabela> AWS_REGION=us-east-1
   node loadtest/scripts/backup-table.cjs backup.json           # somente leitura
   ALLOW_REMOTE_SEED=1 node scripts/seed-carga.cjs              # sem CLEAN=1
   # ... testes ...
   node loadtest/scripts/undo-remote-seed.cjs backup.json           # ensaio
   node loadtest/scripts/undo-remote-seed.cjs backup.json --apply   # restaura o manifesto e apaga só o sintético
   ```

   Sem a massa sintética, o `PREFLIGHT` aborta com a causa em vez de reportar 100% de 404.
3. **Rate limit.** O padrão de 180 req/min vale para o gerador inteiro. Para taxas maiores, eleve-o só na
   janela do teste: `node apps/scripts/aws-learner-lab.mjs update loadtest-20000` e, ao final, `update baseline`
   (fluxo protegido; exige Linux ou macOS e que não haja `*.auto.tfvars` em `apps/fullstack`). Alternativa
   sem Terraform: registrar uma revisão da definição da tarefa com `RATE_LIMIT_PER_MINUTE` alto, apontar o
   serviço para ela e reverter ao final; isso gera drift no state e precisa ser desfeito.
4. **Gerador.** Da máquina local, `run-aws.mjs` confere a conta, espera a tarefa saudável e roda o cenário
   contra o API Gateway; ele aborta se o pico do perfil excede o limite da tarefa (`ALLOW_RATE_LIMITED=1`
   ignora):

   ```bash
   export EXPECTED_AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   MODE=smoke node run-aws.mjs
   MODE=load RATE=10 node run-aws.mjs
   TARGET=amplify MODE=smoke node run-aws.mjs   # entra pelo painel (salto do Amplify), com taxa baixa
   ```

   Para medir a capacidade, rode o k6 **dentro da VPC**, por exemplo no bastion via SSM (sem SSH): instale o
   k6 (`curl` do release no GitHub), copie `k6/front-api.js` e `k6/lib/` (tar, gzip e base64 em um
   `aws ssm send-command` com `AWS-RunShellScript`) e rode `k6 run -e BASE_URL=<api> -e MODE=... front-api.js`
   na instância. Leia o `AUTH_COOKIE_SECRET` da definição da tarefa pela própria instância, para o segredo
   não ficar no histórico do SSM. Ao final, remova o k6 e os arquivos.
5. **Correlacionar com CloudWatch.** Para atribuir um gargalo, colete por minuto, na janela do teste: ECS
   (`CPUUtilization`, `MemoryUtilization`), ALB (`RequestCount`, `HTTPCode_Target_5XX_Count`,
   `HTTPCode_ELB_5XX_Count`, `TargetResponseTime`, `HealthyHostCount`, `UnHealthyHostCount`), API Gateway
   (`Count`, `5xx`, `Latency`, `IntegrationLatency`) e DynamoDB (`ConsumedReadCapacityUnits`,
   `ReadThrottleEvents`). Veja também os eventos do serviço ECS e as atividades do autoscaling
   (`aws ecs describe-services`, `aws application-autoscaling describe-scaling-activities`).

O segredo de sessão fica em texto claro na definição da tarefa ECS (é de lá que `run-aws.mjs` o lê); quem
tem `ecs:DescribeTaskDefinition` consegue forjar sessões. O caminho correto é o bloco `secrets` com Secrets
Manager ou SSM. Com `AUTH_USERNAME` e `AUTH_PASSWORD` o `setup()` faz um login real no Cognito e não exige o
segredo.

## Autenticação

`k6/lib/session.js` decide no `setup()`: com `AUTH_USERNAME` e `AUTH_PASSWORD` faz `POST /auth/login` no
Cognito uma vez e usa o cookie emitido; com `AUTH_COOKIE_SECRET` forja o cookie localmente (HMAC, mesmo
algoritmo do `SessionCodec`). Nenhum dos dois mede o login sob carga. `GET /auth/login` e `/auth/callback`
(SSO federado) respondem `503 FEATURE_UNAVAILABLE` até o SSO corporativo ser configurado, o que não afeta
esses caminhos. As rotas de incidentes, dashboard, diagnóstico e monitoramento ignoram o cookie; só
`/auth/session`, eventos e a integração Argus o exigem.

## Outras suítes

```bash
# a partir de apps/backend/api: CLEAN=1 node scripts/seed-carga.cjs   (local; semeie imediatamente antes)
# a partir de apps/backend/api/loadtest/k6:
k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<segredo> -e MODE=smoke consultas.js
k6 run -e BASE_URL=http://localhost:3000 -e AUTH_COOKIE_SECRET=<segredo> auth-check.js
./rodadas.sh                  # bateria completa de consultas.js
```

`consultas.js` aceita `RATE` (padrão 137), `INCIDENT_COUNT` (300) e `STRESS_MULTIPLIER` (3), e login real no lugar
do cookie forjado; `ingestao-batch.js` também aceita login real, e `auth-check.js` usa só cookie forjado.
`ingestao-batch.js` aceita `MODE`, `DUMP` (arquivo `argus_dump.sql.gz` a enviar), `EXPECTED_EVENTS`, `RUN_LABEL`,
`ACTIVATE`, `PEAK_RATE` (50), `BURST_RATE` (20), `COOLDOWN_S` (60), `POLL_TIMEOUT_S` (3600) e
`T0`/`EXPECT_OBSERVED_THROUGH` (frescor). Ele não roda localmente: o upload usa URLs pré-assinadas do S3 e o
processamento é uma task ECS. Só existe uma importação ativa por vez (`409 IMPORT_IN_PROGRESS`), então rode os
modos em sequência. Como não há rota para cancelar uma importação, `pico` e `limite` concluem no teardown
somente a importação identificada como criada pelo teste.

A revisão do script exige `EXPECTED_EVENTS` em `MODE=drenagem` e um dump ainda não importado.
`ALLOW_IDEMPOTENT=true` é destinado à recuperação e exige `EXPECTED_VERSION` da primeira importação.
O limitador precisa gerar `429 RATE_LIMITED` na rajada; respostas 401/404, conflitos de outra importação,
qualquer 5xx fora de injeção e iterações descartadas reprovam os checks pertinentes. A recuperação aceita
GET 200 ou POST 409 com o mesmo `importId`, não qualquer status abaixo de 500.

Valide sem acessar a AWS com `node --test loadtest/tests/*.test.mjs` a partir de `apps/backend/api`.
Os gráficos do relatório podem ser regenerados, na raiz, por
`python apps/backend/api/loadtest/scripts/render-ingestion-evidence.py` (requer matplotlib).
O roteiro de cada teste está em
[`testes-carga-ingestao.md`](../../../../artefatos/sprint5/testes-carga-ingestao.md), Seção 11. `bateria.sh` roda uma
bateria de `consultas.js` gravando um `metadados-*.json` auditável em `assets/testes-carga/<data>-aws/`
(formato das evidências de 11/09/2026).

## Observabilidade

A pilha Grafana do projeto (Prometheus, Loki, Tempo, Alloy) está em
[`apps/fullstack/observability`](../../../fullstack/observability/README.md) e sobe com
`docker compose -f apps/fullstack/docker-compose.observability.yml up -d` (Grafana em
`http://127.0.0.1:3002`, Prometheus em `:9090`).

- **Métricas:** a API expõe `GET /metrics` quando `METRICS_ENABLED=true` (padrão). O alvo `view-show-api` do
  Prometheus aponta para `host.docker.internal:3000`; mantenha a API rodando no host.
- **Traces:** suba a API com `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` e cada requisição vira um span.
- **Logs:** a API grava `request_id` estruturado. O Alloy coleta logs de contêineres, não de processos no host;
  leia o stdout da API ou rode-a em contêiner.
- **Correlação:** cada requisição leva um `X-Request-Id` com prefixo (`k6-front-<modo>`, `k6-consultas-<modo>`,
  `k6-authcheck`, `k6-ingestao`).

## Documentos relacionados

- [Testes de Carga da API](../../../../artefatos/sprint5/testes-de-carga-da-api.md): análise dos resultados.
- [Testes de Carga e Resiliência da Ingestão](../../../../artefatos/sprint5/testes-carga-ingestao.md): `ingestao-batch.js` e `ingestao-falhas.sh`.
- [Índice de evidências](../../../../assets/testes-carga/README.md)
- [Testes de Carga e Observabilidade (Sprint 3)](../../../../artefatos/sprint3/testes-carga-inicial.md): RNFs e
  resultados da suíte anterior, mantido como registro histórico.
- [Suíte da Sprint 2](../../../../artefatos/sprint2/testes-carga/README.md): arquitetura anterior.
- [`apps/backend/api/README.md`](../README.md)
