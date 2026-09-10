# Testes de carga — apps/backend/api

Suíte k6 do contrato atual de `apps/backend/api` (monólito modular). Ignora
por completo `apps/basica` (Flask legado, fora da arquitetura aprovada).

Documentação do artefato de entrega (requisitos, plano de testes, resultados,
observabilidade):
[`artefatos/testes-carga-inicial.md`](../../../../artefatos/testes-carga-inicial.md).
Este README cobre apenas o operacional — como rodar e o que esperar.

## Arquivos

| Arquivo | Cobre | Roda hoje? |
| --- | --- | --- |
| `k6/consultas.js` | RNF14/RNF09 — `/api/v1/incidents` (lista, diagnóstico, eventos, paginação), `/dashboard/overview`, `/monitoring/overview` | Sim |
| `k6/auth-check.js` | RNF04 — controle de acesso em todas as rotas, incluindo `auth/session`, `auth/login`, `auth/callback`, `auth/logout`, `reanalyze` e `imports*` | Sim |
| `k6/ingestao-batch.js` | RNF01/RNF02/RNF03 — drenagem de 10k eventos/min, acúmulo (backlog), frescor ponta a ponta | Não — adaptador de import fail-closed por design (ver cabeçalho do script) |
| `k6/rodadas.sh` | Bateria `smoke → load → breakpoint → estresse → spike → soak` de `consultas.js` | Sim |
| `k6/lib/session.js` | Forja o cookie de sessão (HMAC) e o header `X-Request-Id`, compartilhado pelos três scripts | — |
| [`../scripts/seed-carga.cjs`](../scripts/seed-carga.cjs) | Popula incidentes, evidências, hipóteses e projeções de overview/monitoring no DynamoDB | Sim |

## Autenticação

A identidade é federada (Cognito/OIDC); não existe `POST /auth/login`, e
`GET /auth/login`/`GET /auth/callback` respondem `503 FEATURE_UNAVAILABLE`
enquanto o adaptador não for configurado. `k6/lib/session.js` forja o cookie
de sessão localmente (HMAC, mesmo algoritmo de `SessionCodec`). **Todo
`k6 run` exige `-e AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob
teste>`** (mínimo 32 caracteres).

## Como rodar

```bash
# 1. Semear (a partir de apps/backend/api)
CLEAN=1 node scripts/seed-carga.cjs

# 2. k6 (a partir de apps/backend/api/loadtest/k6)
export BASE_URL=http://localhost:3000
export AUTH_COOKIE_SECRET=<mesmo segredo do processo da API>   # 32+ chars

k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET auth-check.js
./rodadas.sh   # bateria completa de consultas.js (lê AUTH_COOKIE_SECRET do ambiente)
```

Variáveis de `consultas.js`: `RATE` (padrão 137 req/s), `INCIDENT_COUNT`
(300), `STRESS_MULTIPLIER` (3). Variáveis de `ingestao-batch.js`:
`EVENT_RATE` (10000/min), `WINDOW_MINUTES` (15), `BACKLOG_BATCHES` (1–4),
`POLL_TIMEOUT_S`.

## Limitações a interpretar antes de ler os números

1. **Rate limit de 180 req/min por IP** (`rateLimiter(180)` em `src/app.ts`)
   teta o throughput observável de um gerador único a ~3 req/s — bem abaixo
   dos 137 do RNF14. Não é bug do teste; para medir capacidade real acima
   disso, rode distribuído ou ajuste o limite na janela do teste.
2. **`dashboard/overview`/`monitoring/overview` envelhecem.** Os snapshots
   gravados pelo seed só respondem 200 enquanto a idade cabe na janela
   pedida; fora dela, `503 DATA_UNAVAILABLE` é o caminho normal.
3. **`ingestao-batch.js` está bloqueado por design** — o adaptador de import
   é fail-closed (503) até S3 e a tarefa de ingestão serem configurados;
   `setup()` detecta isso e aborta com mensagem clara.
4. **`auth-check.js` reprova por design** nas rotas de leitura, que ainda não
   aplicam RNF04 — é o gap que o script existe para revelar.
5. **Autenticação é forjada, não federada** — mede o comportamento da API
   para uma sessão válida, não o fluxo Cognito/OIDC em si.

## Observabilidade

A stack Grafana LGTM do projeto vive em
[`apps/fullstack/observability`](../../../fullstack/observability)
(Prometheus, Loki, Tempo) e não foi alterada por este trabalho.

- **Métricas (Prometheus):** a API expõe `GET /metrics` sempre que
  `METRICS_ENABLED=true` (padrão). O alvo `view-show-api` fica comentado em
  `prometheus.yml` porque a composição de observabilidade não inicia a API —
  descomente-o (aponta para `host.docker.internal:3000`) e reinicie o
  Prometheus enquanto a API roda no host.
- **Traces (Tempo):** suba a API com
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` para que cada
  requisição vire um span automaticamente (auto-instrumentação HTTP) — sem
  mudança nenhuma no k6.
- **Logs (Loki):** a API grava `request_id` estruturado em cada linha, mas a
  stack local não tem coletor de logs configurado (Promtail/Alloy) — leia a
  saída padrão do processo enquanto esse gap não for fechado.
- Cada chamada dos três scripts carrega `X-Request-Id` prefixado
  (`k6-consultas-<MODE>`, `k6-authcheck`, `k6-ingestao`) para correlação.

## Documentos relacionados

- [`apps/backend/api/README.md`](../README.md)
- [Artefato de entrega — testes de carga](../../../../artefatos/testes-carga-inicial.md)
- [Pilha de observabilidade](../../../fullstack/observability/README.md)
- [Suíte histórica (sprint2, contrato anterior)](../../../../artefatos/sprint2/testes-carga/README.md)
