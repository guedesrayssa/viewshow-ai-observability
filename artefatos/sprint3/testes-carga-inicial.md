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
levou a ela. Duas seções têm evidência real, mas ainda incompleta:

- **Seção 3 (Resultados)** — `smoke`, `load` e `auth-check.js` foram
  executados de verdade contra a stack real na AWS (ECS Fargate, ALB,
  DynamoDB — não simulado), em três configurações de capacidade, além de uma
  rodada local anterior (DynamoDB Local) mantida como referência. `ingestao-
  batch.js` continua abortando por design (adaptador fail-closed).
  `breakpoint`, `spike`, `estresse` e `soak` continuam pendentes — ver o
  aviso no início da seção.
- **Seção 4 (Observabilidade)** — traz valores brutos reais capturados de
  `GET /metrics` durante a rodada local anterior (Docker não estava
  disponível naquele ambiente). Ainda não foi repetida contra a rodada AWS
  desta seção — ver o aviso no início da seção.

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
acompanhado até `completed`). Os planos de RNF01/RNF02/RNF03 abaixo estão
revisados para esse contrato: onde a Sprint 1 media "fila cheia" como
`HTTP 429`, o equivalente hoje é acúmulo de janelas de importação; onde media
"timeout de dependência" como `HTTP 504`, o equivalente é o `ImportJob` não
alcançar `completed` dentro do prazo.

&emsp; Esse cenário (10 mil eventos/minuto, fila cheia, timeout) já foi
implementado e validado uma vez, contra a arquitetura anterior do projeto
(API Flask de ingestão, `apps/basica`, hoje descontinuada) — evidência em
[`sprint2/testes-carga/RESULTADOS-INGESTAO-RESILIENCIA.md`](../sprint2/testes-carga/RESULTADOS-INGESTAO-RESILIENCIA.md).
Os números daquela rodada não se aplicam à arquitetura atual (serviço, dados
e contrato diferentes); ficam citados aqui só como precedente de que o
cenário é executável e já passou uma vez, sob a arquitetura anterior.

### 1.2 RNFs cobertos pela suíte k6

| RNF                                                | Requisito (Sprint 1)                                                                                                 | Plano de teste revisado (contrato atual)                                                                                                                                                                                                                                                                                                                                         | Cenário k6                                                                                      |
| :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------- |
| **RNF01** — Capacidade                             | API de ingestão aceita continuamente 10.000 eventos válidos/minuto sem perda.                                        | Disparar uma importação representando uma janela de 150.000 eventos (10.000/min × 15 min) e medir o tempo até o `ImportJob` chegar a `completed`.                                                                                                                                                                                                                                | `ingestao-batch.js`, modo `drenagem`                                                            |
| **RNF02** — Comportamento temporal (ingestão)      | Tempo entre a captura do evento e sua disponibilidade para consulta ≤ 2 minutos.                                     | Marcar `t0` no disparo da importação, `t1` na conclusão do `ImportJob` e `t2` quando o watermark de `/dashboard/overview` avança além de `t0`; reportar `t1-t0` e `t2-t0`, com threshold formal `p(100)<120s`.                                                                                                                                                                    | `ingestao-batch.js`, modo `frescor`                                                             |
| **RNF03** — Tolerância a falhas                    | Degradação controlada sob payload inválido, fila sem capacidade ou timeout de dependência; recuperação sem reinício. | **Fila cheia** → disparar 2, 3 ou 4 janelas em sequência (`BACKLOG_BATCHES`) e medir o tempo até processar o backlog e alcançar o watermark mais recente. **Timeout** → `POLL_TIMEOUT_S` reprova explicitamente um `ImportJob` que não conclui dentro do prazo, em vez de travar o run.                                                                                          | `ingestao-batch.js`, modo `acumulo` (fila cheia) e `POLL_TIMEOUT_S` em todos os modos (timeout) |
| **RNF04** — Confidencialidade (controle de acesso) | Painel e APIs de consulta acessíveis somente via sessão autenticada; tentativa sem sessão retorna 401/403.           | Matriz por rota: chamada sem cookie e com cookie inválido devem retornar 401; chamada com sessão válida deve alcançar o status esperado da rota. Cobre 12 rotas na matriz (consulta, revisão de hipótese, reanálise, importação, sessão) mais 3 verificações avulsas de rotas sem checagem de sessão (login/callback/logout).                                                    | `auth-check.js`                                                                                 |
| **RNF09** — Disponibilidade                        | Dashboard e APIs de consulta com disponibilidade ≥ 99,9%.                                                            | Taxa de erro (`http_req_failed`) `< 0,1%` (`rate<0.001`) como threshold formal em todos os modos de carga sustentada (`load`, `soak`).                                                                                                                                                                                                                                           | `consultas.js`, thresholds de `load`/`soak`                                                     |
| **RNF14** — Comportamento temporal (consulta)      | Busca filtrada retorna em até 2 segundos para 95% das solicitações (p95).                                            | Threshold formal `http_req_duration{status:200}: p(95)<2000` nos modos `load`/`soak` (escopado a respostas de negócio reais — ver §3.3), mais `rate_limited_rate<0.5` para barrar runs de origem única que meçam o rate limiter em vez da API, medido nos 7 cenários de leitura da API (lista de incidentes leve/pesada, diagnóstico, eventos, paginação, overview, monitoring). | `consultas.js`, todos os modos                                                                  |

### 1.3 RNFs não cobertos pela suíte k6 (revisão de estado, não de carga)

&emsp; Estes nove RNFs têm plano de validação próprio definido em
[`sprint1/requisitos.md`](../sprint1/requisitos.md) §4 — por inspeção, CI ou
execução manual, nunca por teste de carga k6. Cada linha abaixo é revisada
com o critério original, a ferramenta aplicável e a evidência encontrada ao
inspecionar o repositório nesta frente (não uma execução formal do plano
completo — onde isso não foi feito, o estado diz "não executado").

| RNF                                    | Plano revisado (contrato atual)                                  | Critério                                         | Ferramenta                                    | Evidência encontrada                                                                                                                                                                                                                          | Estado                                                              |
| :--------------------------------------- | :------------------------------------------------------------------ | :--------------------------------------------------- | :------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
| **RNF05** — Ciclo de vida hot/cold     | Inspeção da IaC por política de expiração automática.            | Transição/expiração automática após 30 dias.     | Leitura de `apps/fullstack/dynamodb.tf`.      | TTL configurado na tabela operacional (`ttl { attribute_name = "ttl", enabled = true }`, `dynamodb.tf:42-45`) — expira itens automaticamente. Não há tier frio (S3/Glacier) visível na IaC: TTL apaga o item, não o arquiva antes de apagar.  | **Parcial** — expiração existe, arquivamento frio não.              |
| **RNF06** — Build limpo/portabilidade  | Build de imagem em ambiente limpo, só com variáveis de ambiente. | Inicia sem configuração manual do SO.            | Docker build.                                 | `Dockerfile` existe em `apps/backend/api/`. `npm run build` (TypeScript) verificado limpo. Build da **imagem** validado nesta sessão via `docker build --platform linux/amd64` (script `apps/fullstack/scripts/publicar-imagem.mjs`), publicada com sucesso no ECR real. | **Sim** — build TS e build de imagem Docker ambos verificados.      |
| **RNF07** — FCP do frontend ≤30s       | Auditoria Lighthouse/Playwright.                                 | FCP ≤ 30,0s.                                     | Lighthouse/Playwright.                        | Não inspecionado nesta frente (fora do escopo: `apps/frontend`).                                                                                                                                                                              | **Não executado.**                                                  |
| **RNF08** — F1-score do modelo ≥80%    | Avaliação contra holdout sintético.                              | F1-Score ≥ 80%.                                  | Notebook/métricas de classificação.           | Bedrock indisponível no Learner Lab (fallback por template ativo — ver `mapeamento-metricas-observabilidade.md`); sem acesso ao modelo real não há classificação a avaliar.                                                                   | **Bloqueado** — depende de acesso ao Bedrock.                       |
| **RNF10** — Usabilidade (≤5 cliques)   | Sessão guiada com operador real.                                 | Causa raiz encontrada em ≤5 cliques.             | Sessão guiada.                                | Não executado nesta frente (requer operador humano).                                                                                                                                                                                          | **Não executado.**                                                  |
| **RNF11** — Normalização multi-formato | Payloads de exemplo de cada plataforma-alvo.                     | Conversão correta, sem perda de campos.          | Testes de contrato do worker de normalização. | Worker de Ingestão (`apps/backend/ingestion-data`) ainda não implementado — não há normalização a testar.                                                                                                                                     | **Bloqueado** — depende da Ingestão.                                |
| **RNF12** — Cobertura de testes ≥70%   | Ferramenta de cobertura no CI a cada push.                       | Cobertura ≥ 70%, pipeline bloqueia abaixo disso. | Vitest + `@vitest/coverage-v8`.               | `npm test` em `apps/backend/api` rodado nesta sessão: **51 testes passaram, 1 ignorado** (8 arquivos). Percentual de cobertura não medido — `@vitest/coverage-v8` não está instalado (`npm run test:coverage` falha por dependência ausente). | **Parcial** — suíte passa, percentual não verificável nesta sessão. |
| **RNF13** — Janela de 5h do ML         | Histórico sintético >5h, inspeciona o que é enviado ao modelo.   | Só eventos das 5h anteriores considerados.       | Instrumentação do worker de ML.               | Mesmo bloqueio do RNF08/RNF11 — worker de ML/Bedrock indisponível.                                                                                                                                                                            | **Bloqueado.**                                                      |
| **RNF15** — Tempo de alerta ≤30s       | Sequência sintética de degradação, cronometrar o alerta.         | Alerta emitido em ≤30s.                          | Pipeline de alertas.                          | Nenhuma rota ou mecanismo de alerta no contrato atual (`public-routes.ts` não expõe alertas).                                                                                                                                                 | **Não implementado.**                                               |

&emsp; RIE01/RIE02 e RESTR01/RESTR02 seguem os mesmos planos de
[`sprint1/requisitos.md`](../sprint1/requisitos.md) §4.2–4.3, por inspeção de
arquitetura — não revisados aqui por não serem RNFs de desempenho/carga.

---

## 2. Cenários de carga implementados

&emsp; Implementação completa em
[`apps/backend/api/loadtest/k6/`](../../apps/backend/api/loadtest/k6/); detalhes
operacionais (variáveis, autenticação, gotchas, como rodar contra dados reais
na AWS) em [`loadtest/README.md`](../../apps/backend/api/loadtest/README.md).

### 2.1 `consultas.js` — desempenho de consulta (RNF14, RNF09)

&emsp; Seis modos de execução (`smoke`, `load`, `breakpoint`, `spike`,
`estresse`, `soak`), modelo de carga **aberto** (arrival-rate — a taxa de
requisições não cai quando a API fica lenta, condição necessária para expor
saturação). Carga alvo: **137 req/s**, derivada do pico de 4,1 milhões de
sessões simultâneas do Globoplay dividido por um fator de escala de 1.000
(decisão de equipe, declarada). A cada iteração, um cenário é sorteado:

| Cenário         | Peso | Rota                                      | Papel                                                                            |
| :--------------- | ---: | :------------------------------------------ | :---------------------------------------------------------------------------------- |
| A — pesada      |  30% | `GET /incidents?window=24h`               | pior caso real; o que a tela de incidentes usa                                   |
| B — leve        |  20% | `GET /incidents?window=15m`               | consulta curta                                                                   |
| C — diagnóstico |  15% | `GET /incidents/:id/diagnosis`            | leitura via GSI, independe do relógio                                            |
| D — overview    |  10% | `GET /dashboard/overview`                 | primeira tela aberta pelo operador                                               |
| E — monitoring  |   8% | `GET /monitoring/overview`                | painel de pipeline                                                               |
| F — eventos     |  10% | `GET /incidents/:id/events`               | rota pública ainda sem tráfego de carga anterior                                 |
| G — paginação   |   7% | `GET /incidents` (limit=5) + `nextCursor` | único cenário que exercita o cursor criptografado (AES-256-GCM) de ponta a ponta |

### 2.2 `auth-check.js` — controle de acesso (RNF04)

&emsp; Execução única (não é teste de carga): confirma, para as 12 rotas da
matriz, que uma chamada sem sessão ou com cookie inválido é recusada e que a
sessão válida alcança o status esperado. Cobre as rotas de leitura e as
rotas mutáveis (`review`, `reanalyze`, `imports*`) — todas já protegidas por
`auth.sessions.verify()` (ver §3.4). Mais 3 verificações avulsas, fora da
matriz, do comportamento fail-closed de
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
`monitoring/overview` em idades variadas. Recusa endpoints remotos por
padrão (`ALLOW_REMOTE_SEED=1` obrigatório para semear uma tabela real, fora
do DynamoDB Local) — proteção contra rodar sem querer contra dados
compartilhados.

---

## 3. Resultados dos testes de carga

> **Rodada principal: stack real na AWS** (ECS Fargate, ALB, DynamoDB, conta
> do AWS Academy Learner Lab), em três configurações de capacidade — não é
> simulação nem ambiente local. Uma rodada anterior em DynamoDB Local (§3.1a)
> fica como referência de que os scripts/thresholds funcionam corretamente
> contra a API real, mas seus números de latência não são comparáveis à
> capacidade de produção. `breakpoint`, `spike`, `estresse` e `soak`
> (varredura de saturação, minutos a 2h) continuam pendentes por tempo.

### 3.1 Ambiente das rodadas

**a) Local (referência de correção dos scripts, não de capacidade)**

| Item              | Valor                                                                    |
| :------------------ | :--------------------------------------------------------------------------- |
| Data              | 10 de setembro de 2026                                                     |
| `BASE_URL`         | `http://127.0.0.1:3000` — processo Node.js direto no host, DynamoDB Local |
| Origem do gerador | Mesma máquina que a API — não é medição distribuída                     |

**b) AWS real** (`aws_lb.principal` → ECS Fargate → DynamoDB, todos criados por
`apps/fullstack` nesta sessão)

| Item                    | Valor                                                                                          |
| :------------------------ | :------------------------------------------------------------------------------------------------ |
| Data                    | 11 de setembro de 2026                                                                          |
| `BASE_URL`               | `http://g05-s3-alb-1799051989.us-east-1.elb.amazonaws.com` (ALB direto, HTTP)                   |
| Tabela                  | `g05-s3-operacional`, semeada com `scripts/seed-carga.cjs` (`ALLOW_REMOTE_SEED=1`, sem `CLEAN`) |
| Origem do gerador       | Máquina do time, fora da AWS, sobre a internet pública — **não** é medição distribuída (multi-origem) |
| Rate limit              | Elevado para `RATE_LIMIT_PER_MINUTE=20000` via `apps/fullstack/variables.tf` (`rate_limit_por_minuto`) só nesta janela de teste, para isolar a capacidade real do teto artificial de 180 req/min por IP — revertido para 180 ao final |
| Configurações testadas  | (1) 0,25 vCPU / 512 MB × 1 task — tamanho de produção; (2) 1 vCPU / 2.048 MB × 1 task; (3) 1 vCPU / 2.048 MB × 3 tasks |

### 3.2 Resumo executivo

&emsp; Contra a stack real na AWS, `smoke` passa integralmente (0 erros, 0
requisições rate-limitadas — o RTT real de internet já mantém a taxa abaixo
do teto de 180/min mesmo sem ajustar o limite). `auth-check.js` passa
**37/37 checks** — RNF04 foi corrigido nesta sessão (guard de sessão
adicionado às 5 rotas de leitura que ainda não o tinham; ver §3.4) e a
correção foi validada contra o deploy real, não só localmente.

&emsp; Para `load` (137 req/s alvo), o teto de 180 req/min por IP único
continua sendo o fator dominante quando ativo — 84,8% das requisições
tomaram 429 com o limite em produção (180). Elevando o limite só para a
janela do teste (ver §3.1b), foi possível medir a capacidade real da API
pela primeira vez, em três configurações de recurso (§3.3). O resultado:
**com 3 tasks de 1 vCPU/2 GB, a API sustenta ~92% da vazão alvo com taxa de
erro de 0,007%**, mas o p95 de latência **ainda não fecha o RNF14** — não
por falta de CPU ou réplicas (o erro caiu de 69% para 0,007% e a vazão
subiu quase linearmente com o recurso), mas por uma cauda longa **uniforme
entre todos os tipos de consulta** (mediana ~150 ms, p95 ~17 s em toda
rota, não só nas mais pesadas), o que aponta para um limite de concorrência
compartilhado — hipótese mais provável: o pool de conexões HTTP do cliente
DynamoDB por processo, não o custo computacional de cada requisição. Fica
como investigação para a próxima sprint (ver §3.6).

&emsp; `ingestao-batch.js` continua abortando corretamente no estado
fail-closed, na AWS como local — nada mudou aqui (§3.5).

### 3.3 RNF14/RNF09 — desempenho e disponibilidade de consulta (`consultas.js`)

**Escalando capacidade real na AWS, `load` (137 req/s alvo, rate limit elevado
para isolar a API do teto artificial):**

| Configuração                       | Erro real (`http_req_failed`) | Checks           | Vazão útil (`status:200`)                                  | p95 latência (`status:200`)               |
| :------------------------------------ | -------------------------------: | ------------------: | -------------------------------------------------------------: | ---------------------------------------------: |
| 0,25 vCPU / 512 MB × 1 (produção)   |                            69,4% | 51,9%              | ~10,8 req/s                                                    | ~43,3 s                                        |
| 1 vCPU / 2.048 MB × 1                | 0,79%                            | 99,4% — ✓          | ~60,2 req/s                                                    | ~26,3 s                                        |
| 1 vCPU / 2.048 MB × 3                | **0,007%**                       | **99,995% — ✓**    | **~125,5 req/s** (92% da meta, threshold `>130` — ✗)          | **~17,2 s** (mediana real: 164 ms) — ✗        |

&emsp; Nenhuma das três configurações fecha o threshold formal `p(95)<2000ms`
do RNF14, mas a trajetória é clara: erro e vazão escalam quase linearmente
com o recurso (4× CPU/memória → ~6× vazão; horizontalizar para 3 tasks
praticamente zerou o erro e chegou a 92% da vazão alvo). O que não escala
com mais recurso é a cauda de latência — ela aparece **igual em todas as
rotas** (pesada, leve, diagnóstico, eventos: todas com p50 ~150 ms e p95
~17 s), o que descarta "consulta cara" como causa única e aponta para um
limite de concorrência por processo (pool de conexões do SDK DynamoDB é a
hipótese mais provável — não investigado a fundo nesta sessão).

**Rate limit em produção (180/min), sem ajuste — mostra o teto artificial
isoladamente:**

| Critério                                    | Threshold    | Resultado (`load`, AWS, 180/min)                                     |
| :--------------------------------------------- | :------------- | ------------------------------------------------------------------------: |
| Fração rate-limitada (`rate_limited_rate`)  | < 0,1%       | 84,8% — ✗                                                             |
| Vazão útil (`status:200`)                   | > 130 req/s  | (dominada pelo rate limiter, não mede capacidade)                     |

&emsp; Confirma o comportamento documentado: um gerador de origem única nunca
mede capacidade real acima de ~3 req/s com o limite de produção ativo — é
preciso ajustar o limite (ou distribuir a origem) para medir a API de
verdade, exatamente como feito em §3.1b.

**`smoke` (referência de correção, ambos os ambientes):**

| Ambiente                | Checks         | 429                                         |
| :------------------------- | :---------------- | ---------------------------------------------: |
| Local (DynamoDB Local)   | 100%             | dominante (rate limiter local sem ajuste)   |
| AWS (real)               | 100%, 0 falhas   | 0 (RTT real já mantém abaixo do teto)       |

&emsp; _(pendente: `breakpoint` — em que taxa a API começa a saturar?
`estresse`/`spike` — como se comporta acima da capacidade e quanto tempo
leva para recuperar? `soak` — há degradação ao longo de 2h? Nenhum dos
quatro foi executado ainda.)_

### 3.4 RNF04 — controle de acesso (`auth-check.js`)

&emsp; **37/37 checks passaram** — as 5 rotas de leitura que não aplicavam
RNF04 (`dashboard_overview`, `incidents_list`, `incident_diagnosis`,
`incident_events`, `monitoring_overview`) foram corrigidas nesta sessão:
[`src/app.ts`](../../apps/backend/api/src/app.ts) agora chama
`auth.sessions.verify()` nelas antes de qualquer lógica de negócio, na mesma
ordem (valida forma da requisição, depois autentica) já usada em
`review`/`reanalyze`/`imports*`. Validado tanto localmente quanto contra o
deploy real na AWS.

| Rota                                             | Sem cookie | Cookie inválido | Sessão válida | Conforme hoje?                |
| :-------------------------------------------------- | :----------- | :----------------- | :--------------- | :------------------------------- |
| `auth_session`                                   | 401 ✓      | 401 ✓             | 200 ✓           | **Sim**                        |
| `dashboard_overview`                             | 401 ✓      | 401 ✓             | 200/503 ✓       | **Sim**                        |
| `incidents_list`                                 | 401 ✓      | 401 ✓             | 200 ✓           | **Sim**                        |
| `incident_diagnosis`                             | 401 ✓      | 401 ✓             | 404 ✓           | **Sim**                        |
| `incident_events`                                | 401 ✓      | 401 ✓             | 404 ✓           | **Sim**                        |
| `monitoring_overview`                            | 401 ✓      | 401 ✓             | 200/503 ✓       | **Sim**                        |
| `incident_event_detail` (sem guarda alguma)      | 503 (esperado — rota-stub, nunca checou sessão) | — | — | Gap conhecido, fora do RNF04 |
| `hypothesis_review`                              | 401 ✓      | 401 ✓             | 404 ✓           | **Sim**                        |
| `reanalyze`                                      | 401 ✓      | 401 ✓             | 404 ✓           | **Sim**                        |
| `import_start`/`import_complete`/`import_status` | 401 ✓      | 401 ✓             | 503 ✓           | **Sim**                        |
| `auth_login`/`auth_callback` (fora da matriz)    | 503 ✓ (fail-closed, não é RNF04) | — | — | N/A |
| `auth_logout` (fora da matriz)                   | 204 ✓ (idempotente, não é RNF04) | — | — | N/A |

&emsp; **As 12 rotas da matriz cumprem RNF04 hoje.** Único gap remanescente
(`incident_event_detail`) é uma rota-stub que responde 503 incondicional —
não tem lógica de negócio nenhuma para proteger ainda.

### 3.5 RNF01/RNF02/RNF03 — ingestão (`ingestao-batch.js`)

&emsp; Confirmado, local e na AWS: `setup()` detecta corretamente o estado
fail-closed (`503 FEATURE_UNAVAILABLE` em `POST /api/v1/imports` com corpo e
sessão válidos) e aborta com a mensagem esperada nos três modos
(`drenagem`, `acumulo`, `frescor`), sem tentar simular um resultado. O
script segue `contracts/openapi/public.openapi.json` à risca (201/`data.id`
no início, 202/`data.status:"queued"` no complete, status minúsculo no
polling — ver §2.3), mas isso não pôde ser validado de ponta a ponta porque
o adaptador continua indisponível: sem uma configuração de S3 + tarefa de
ingestão, não há como observar uma resposta de sucesso real, em nenhum
ambiente.

### 3.6 Limitações a declarar

1. **Origem única, não distribuída.** Mesmo na rodada AWS, o gerador k6
   rodou de uma única máquina — a vazão de ~125 req/s (§3.3) reflete o
   limite da API sob essa concorrência, não necessariamente o teto real
   dela; k6 distribuído (múltiplas origens) poderia revelar um teto
   diferente.
2. Volume sintético — incidentes gerados por seed determinístico, não
   refletem a distribuição real de produção.
3. **RNF14 (p95<2s) não fechou em nenhuma configuração testada.** A causa
   identificada — cauda de latência uniforme entre tipos de consulta,
   sugerindo limite de concorrência no pool de conexões do cliente
   DynamoDB por processo — não foi investigada a fundo nesta sessão; fica
   como item de ação concreto para a próxima sprint (candidatos:
   `maxAttempts`/`requestHandler` do `@aws-sdk/client-dynamodb`, ou o
   `maxSockets` do agente HTTP subjacente).
4. `breakpoint`, `spike`, `estresse` e `soak` não foram executados ainda
   (tempo) — ficam pendentes de uma bateria completa.
5. RNF01/RNF02/RNF03 não são medíveis nesta branch (ver §3.5).
6. Autenticação forjada mede o comportamento da API para uma sessão válida,
   não o fluxo de login Cognito/OIDC em si.
7. **Custo de laboratório**: a configuração (3), usada para o ponto de dado
   mais informativo, custa mais por hora que o tamanho de produção — a
   infraestrutura foi revertida para 0,25 vCPU / 512 MB × 1 task / rate
   limit 180 ao final desta rodada.

---

## 4. Observabilidade

> **Painel Grafana provisionado** — `View Show — API (RED)` configura painéis
> de latência p95, throughput, erros por segundo e CPU em
> `grafana/provisioning/dashboards/json/view-show-api.json`; o alvo
> `view-show-api` está habilitado em `prometheus.yml`. Ainda faltam capturas
> de tela/valores de uma execução com a pilha subida.
> As subseções abaixo trazem **valores brutos capturados direto de
> `GET /metrics`** durante uma rodada local anterior (Docker não estava
> disponível naquele ambiente para subir a pilha completa) — evidência real
> dos números, não a visualização em painel que o item 3 do artefato pede.
> Não foram recapturadas contra a rodada AWS da Seção 3 desta revisão. Falta:
> subir a pilha com Docker (já disponível nesta máquina — ver §3), descomentar
> o alvo, provisionar um dashboard e capturar os mesmos números por lá,
> idealmente contra a stack AWS.

### 4.1 Latência

&emsp; `http_request_duration_seconds_sum` por rota, acumulado durante
`smoke` + `load` locais (a API não expõe p95 diretamente via `/metrics` — o
histograma completo está nos buckets `_bucket`):

| Rota                                  | `_sum` (segundos) | Requisições 200 |
| :--------------------------------------- | ------------------: | -----------------: |
| `GET /api/v1/incidents`               |              8,87 |             525 |
| `GET /api/v1/incidents/:id/diagnosis` |              0,73 |             115 |
| `GET /api/v1/incidents/:id/events`    |              0,58 |              68 |
| `GET /api/v1/dashboard/overview`      |              0,64 |             105 |
| `GET /api/v1/monitoring/overview`     |              0,38 |              56 |

### 4.2 Throughput

&emsp; `http_requests_total{status_code="429"}` acumulado sob a label
`route="unmatched"`: **156.986** (rodada local) — achado de observabilidade:
como o rate limiter roda em `app.use()` antes do roteamento (`src/app.ts`),
toda requisição rejeitada por 429 cai como rota `unmatched` no Prometheus,
então **não dá para saber, só pela métrica da API, qual endpoint estava
sendo chamado quando foi limitado** (o k6 sabe, via
`rate_limited_total{rota=...}` no lado do cliente — ver resumo JSON).

### 4.3 Erros por segundo

&emsp; Nenhum 5xx genuíno (bug) observado — só os estados já documentados
como esperados: 429 (rate limiter), 503 em
`dashboard_overview`/`monitoring_overview`/`import_*`/`auth_login`/
`auth_callback`/`incident_event_detail` (todos fail-closed/DATA_UNAVAILABLE
por design), 401/404/400 de validação e controle de acesso. Consulta correta
para isolar erros reais quando a pilha estiver de pé:
`rate(http_requests_total{status_code=~"5..",route!="unmatched"}[1m])`
excluindo explicitamente `route="unmatched"` (que é dominado pelo rate
limiter, não por falha real).

### 4.4 Uso de CPU

&emsp; Capturado ao final da rodada `load` local (processo acumulado desde o
início, ~220 mil requisições entre `smoke` e `load`):

| Métrica                                      |   Valor |
| :---------------------------------------------- | --------: |
| `view_show_process_cpu_user_seconds_total`   | 31,02 s |
| `view_show_process_cpu_system_seconds_total` | 15,49 s |
| `view_show_process_resident_memory_bytes`    | 96,4 MB |
| `view_show_nodejs_eventloop_lag_seconds`     | 1,55 ms |

&emsp; Sem um limite de vCPU imposto (processo local, não contêiner), não é
possível calcular percentual de utilização comparável ao Fargate de
produção — apenas os segundos de CPU acumulados. Event loop lag baixo
(1,55 ms) indica que a thread principal não estava bloqueada localmente;
a cauda de latência observada na AWS (§3.3) não se manifestou nesta rodada
local, consistente com a hipótese de que a causa é específica do cliente
DynamoDB real (o DynamoDB Local não tem o mesmo comportamento de rede/pool).

---

## 5. Como reproduzir

**Local (DynamoDB Local — valida os scripts, não mede capacidade):**

```bash
# 1. Subir a API (a partir de apps/backend/api) — ver README daquele diretório
#    para a lista completa de variáveis (AUTH_COOKIE_SECRET, CURSOR_SECRET,
#    OPERATIONAL_TABLE_NAME etc.)
npm run build && npm start

# 2. Semear (DynamoDB Local; endpoints remotos são recusados por padrão)
export DYNAMODB_ENDPOINT=http://127.0.0.1:8000
export AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
CLEAN=1 node scripts/seed-carga.cjs

# 3. k6 (a partir de apps/backend/api/loadtest/k6)
export BASE_URL=http://localhost:3000
export AUTH_COOKIE_SECRET=<mesmo segredo do processo da API>   # 32+ chars

k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=smoke consultas.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET auth-check.js
k6 run -e BASE_URL=$BASE_URL -e AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET -e MODE=load consultas.js
./rodadas.sh   # bateria completa: smoke → load → breakpoint → estresse → spike → soak
```

**AWS real (stack completa via Terraform — mede capacidade de verdade):**
ver [`loadtest/README.md` § Rodando contra dados reais (AWS)](../../apps/backend/api/loadtest/README.md#rodando-contra-dados-reais-aws)
para o passo a passo completo (`terraform output`, `ALLOW_REMOTE_SEED=1`,
ajuste opcional de `rate_limit_por_minuto`/`cpu_task`/`memoria_task`/
`quantidade_tasks` para isolar/escalar capacidade).

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
