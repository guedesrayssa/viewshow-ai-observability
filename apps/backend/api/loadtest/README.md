# Testes de carga — apps/backend/api

Suíte k6 do contrato atual de `apps/backend/api` (monólito modular). Ignora
por completo `apps/basica` (Flask legado, fora da arquitetura aprovada).

Documentação do artefato de entrega (requisitos, plano de testes, resultados,
observabilidade):
[`artefatos/sprint3/testes-carga-inicial.md`](../../../../artefatos/sprint3/testes-carga-inicial.md).
Este README cobre apenas o operacional — como rodar e o que esperar.

## Arquivos

| Arquivo                                                  | Cobre                                                                                                                                          | Roda hoje?                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `k6/consultas.js`                                        | RNF14/RNF09 — `/api/v1/incidents` (lista, diagnóstico, eventos, paginação), `/dashboard/overview`, `/monitoring/overview`                      | Sim                                                                        |
| `k6/auth-check.js`                                       | RNF04 — controle de acesso em todas as rotas, incluindo `auth/session`, `auth/login`, `auth/callback`, `auth/logout`, `reanalyze` e `imports*` | Sim                                                                        |
| `k6/ingestao-batch.js`                                   | RNF01/RNF02/RNF03 — drenagem de 10k eventos/min, acúmulo (backlog), frescor ponta a ponta                                                      | Não — adaptador de import fail-closed por design (ver cabeçalho do script) |
| `k6/rodadas.sh`                                          | Bateria `smoke → load → breakpoint → estresse → spike → soak` de `consultas.js`                                                                | Sim                                                                        |
| `k6/lib/session.js`                                      | Sessão (login real ou cookie forjado) e o header `X-Request-Id`, compartilhado pelos três scripts                                                | —                                                                          |
| `k6/lib/asserts.js`                                      | Checks de conteúdo de `consultas.js`: schema mínimo, campo físico vazado, duplicidade entre páginas, eco de `X-Request-Id`                      | —                                                                          |
| [`../scripts/seed-carga.cjs`](../scripts/seed-carga.cjs) | Popula incidentes, evidências, hipóteses e projeções de overview/monitoring no DynamoDB                                                        | Sim                                                                        |

## Autenticação

Duas formas, a escolha de quem chama `k6 run` — `k6/lib/session.js` decide
sozinho em `setup()`, conforme as variáveis presentes:

- **Login real** (`-e AUTH_USERNAME=<email> -e AUTH_PASSWORD=<senha>`):
  `POST /auth/login` de verdade contra o Cognito (`apps/fullstack/cognito.tf`
  provisiona o User Pool). Recomendado contra qualquer stack aplicada pelo
  Terraform, porque o segredo HMAC (`AUTH_COOKIE_SECRET`) é gerado por
  `random_password` e nunca sai em texto claro.
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

(`AUTH_COOKIE_SECRET` continua funcionando como alternativa se o segredo HMAC
da task ECS for conhecido por outra via, mas não é mais necessário: o
Terraform gera esse segredo com `random_password` e não o expõe como output
em texto claro.)

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
