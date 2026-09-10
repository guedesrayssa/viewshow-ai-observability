# Testes de Carga — View Show

&emsp; **Parceiro:** Grupo Globo (Globoplay) · CCMD7
&emsp; **Turma / Grupo:** Inteli · Módulo 7 · Grupo 05
&emsp; **Sprint:** 3 · Setembro de 2026
&emsp; **Alvo:** `apps/backend/api` (monólito modular). `apps/basica` (Flask/MVP inicial) está fora de escopo — descontinuado, fora da arquitetura aprovada.

---

## Sumário

- [1. Requisitos não funcionais e planos de teste (revisados)](#1-requisitos-não-funcionais-e-planos-de-teste-revisados)
- [2. Cenários de carga implementados](#2-cenários-de-carga-implementados)
- [3. Resultados dos testes de carga](#3-resultados-dos-testes-de-carga)
- [4. Observabilidade](#4-observabilidade)
- [5. Como reproduzir](#5-como-reproduzir)
- [Referências](#referências)

---

## Escopo deste documento

&emsp; Este artefato cobre a suíte de testes de carga k6 de `apps/backend/api`,
implementada em
[`apps/backend/api/loadtest/`](../../apps/backend/api/loadtest/README.md). Ele
descreve o estado final da implementação — não o histórico de decisões que
levou a ela. Duas seções ficam deliberadamente como estrutura a preencher:

- **Seção 3 (Resultados)** — os cenários estão implementados e prontos para
  rodar, mas a execução real depende de um ambiente com `k6` e `node`
  disponíveis, que a sessão de desenvolvimento deste artefato não tinha. A
  seção traz a estrutura completa (critérios, tabelas) para receber os
  números assim que a bateria for executada.
- **Seção 4 (Observabilidade)** — reservada para a documentação de
  visualização em Grafana/Prometheus, a ser preenchida por essa frente do
  grupo.

---

## 1. Requisitos não funcionais e planos de teste (revisados)

&emsp; Os requisitos não funcionais abaixo foram definidos na Sprint 1
([`sprint1/requisitos.md`](../sprint1/requisitos.md), Tabela 3) com um plano de
teste genérico, anterior a qualquer implementação. Esta seção revisa esse
plano para o contrato hoje implementado em `apps/backend/api`, mapeando cada
requisito ao script/cenário k6 que o valida.

### 1.1 Mudança de arquitetura relevante para os planos de teste

&emsp; O plano original da Sprint 1 assumia uma API de ingestão HTTP síncrona
publicando em fila, testável com POST de eventos e respostas `429`/`504`. A
arquitetura implementada mudou esse desenho: a Ingestão é uma tarefa batch
ECS Fargate sem porta HTTP, que lê a fonte (ARGUS/MySQL ou dump) via comandos
`sync`/`backfill`. O único ponto de entrada HTTP é o Backend disparando essa
tarefa (`POST /api/v1/imports` → upload para S3 → `RunTask` → `ImportJob`
acompanhado até `COMPLETED`). Os planos de RNF01/RNF02/RNF03 abaixo estão
revisados para esse contrato: onde a Sprint 1 media "fila cheia" como
`HTTP 429`, o equivalente hoje é acúmulo de janelas de importação; onde media
"timeout de dependência" como `HTTP 504`, o equivalente é o `ImportJob` não
alcançar `COMPLETED` dentro do prazo.

&emsp; Esse cenário (10 mil eventos/minuto, fila cheia, timeout) já foi
implementado e validado uma vez, contra a arquitetura anterior do projeto
(API Flask de ingestão, `apps/basica`, hoje descontinuada) — evidência em
[`sprint2/testes-carga/RESULTADOS-INGESTAO-RESILIENCIA.md`](../sprint2/testes-carga/RESULTADOS-INGESTAO-RESILIENCIA.md).
Os números daquela rodada não se aplicam à arquitetura atual (serviço, dados
e contrato diferentes); ficam citados aqui só como precedente de que o
cenário é executável e já passou uma vez, sob a arquitetura anterior.

### 1.2 RNFs cobertos pela suíte k6

| RNF | Requisito (Sprint 1) | Plano de teste revisado (contrato atual) | Cenário k6 |
| :-- | :-- | :-- | :-- |
| **RNF01** — Capacidade | API de ingestão aceita continuamente 10.000 eventos válidos/minuto sem perda. | Disparar uma importação representando uma janela de 150.000 eventos (10.000/min × 15 min) e medir o tempo até o `ImportJob` chegar a `COMPLETED`. | `ingestao-batch.js`, modo `drenagem` |
| **RNF02** — Comportamento temporal (ingestão) | Tempo entre a captura do evento e sua disponibilidade para consulta ≤ 2 minutos. | Marcar `t0` no disparo da importação, `t1` na conclusão do `ImportJob` e `t2` quando o watermark de `/dashboard/overview` avança além de `t0`; reportar `t1-t0` e `t2-t0`. | `ingestao-batch.js`, modo `frescor` |
| **RNF03** — Tolerância a falhas | Degradação controlada sob payload inválido, fila sem capacidade ou timeout de dependência; recuperação sem reinício. | **Fila cheia** → disparar 2, 3 ou 4 janelas em sequência (`BACKLOG_BATCHES`) e medir o tempo até processar o backlog e alcançar o watermark mais recente. **Timeout** → `POLL_TIMEOUT_S` reprova explicitamente um `ImportJob` que não conclui dentro do prazo, em vez de travar o run. | `ingestao-batch.js`, modo `acumulo` (fila cheia) e `POLL_TIMEOUT_S` em todos os modos (timeout) |
| **RNF04** — Confidencialidade (controle de acesso) | Painel e APIs de consulta acessíveis somente via sessão autenticada; tentativa sem sessão retorna 401/403. | Matriz por rota: chamada sem cookie e com cookie inválido devem retornar 401; chamada com sessão válida deve alcançar o status esperado da rota. Cobre 12 rotas na matriz (consulta, revisão de hipótese, reanálise, importação, sessão) mais 3 verificações avulsas de rotas sem checagem de sessão (login/callback/logout). | `auth-check.js` |
| **RNF09** — Disponibilidade | Dashboard e APIs de consulta com disponibilidade ≥ 99,9%. | Taxa de erro (`http_req_failed`) `< 1%` como threshold formal em todos os modos de carga sustentada (`load`, `soak`). | `consultas.js`, thresholds de `load`/`soak` |
| **RNF14** — Comportamento temporal (consulta) | Busca filtrada retorna em até 2 segundos para 95% das solicitações (p95). | Threshold formal `http_req_duration: p(95)<2000` nos modos `load`/`soak`, medido nos 7 cenários de leitura da API (lista de incidentes leve/pesada, diagnóstico, eventos, paginação, overview, monitoring). | `consultas.js`, todos os modos |

### 1.3 Requisitos fora do escopo desta suíte

&emsp; RNF05 (política de ciclo de vida hot/cold), RNF06 (build limpo),
RNF07 (FCP do frontend), RNF08 (F1-score do modelo de ML), RNF10
(usabilidade), RNF11 (normalização multi-formato), RNF12 (cobertura de
testes em CI), RNF13 (janela de contexto do ML) e RNF15 (tempo de alerta),
assim como RIE01/RIE02 e RESTR01/RESTR02, têm planos de validação próprios
já definidos em [`sprint1/requisitos.md`](../sprint1/requisitos.md) §4–5, por
inspeção, CI ou execução manual — não por teste de carga k6. Não são
revisados aqui.

---

## 2. Cenários de carga implementados

&emsp; Implementação completa em
[`apps/backend/api/loadtest/k6/`](../../apps/backend/api/loadtest/k6/); detalhes
operacionais (variáveis, autenticação, gotchas) em
[`loadtest/README.md`](../../apps/backend/api/loadtest/README.md).

### 2.1 `consultas.js` — desempenho de consulta (RNF14, RNF09)

&emsp; Seis modos de execução (`smoke`, `load`, `breakpoint`, `spike`,
`estresse`, `soak`), modelo de carga **aberto** (arrival-rate — a taxa de
requisições não cai quando a API fica lenta, condição necessária para expor
saturação). Carga alvo: **137 req/s**, derivada do pico de 4,1 milhões de
sessões simultâneas do Globoplay dividido por um fator de escala de 1.000
(decisão de equipe, declarada). A cada iteração, um cenário é sorteado:

| Cenário | Peso | Rota | Papel |
| :-- | --: | :-- | :-- |
| A — pesada | 30% | `GET /incidents?window=24h` | pior caso real; o que a tela de incidentes usa |
| B — leve | 20% | `GET /incidents?window=15m` | consulta curta |
| C — diagnóstico | 15% | `GET /incidents/:id/diagnosis` | leitura via GSI, independe do relógio |
| D — overview | 10% | `GET /dashboard/overview` | primeira tela aberta pelo operador |
| E — monitoring | 8% | `GET /monitoring/overview` | painel de pipeline |
| F — eventos | 10% | `GET /incidents/:id/events` | rota pública ainda sem tráfego de carga anterior |
| G — paginação | 7% | `GET /incidents` (limit=5) + `nextCursor` | único cenário que exercita o cursor criptografado (AES-256-GCM) de ponta a ponta |

### 2.2 `auth-check.js` — controle de acesso (RNF04)

&emsp; Execução única (não é teste de carga): confirma, para as 12 rotas da
matriz, que uma chamada sem sessão ou com cookie inválido é recusada e que a
sessão válida alcança o status esperado. Inclui as rotas de leitura (ainda
públicas — reprovação esperada, é o gap que o RNF04 ainda precisa fechar) e
as rotas mutáveis (`review`, `reanalyze`, `imports*`, já protegidas). Mais 3
verificações avulsas, fora da matriz, do comportamento fail-closed de
`auth/login`/`auth/callback`/`auth/logout` (não dependem de sessão).

### 2.3 `ingestao-batch.js` — ingestão (RNF01, RNF02, RNF03)

&emsp; Três modos (`drenagem`, `acumulo`, `frescor`, ver §1.2). A rota HTTP
de importação existe e é validada (autenticação, corpo), mas o adaptador que
efetivamente processaria o arquivo (S3 + tarefa de ingestão) está
deliberadamente indisponível nesta branch — responde `503
FEATURE_UNAVAILABLE` de forma incondicional. O script detecta esse estado em
`setup()` e aborta com uma mensagem explícita em vez de simular um resultado;
fica pronto para medir os três cenários assim que o adaptador for
configurado.

### 2.4 Seed de carga

&emsp; [`apps/backend/api/scripts/seed-carga.cjs`](../../apps/backend/api/scripts/seed-carga.cjs)
popula 300 incidentes (≈2.500 itens, incluindo evidências e hipóteses)
distribuídos pelas últimas 25 horas, mais snapshots de `dashboard/overview` e
`monitoring/overview` em idades variadas.

---

## 3. Resultados dos testes de carga

> **Pendente de execução.** Os cenários da Seção 2 estão implementados e
> prontos para rodar; os números abaixo devem ser preenchidos após uma
> execução real, com `k6` instalado e `apps/backend/api` no ar (local ou em
> homologação). Comandos de execução: [Seção 5](#5-como-reproduzir).

### 3.1 Ambiente da rodada

| Item | Valor |
| :-- | :-- |
| Data da execução | *(preencher)* |
| `BASE_URL` | *(preencher — local, EC2, ALB?)* |
| Capacidade do serviço (vCPU/memória) | *(preencher)* |
| Origem do gerador de carga | *(preencher — mesma região da API é recomendado, ver §4.4 de [`sprint2/testes-desempenho.md`](../sprint2/testes-desempenho.md))* |
| Versão do k6 | *(preencher)* |
| `INCIDENT_COUNT` / seed usado | *(preencher)* |

### 3.2 Resumo executivo

*(preencher — 3 a 5 frases: a API atende aos thresholds sob a carga alvo?
Se não, qual o gargalo identificado?)*

### 3.3 RNF14/RNF09 — desempenho e disponibilidade de consulta (`consultas.js`)

| Critério | Threshold | Resultado (`smoke`) | Resultado (`load`) |
| :-- | :-- | --: | --: |
| Latência p95 | < 2.000 ms | *(preencher)* | *(preencher)* |
| Taxa de erro | < 1% | *(preencher)* | *(preencher)* |
| Vazão | > 130 req/s (`load`) | — | *(preencher)* |
| Checks | ≥ 99% (`smoke`) / > 99% (`load`) | *(preencher)* | *(preencher)* |
| 429 (`rate_limited_total`) | informativo | *(preencher)* | *(preencher)* |

| Cenário | Latência p95 | Latência mediana |
| :-- | --: | --: |
| A — pesada | *(preencher)* | *(preencher)* |
| B — leve | *(preencher)* | *(preencher)* |
| C — diagnóstico | *(preencher)* | *(preencher)* |
| F — eventos | *(preencher)* | *(preencher)* |

&emsp; *(preencher: breakpoint — em que taxa a API começa a saturar?
estresse/spike — como se comporta acima da capacidade e quanto tempo leva
para recuperar? soak — há degradação ao longo de 2h?)*

### 3.4 RNF04 — controle de acesso (`auth-check.js`)

| Rota | Sem cookie | Cookie inválido | Sessão válida | Conforme hoje? |
| :-- | :-- | :-- | :-- | :-- |
| `auth_session` | *(preencher)* | *(preencher)* | *(preencher)* | *(preencher)* |
| `incidents_list` | *(preencher)* | *(preencher)* | *(preencher)* | *(preencher)* |
| `dashboard_overview` | *(preencher)* | *(preencher)* | *(preencher)* | *(preencher)* |
| `hypothesis_review` | *(preencher)* | *(preencher)* | *(preencher)* | *(preencher)* |
| `import_start`/`import_complete`/`import_status` | *(preencher)* | *(preencher)* | *(preencher)* | *(preencher)* |

*(preencher: quantas das 12 rotas da matriz já cumprem o RNF04 hoje vs.
quantas dependem da proteção ainda não aplicada às rotas de leitura?)*

### 3.5 RNF01/RNF02/RNF03 — ingestão (`ingestao-batch.js`)

&emsp; Bloqueado nesta branch: o adaptador de import responde
`503 FEATURE_UNAVAILABLE` incondicionalmente (ver §2.3). Sem uma
configuração de S3 + tarefa de ingestão disponível para o ambiente testado,
não há resultado a registrar — apenas a confirmação de que o script detecta
corretamente o estado fail-closed em vez de simular sucesso.

### 3.6 Limitações a declarar

1. Volume sintético — incidentes gerados por seed determinístico, não
   refletem a distribuição real de produção.
2. Capacidade real da API de consulta acima de ~3 req/s é desconhecida
   enquanto o rate limit por IP (180 req/min) não for contornado
   (distribuir origens ou ajustar o limite na janela do teste).
3. RNF01/RNF02/RNF03 não são medíveis nesta branch (ver §3.5).
4. Autenticação forjada mede o comportamento da API para uma sessão válida,
   não o fluxo de login Cognito/OIDC em si.

---

## 4. Observabilidade

> **Reservado para a documentação de observabilidade** (Grafana/Prometheus),
> a preencher por essa frente do grupo. A pilha existente
> (`apps/fullstack/observability/` — Prometheus, Loki, Tempo) já expõe o que
> as subseções abaixo pedem; ver
> [`loadtest/README.md`](../../apps/backend/api/loadtest/README.md#observabilidade)
> para o que já está disponível hoje sem trabalho adicional.

### 4.1 Latência

*(preencher — captura de `http_request_duration_seconds` no Prometheus/
Grafana durante uma rodada `load`, com p95/p99 por rota)*

### 4.2 Throughput

*(preencher — `rate(http_requests_total[1m])` durante a rodada, comparado
à taxa alvo do k6)*

### 4.3 Erros por segundo

*(preencher — `http_requests_total{status_code=~"4..|5.."}`, separando
`429` do rate limiter dos demais códigos)*

### 4.4 Uso de CPU

*(preencher — `process_cpu_user_seconds_total`/`process_cpu_system_seconds_total`
ou métrica equivalente do host/contêiner, correlacionada com a saturação
observada na Seção 3)*

---

## 5. Como reproduzir

```bash
# 1. Subir a API (a partir de apps/backend/api) — ver README daquele diretório
#    para a lista completa de variáveis (AUTH_COOKIE_SECRET, CURSOR_SECRET,
#    OPERATIONAL_TABLE_NAME etc.)
npm run build && npm start

# 2. Semear
CLEAN=1 node scripts/seed-carga.cjs

# 3. k6 (a partir de apps/backend/api/loadtest/k6)
export BASE_URL=http://localhost:3000
export AUTH_COOKIE_SECRET=<mesmo segredo do processo da API>   # 32+ chars

k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET auth-check.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=load consultas.js
./rodadas.sh   # bateria completa: smoke → load → breakpoint → estresse → spike → soak
```

&emsp; Cada rodada grava um resumo JSON completo (`resumo-<MODE>.json`), que
deve ser anexado como evidência ao preencher a Seção 3.

---

## Referências

- [Requisitos e planos de teste da Sprint 1](../sprint1/requisitos.md)
- [Relatório de desempenho — arquitetura anterior](../sprint2/testes-desempenho.md)
- [Resultados de ingestão — arquitetura anterior](../sprint2/testes-carga/RESULTADOS-INGESTAO-RESILIENCIA.md)
- [Implementação da suíte k6](../../apps/backend/api/loadtest/README.md)
- [Pilha de observabilidade (Grafana LGTM)](../../apps/fullstack/observability/README.md)
- [Visão geral da arquitetura](../arquitetura/visao-geral.md)
- [Ingestão e dados](../arquitetura/ingestao-e-dados.md)
