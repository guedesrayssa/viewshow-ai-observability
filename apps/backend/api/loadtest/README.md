# Testes de carga — apps/backend/api

## Bateria do frontend (`k6/front-api.js`)

O painel (`apps/frontend`) é um export estático (Next.js `output: "export"`,
hospedado no Amplify) e "inteiramente client-side": todo o trabalho de servidor
que ele provoca é HTTP contra esta API. `k6/front-api.js` reproduz o padrão de
chamadas das telas contra a API — é um teste de carga **da API com o mix do
painel**, não do frontend em si (veja "O que esta bateria não mede").

| Tag da rota           | Chamada do painel                                                             | Peso |
| --------------------- | ----------------------------------------------------------------------------- | ---: |
| `incidents_list`      | Incidentes — `GET /api/v1/incidents?window=24h` (+ variantes com filtros)     |  24% |
| `incidents_chart`     | Incidentes, gráfico — `?window=1h&chartMetric=affected_devices`               |   8% |
| `dashboard_overview`  | Visão Geral — `GET /api/v1/dashboard/overview`                                |  16% |
| `incident_diagnosis`  | Evidências — `GET /api/v1/incidents/:id/diagnosis` (a tela chama duas vezes)  |  16% |
| `incident_events`     | Eventos de um incidente — `GET /api/v1/incidents/:id/events`                  |  10% |
| `global_events`       | Eventos — lista (`limit=50`) e agregado de volume (`limit=1`)                 |  10% |
| `monitoring_overview` | Monitoramento — `GET /api/v1/monitoring/overview`                             |   7% |
| `auth_session`        | Todas as telas, uma vez por carregamento — `GET /auth/session`                |   4% |
| `rum_beacon`          | Web Vitals/erros a cada visita — `POST /api/v1/telemetry/rum` (única escrita) |   4% |
| `argus_integration`   | Configurações — `GET /api/v1/integrations/argus`                              |   1% |

Os pesos são uma estimativa da equipe, não uma medição de produção. Quando
houver tráfego real, derive-os de `http_request_duration_seconds` em `/metrics`.

**Fidelidade ao frontend** (`apps/frontend/lib/data/client.ts`): timeout de 8 s
por requisição — acima disso o painel desiste e mostra o bloco como
indisponível, então aqui é falha (`front_api_client_timeout_total`); um 200 só
conta se trouxer o envelope `{data, meta}` que o painel valida; a paginação por
cursor é a da tela de Eventos ("carregar mais"), a única que a usa.

**O que esta bateria não mede**

- A entrega dos assets estáticos (Amplify/CDN, ~1 MB de JS no total) nem o
  tempo de renderização no navegador: FCP/LCP/INP (RNF07) exigem Lighthouse ou
  Playwright contra o painel publicado. Nada aqui os cobre.
- O salto do Amplify: por padrão o k6 fala direto com o API Gateway. O
  navegador real entra por `https://<branch>.<id>.amplifyapp.com` e o Amplify
  repassa `/api`, `/auth` e `/health`. Para incluir esse salto use
  `TARGET=amplify` em `run-aws.mjs`, com taxa baixa (serviço gerenciado).
- O modelo de usuários do painel: as telas se atualizam sozinhas (Visão Geral a
  cada 30 s, Incidentes a cada 45 s, Monitoramento a cada 20 s). Como regra de
  bolso, uma aba de Visão Geral aberta custa 2 req/min, então `RATE=50` equivale
  a cerca de 1.500 abas dessa tela abertas.
- O login (`POST /auth/login`), a ingestão, reanálise/revisão e importação.
- Volume de dados realista: o seed cria 300 incidentes. A leitura de incidentes,
  do diagnóstico e do overview carrega a projeção inteira (um único item do
  DynamoDB) a cada requisição e filtra em memória; o custo cresce com o número
  de incidentes (medido: 300 → 2.500 incidentes dobrou a CPU por requisição).
  Use `INCIDENTS_PER_HOUR=100 node scripts/seed-carga.cjs` e
  `INCIDENT_COUNT=2500` para medir com um volume maior. O limite físico é o
  item de 400 KB do DynamoDB.

**Limites conhecidos da API que a bateria evidencia** (estado de `develop`):

- `monitoring/overview` é um stub: responde sempre `503 DATA_UNAVAILABLE`. A
  rota pesa 7% do mix e não exercita nada; o sumário avisa. Quando a projeção
  existir, rode com `MONITORING_EXPECTED=available` para exigir 200.
- `GET /api/v1/incidents` devolve `hasMore=true` com `nextCursor=null`: a lista
  de incidentes não pagina. O contador `front_api_has_more_without_cursor_total`
  expõe o desvio; a paginação exercitada é a de Eventos.
- Com o seed, `events` volta com 0 itens (`SEED_EVENTS_NOT_MATERIALIZED`) e
  incidentes/diagnóstico com `meta.partial=true`. O sumário mostra a fração
  parcial por rota; cerca de 22% do mix toca rotas que hoje respondem sem
  trabalho real.

**Critérios** (`load`/`soak` seguem o RNF09, 99,9%; `stress`/`spike`/`breakpoint`
empurram além do regime normal e toleram até 2%):

| Métrica                                               | Smoke         | Load, soak | Stress, spike, breakpoint |
| ----------------------------------------------------- | ------------- | ---------- | ------------------------- |
| `checks`, `front_api_contract_success_rate`           | `==1`         | `>0.999`   | `>0.98`                   |
| `http_req_failed` (200 só; 503 só no monitoramento)   | `==0`         | `<0.001`   | `<0.02`                   |
| p95 / p99 em `status:200`                             | < 2 s / < 5 s | idem       | idem                      |
| p95 / p99 por rota (`rota:<tag>`)                     | < 2 s / < 5 s | idem       | idem                      |
| falha e contrato por rota                             | `==0`         | `<0.02`    | `<0.02`                   |
| 429 (exceto RUM), timeouts > 8 s, iterações descartadas | `==0`       | `==0`      | `==0`                     |

O sumário impresso separa o resultado por rota e por fase (`s2_plateau`, `r75`,
…), então o `breakpoint` mostra em que taxa a API cede; sem isso ele só
devolveria agregados. O JSON completo vai para `loadtest/results/`.

A bateria não executa mutações nas hipóteses, reanálises e importações, nem
login no Cognito, ingestão ou chamadas ao LLM. Ela usa uma sessão local assinada
e um seed sintético. `local.sh` não direciona requisições para a AWS: cada
execução sobe uma instância descartável de DynamoDB Local, cria tabela isolada,
semeia 300 incidentes, inicia a API em loopback e remove o contêiner ao final.

Antes de gastar uma rodada, o `setup()` confere que a lista de incidentes não
está vazia e que `inc-000001` e `inc-<INCIDENT_COUNT>` existem (`PREFLIGHT=0`
desliga). Contra uma API sem a massa sintética — por exemplo a stack AWS com
dados reais ingeridos — ele aborta com a causa, em vez de reportar 100% de 404.

Pré-requisitos: Docker, Node.js 22, dependências npm de `apps/backend/api` já
instaladas e k6 disponível no `PATH`. A partir desta pasta:

```bash
./local.sh smoke       # verificação curta e conservadora (1 iteração/s)
RATE=50 ./local.sh load
RATE=50 ./local.sh spike
RATE=50 ./local.sh stress
RATE=50 DURATION=30m ./local.sh soak
./local.sh breakpoint  # degraus de 10 a 150 chegadas/s (sobe 10 s, segura 50 s), sumário por fase
```

`RATE` é a taxa de chegada de **iterações por segundo**; cada iteração faz uma
requisição (mais a segunda página de eventos, quando existe). `load` sustenta a
taxa por cinco minutos; `spike` aplica uma rajada de quatro vezes a taxa base;
`stress` sustenta duas vezes a taxa base; `soak` dura 30 minutos por padrão. O
RNF14 pede 137 req/s (`RATE=137`). Cada modo começa com banco limpo e seed novo.
A taxa do limite de API local é 30.000 req/min por padrão para deixar o gerador
medir a API; ajuste com `API_RATE_LIMIT_PER_MINUTE` se necessário (o limiter do
beacon RUM, fixo em 600/min, responde 429 sem contar como falha). O cenário é
carga de chegada aberta (arrival rate), então a pressão não cai quando a API
fica lenta.

Variáveis do script: `BASE_URL`, `MODE`, `RATE`, `DURATION`, `INCIDENT_COUNT`,
`AUTH_COOKIE_SECRET` (ou `AUTH_USERNAME`/`AUTH_PASSWORD`), `MONITORING_EXPECTED`
(`either` | `unavailable` | `available`), `FOLLOWUP_PROBABILITY` (0,15),
`PREFLIGHT` (1), `ROUTE_P95_MS`/`ROUTE_P99_MS` (2000/5000), `INCIDENT_IDS` (`synthetic` |
`discover`, para medir um dataset real descobrindo os IDs na API), `WINDOW_OVERRIDE` (ex.: `all`),
`MAX_VUS`, `BREAKPOINT_STEPS` (padrão `10,20,30,40,50,75,100,150`) e `RESULTS_DIR`.
No `breakpoint`, leia só até o primeiro degrau que falha: depois dele o serviço já está
degradado (fila, task reiniciada pelo health check do ALB).

**Dimensione o gerador.** O modelo é aberto: se a API segura cada requisição até o
timeout de 8 s, o k6 precisa de `taxa x 8` VUs para continuar emitindo a carga
pedida (o piso de `maxVUs` já considera isso, ~1,2x). Com poucos VUs ele descarta
chegadas e a carga efetiva fica abaixo da pretendida; o sumário avisa. Cada VU custa
cerca de 1 MB de RAM: um t3.micro (0,9 GB) não sustenta mais que ~700 VUs, então
prefira um gerador maior para `RATE` alto. Rode o gerador na mesma região da stack:
da região do bastion o RTT ao API Gateway é de ~45 ms e ao ALB ~5 ms; de fora, a
latência medida é majoritariamente rede.

Use primeiro `smoke`; os perfis acima dele podem consumir bastante CPU e
memória do computador. Os resultados locais medem a capacidade desta máquina e
do DynamoDB Local, não a da AWS. Para aproximar a AWS, limite a CPU da API
(`docker run --cpus=0.25 --memory=512m` com a imagem implantada, apontando para
o DynamoDB Local) e compare.

Para rodar somente o script em outra API de teste, use k6 diretamente com
`BASE_URL`, `AUTH_COOKIE_SECRET` (o mesmo segredo do servidor) ou
`AUTH_USERNAME`/`AUTH_PASSWORD`, `MODE`, `RATE` e `INCIDENT_COUNT`. Prepare
antes os IDs ordinais `inc-000001` a `inc-000300` e as projeções de dashboard e
dashboard overview. A API deve permitir taxa suficiente por IP; o limite padrão
de produção (180 req/min) vai bloquear um gerador único em carga alta.

### Implementação anterior

Suíte k6 do contrato atual de `apps/backend/api` (monólito modular). Ignora
por completo `apps/basica` (Flask legado, fora da arquitetura aprovada).

Documentação do artefato de entrega (requisitos, plano de testes, resultados,
observabilidade da rodada anterior):
[`artefatos/sprint3/testes-carga-inicial.md`](../../../../artefatos/sprint3/testes-carga-inicial.md).
O relatório da execução AWS desta suíte está em
[`artefatos/sprint5/testes-de-carga-da-api.md`](../../../../artefatos/sprint5/testes-de-carga-da-api.md),
com cópias dos resumos JSON em `artefatos/sprint5/evidencias/testes-carga-api/aws/`.
Este README cobre principalmente o operacional — como rodar e o que esperar.

## Arquivos

| Arquivo                                                  | Cobre                                                                                                                                          | Roda hoje?                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `k6/consultas.js`                                        | RNF14/RNF09 — `/api/v1/incidents` (lista, diagnóstico, eventos, paginação), `/dashboard/overview`, `/monitoring/overview`                      | Sim                                                                        |
| `k6/auth-check.js`                                       | RNF04 — controle de acesso em todas as rotas, incluindo `auth/session`, `auth/login`, `auth/callback`, `auth/logout`, `reanalyze` e `imports*` | Sim                                                                        |
| `k6/ingestao-batch.js`                                   | RNF01/RNF02/RNF03 — drenagem de 10k eventos/min, acúmulo (backlog), frescor ponta a ponta                                                      | Não — adaptador de import fail-closed por design (ver cabeçalho do script) |
| `k6/rodadas.sh`                                          | Bateria `smoke → load → breakpoint → estresse → spike → soak` de `consultas.js`                                                                | Sim                                                                        |
| `k6/lib/session.js`                                      | Sessão (login real ou cookie forjado) e o header `X-Request-Id`, compartilhado pelos três scripts                                              | —                                                                          |
| `k6/lib/asserts.js`                                      | Checks de conteúdo de `consultas.js`: schema mínimo, campo físico vazado, duplicidade entre páginas, eco de `X-Request-Id`                     | —                                                                          |
| [`../scripts/seed-carga.cjs`](../scripts/seed-carga.cjs) | Popula incidentes, evidências, hipóteses e projeções de overview/monitoring no DynamoDB                                                        | Sim                                                                        |

## Autenticação

Duas formas, a escolha de quem chama `k6 run` — `k6/lib/session.js` decide
sozinho em `setup()`, conforme as variáveis presentes:

- **Login real** (`-e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha>`):
  `POST /auth/login` de verdade contra o Cognito (`apps/fullstack/cognito.tf`
  provisiona o User Pool). Recomendado contra qualquer stack aplicada pelo
  Terraform, porque não exige conhecer o segredo HMAC (`AUTH_COOKIE_SECRET`).
  Observação: hoje esse segredo aparece em texto claro na definição da task ECS
  (ver a nota na seção AWS), então ele "nunca sai" apenas no sentido de que o
  Terraform não o exibe como output.
- **Cookie forjado** (`-e AUTH_COOKIE_SECRET=<segredo>`, mínimo 32
  caracteres): `k6/lib/session.js` forja o cookie localmente (HMAC, mesmo
  algoritmo de `SessionCodec`), sem chamada HTTP. Útil só quando o segredo é
  conhecido de outra forma (ex.: `.env` local).

`GET /auth/login`/`GET /auth/callback` (SSO federado) continuam
`503 FEATURE_UNAVAILABLE` enquanto o SSO corporativo não for configurado —
isso não afeta nenhuma das duas formas acima, que usam login de senha direto.

## Como rodar

```bash
# 1. Semear (a partir de apps/backend/api)
CLEAN=1 node scripts/seed-carga.cjs

# 2. k6 (a partir de apps/backend/api/loadtest/k6) — cookie forjado
export BASE_URL=http://localhost:3000
export AUTH_COOKIE_SECRET=<mesmo segredo do processo da API>   # 32+ chars

k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET auth-check.js
./rodadas.sh   # bateria completa de consultas.js (lê AUTH_COOKIE_SECRET do ambiente)
```

`consultas.js` também aceita `-e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha>`
no lugar de `AUTH_COOKIE_SECRET`, para logar de verdade (ver seção
Autenticação) — `auth-check.js` e `ingestao-batch.js` continuam só com
cookie forjado por enquanto.

Variáveis de `consultas.js`: `RATE` (padrão 137 req/s), `INCIDENT_COUNT`
(300), `STRESS_MULTIPLIER` (3). Variáveis de `ingestao-batch.js`:
`EVENT_RATE` (10000/min), `WINDOW_MINUTES` (15), `BACKLOG_BATCHES` (1–4),
`POLL_TIMEOUT_S`.

## Rodando contra dados reais (AWS)

O seed local (`seed-carga.cjs`) gera incidentes sintéticos — suficiente para
RNF09/RNF14 (a API não sabe se o item veio do seed ou de ingestão real), mas
não passa pelo caminho de ingestão de verdade. Para rodar contra a stack real:

```bash
# 1. Descobrir o endpoint e a tabela da stack aplicada (a partir de apps/fullstack)
terraform output api_url            # BASE_URL para k6 (HTTP direto no ALB)
terraform output -raw tabelas_dynamodb

# 2. Criar (uma vez) um usuário de teste no Cognito da stack —
#    user pool id sai de `terraform output cognito_user_pool_id`
aws cognito-idp admin-create-user \
  --user-pool-id <cognito_user_pool_id> --username "<email-de-teste>" \
  --user-attributes Name=email,Value=<email-de-teste> Name=email_verified,Value=true \
  --message-action SUPPRESS --region us-east-1
aws cognito-idp admin-set-user-password \
  --user-pool-id <cognito_user_pool_id> --username "<email-de-teste>" \
  --password "<senha>" --permanent --region us-east-1

# 3. k6 aponta para qualquer BASE_URL — é HTTP puro, não usa credenciais AWS
k6 run -e BASE_URL=http://<dns-do-alb> -e AUTH_USERNAME=<email-de-teste> -e AUTH_PASSWORD=<senha> -e MODE=smoke consultas.js
```

Na stack do Learner Lab, `run-aws.mjs` valida a conta, espera a task ECS
saudável, obtém o segredo de sessão somente em memória e executa a mesma
bateria contra o endpoint HTTPS do API Gateway. O segredo não é impresso nem
gravado nos resultados. O ID da conta muda a cada laboratório; confira o da
sessão atual em vez de copiar um valor antigo:

```bash
export EXPECTED_AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
MODE=smoke node run-aws.mjs
MODE=load RATE=10 node run-aws.mjs
MODE=stress RATE=10 node run-aws.mjs
MODE=spike RATE=10 node run-aws.mjs
TARGET=amplify MODE=smoke node run-aws.mjs   # entra pelo painel (salto do Amplify)
```

O runner lê `RATE_LIMIT_PER_MINUTE` da task ativa e aborta quando o pico do
perfil excede o limite (`ALLOW_RATE_LIMITED=1` ignora): acima dele o k6 mediria
o 429, não a API. `RATE=10` é 14 vezes menor que os 137 req/s do RNF14; uma
rodada aprovada nessa taxa não comprova o requisito.

**Não semeie uma tabela que já tenha dados ingeridos.** `seed-carga.cjs` com
`ALLOW_REMOTE_SEED=1` grava o item `CONTROL#DATASET/ACTIVE` (manifesto do
dataset ativo) além das projeções: a API passa a servir o dataset sintético e o
dataset real deixa de ser o ativo até ser reativado. Use essa etapa somente em
uma stack isolada e vazia, ou exporte antes o item de controle para poder
restaurá-lo. Sem a massa sintética, o `PREFLIGHT` do k6 aborta com a causa.
Para desfazer um seed remoto (restaura o manifesto do backup e apaga só os itens
sintéticos, com ensaio por padrão), tire antes um backup completo com
`scripts/backup-table.cjs <backup.json>` e depois use
`scripts/undo-remote-seed.cjs <backup.json> [--apply]`.
Para cargas acima do limite padrão,
o comando protegido `update loadtest-20000` eleva temporariamente o limite e
`update baseline` o restaura para 180 req/min.

(`AUTH_COOKIE_SECRET` continua funcionando como alternativa. Atenção: o
Terraform gera o segredo com `random_password`, mas o injeta como variável de
ambiente comum na definição da task ECS — é de lá que `run-aws.mjs` o lê. Quem
tem `ecs:DescribeTaskDefinition` consegue forjar sessões de qualquer perfil;
o caminho correto é o bloco `secrets` com Secrets Manager/SSM.)

Dois pontos que mudam de verdade ao sair do localhost:

- **O rate limit (180 req/min por IP) é o mesmo teto** contra a AWS — um
  gerador único continua sem provar os 137 req/s do RNF14. Para medir
  capacidade real: rode k6 distribuído (múltiplas origens/IPs — k6 Cloud ou
  várias instâncias EC2 na mesma subnet) ou peça ao time de backend para
  subir o limite só na janela do teste.
- **Ingestão real (`ingestao-batch.js`) continua bloqueada** até dois pontos
  serem resolvidos, independente do ambiente: (a) um adaptador real de
  `ImportControlPort` (hoje é `UnavailableImportControl`, fail-closed por
  design) ligado a S3 + uma tarefa de processamento, e (b) o contrato
  (`contracts/openapi/public.openapi.json`, schema `ImportStartData`) expor
  `upload.parts[].url` — as URLs pré-assinadas que `completeImport()` já
  espera receber para subir bytes de verdade. Sem isso, `setup()` aborta
  igual em qualquer ambiente, local ou AWS.

Evite `CLEAN=1 node scripts/seed-carga.cjs` contra a tabela real sem alinhar
com o time — o script tem uma trava (`ALLOW_REMOTE_SEED=1`) justamente para
isso não acontecer sem querer.

## Limitações a interpretar antes de ler os números

1. **Rate limit por IP** (`rateLimiter(config.rateLimitPerMinute)` em
   `src/app.ts`, padrão **180 req/min**) teta o throughput observável de um
   gerador único a ~3,9 req/s — bem abaixo dos 137 do RNF14. Não é bug do
   teste. Para medir a API de verdade, rode distribuído (múltiplas origens) ou
   suba o limite **só na janela do teste** com
   `RATE_LIMIT_PER_MINUTE=<alto> npm start` (em ECS, pela variável Terraform
   `rate_limit_por_minuto`), devolvendo ao padrão depois. Medido no leito
   local: **97,06%** de 429 com o limite em 180, contra 0% e **133,12 req/s**
   de vazão útil com o limite elevado. Em ECS Fargate com 1 vCPU e o limite
   elevado, a vazão útil não passou de **58,5 req/s** — ver o artefato de
   entrega.
2. **`dashboard/overview`/`monitoring/overview` envelhecem.** Os snapshots
   gravados pelo seed só respondem 200 enquanto a idade cabe na janela pedida
   (o mais novo tem 5 min; `monitoring` usa janela de 15 min por padrão); fora
   dela vem `503 DATA_UNAVAILABLE`. Os checks de `consultas.js` exigem 200, e
   por isso **semeie imediatamente antes de cada rodada** — `CLEAN=1 node
scripts/seed-carga.cjs` leva cerca de 1 s.
3. **`ingestao-batch.js` está bloqueado por design** — o adaptador de import
   é fail-closed (503) até S3 e a tarefa de ingestão serem configurados;
   `setup()` detecta isso e aborta com mensagem clara.
4. **Autenticação testa uma sessão válida, não o fluxo de login em si** —
   com `AUTH_USERNAME`/`AUTH_PASSWORD` o `POST /auth/login` roda uma vez em
   `setup()` (login real, contra o Cognito), não a cada iteração; com
   `AUTH_COOKIE_SECRET` nem isso, o cookie é forjado direto. Nenhum dos dois
   mede o fluxo de login sob carga — para isso, ver `auth-check.js`.
5. **`consultas.js` confere schema mínimo, não o contrato Zod completo** —
   os checks de `lib/asserts.js` (schema de `data.items`, campo físico
   vazado, duplicidade entre páginas, eco de `X-Request-Id`) são uma forma
   manual enxuta: o runtime do k6 (goja) não roda os schemas Zod de
   `@view-show/contracts`. A validação completa do contrato é feita pelos
   testes funcionais HTTP em Vitest/Node
   (`apps/backend/api/tests/incidents-aws-live.functional.test.ts`).

## Observabilidade

A stack Grafana LGTM do projeto vive em
[`apps/fullstack/observability`](../../../fullstack/observability)
(Prometheus, Loki, Tempo, Alloy) e sobe com:

```bash
docker compose -f apps/fullstack/docker-compose.observability.yml up -d
# Grafana em http://127.0.0.1:3002 (pasta "View Show"), Prometheus em :9090
```

- **Métricas (Prometheus):** a API expõe `GET /metrics` sempre que
  `METRICS_ENABLED=true` (padrão). O alvo `view-show-api` já está **declarado**
  em `prometheus.yml`, apontando para `host.docker.internal:3000`; a composição
  não inicia a API, então mantenha o processo rodando no host para o alvo ficar
  saudável (confira em `http://127.0.0.1:9090/targets`).
- **Traces (Tempo):** suba a API com
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` para que cada
  requisição vire um span automaticamente (auto-instrumentação HTTP) — sem
  mudança nenhuma no k6.
- **Logs (Loki):** a API grava `request_id` estruturado em cada linha. O Alloy
  da pilha coleta logs **de contêineres** (`loki.source.docker`), e a API deste
  roteiro roda direto no host — portanto a saída dela não chega ao Loki assim.
  Leia o stdout do processo (ou rode a API em contêiner na mesma rede) enquanto
  esse gap não for fechado.
- Cada chamada dos três scripts carrega `X-Request-Id` prefixado
  (`k6-consultas-<MODE>`, `k6-authcheck`, `k6-ingestao`) para correlação.

## Documentos relacionados

- [`apps/backend/api/README.md`](../README.md)
- [Artefato de entrega — testes de carga e observabilidade](../../../../artefatos/sprint3/testes-carga-inicial.md)
- [Pilha de observabilidade](../../../fullstack/observability/README.md)
- [Suíte histórica (sprint2, contrato anterior)](../../../../artefatos/sprint2/testes-carga/README.md)
