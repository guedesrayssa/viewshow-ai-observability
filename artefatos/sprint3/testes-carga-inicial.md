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

- **Seção 3 (Resultados)** — `smoke`, `load`, `auth-check.js` e
  `ingestao-batch.js` foram executados de verdade contra a API real (local,
  DynamoDB Local) e a seção traz os números medidos, não um template vazio.
  `breakpoint`, `spike`, `estresse`, `soak` e qualquer rodada em
  homologação/AWS continuam pendentes — ver o aviso no início da seção.
- **Seção 4 (Observabilidade)** — traz valores brutos reais capturados de
  `GET /metrics` durante a rodada, porque este ambiente não tinha Docker
  para subir a pilha Grafana completa. Falta a visualização em painel
  propriamente dita (dashboard provisionado, capturas de tela) — ver o
  aviso no início da seção.

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
| :------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------- |
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
| :------------------------------------- | :--------------------------------------------------------------- | :----------------------------------------------- | :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------ |
| **RNF05** — Ciclo de vida hot/cold     | Inspeção da IaC por política de expiração automática.            | Transição/expiração automática após 30 dias.     | Leitura de `apps/fullstack/dynamodb.tf`.      | TTL configurado na tabela operacional (`ttl { attribute_name = "ttl", enabled = true }`, `dynamodb.tf:42-45`) — expira itens automaticamente. Não há tier frio (S3/Glacier) visível na IaC: TTL apaga o item, não o arquiva antes de apagar.  | **Parcial** — expiração existe, arquivamento frio não.              |
| **RNF06** — Build limpo/portabilidade  | Build de imagem em ambiente limpo, só com variáveis de ambiente. | Inicia sem configuração manual do SO.            | Docker build.                                 | `Dockerfile` existe em `apps/backend/api/`. `npm run build` (TypeScript) verificado limpo nesta sessão. Build da **imagem** Docker em si não verificado — sem Docker neste ambiente.                                                          | **Parcial** — build TS ok, build de imagem não testado aqui.        |
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
operacionais (variáveis, autenticação, gotchas) em
[`loadtest/README.md`](../../apps/backend/api/loadtest/README.md).

### 2.1 `consultas.js` — desempenho de consulta (RNF14, RNF09)

&emsp; Seis modos de execução (`smoke`, `load`, `breakpoint`, `spike`,
`estresse`, `soak`), modelo de carga **aberto** (arrival-rate — a taxa de
requisições não cai quando a API fica lenta, condição necessária para expor
saturação). Carga alvo: **137 req/s**, derivada do pico de 4,1 milhões de
sessões simultâneas do Globoplay dividido por um fator de escala de 1.000
(decisão de equipe, declarada). A cada iteração, um cenário é sorteado:

| Cenário         | Peso | Rota                                      | Papel                                                                            |
| :-------------- | ---: | :---------------------------------------- | :------------------------------------------------------------------------------- |
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

> **Execução local de desenvolvimento (`smoke`, `load`, `auth-check.js`,
> `ingestao-batch.js`), não homologação/produção.** Ambiente: DynamoDB Local
> em memória + `apps/backend/api` compilado rodando direto no host (sem
> contêiner, sem limite de vCPU imposto, gerador k6 na mesma máquina). Serve
> para provar que os scripts e os thresholds funcionam corretamente contra a
> API real — não para medir capacidade de produção. `breakpoint`, `spike`,
> `estresse` e `soak` (varredura de saturação, minutos a 2h) não foram
> executados nesta rodada por tempo; ficam pendentes de uma execução em
> homologação.

### 3.1 Ambiente da rodada

| Item                       | Valor                                                                                                                                       |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| Data da execução           | 10 de setembro de 2026                                                                                                                      |
| `BASE_URL`                 | `http://127.0.0.1:3000` — API local, DynamoDB Local em memória (`-sharedDb -inMemory`)                                                      |
| Capacidade do serviço      | Processo Node.js direto no host (Windows), sem contêiner nem limite de vCPU — **não comparável** à capacidade real em ECS Fargate 0,25 vCPU |
| Origem do gerador de carga | Mesma máquina que a API (localhost) — **não** é uma medição de capacidade distribuída                                                       |
| Versão do k6               | 2.2.0                                                                                                                                       |
| `INCIDENT_COUNT` / seed    | 300 incidentes (padrão), DynamoDB Local explícito, `seed-carga.cjs` com `CLEAN=1`                                                          |

### 3.2 Resumo executivo

&emsp; A captura abaixo é uma execução anterior ao endurecimento final dos
thresholds de erro/rate-limit; deve ser repetida após esta revisão. `smoke` passa integralmente
(188.384 checks, 0 falhas). Isolando a latência das respostas de negócio de
verdade (`http_req_duration{status:200}`), o `load` mostra **p95 de 64 ms**
— bem dentro do orçamento de 2.000 ms do RNF14 — mas a vazão útil
(`http_reqs{status:200}`) ficou em **3,03 req/s**, e **97,6% do tráfego foi
rejeitado com 429** pelo rate limiter de 180 req/min por IP. O threshold
`rate_limited_rate<0.001` reprovou de propósito: **esta rodada não comprova
RNF09/RNF14 na taxa alvo de 137 req/s**, porque mede majoritariamente o rate
limiter, não a capacidade da API — exatamente o cenário que a correção da
revisão de PR existe para impedir de passar silenciosamente. `auth-check.js`
reprova nas 5 rotas de leitura sem RNF04 aplicado (o gap documentado) e passa
nas demais 7. `ingestao-batch.js` aborta corretamente no estado fail-closed.
**Para medir RNF09/RNF14 na taxa alvo de verdade, a próxima rodada precisa
ser distribuída (múltiplas origens) ou rodar com o rate limit ajustado para
a janela do teste, em homologação — ver Limitações.**

### 3.3 RNF14/RNF09 — desempenho e disponibilidade de consulta (`consultas.js`)

| Critério                                     | Threshold                        |          Resultado (`smoke`) |         Resultado (`load`) |
| :------------------------------------------- | :------------------------------- | ---------------------------: | -------------------------: |
| Latência p95 (`status:200`)                  | < 2.000 ms                       |    — (não aplicado no smoke) |           **64,25 ms — ✓** |
| Latência p95 (todas as respostas, incl. 429) | informativo                      |                      0,62 ms |                    0,71 ms |
| Taxa de erro (`http_req_failed`)             | < 0,1%                           |               0% (execução anterior) |               0% (execução anterior) |
| Vazão útil (`status:200`)                    | > 130 req/s                      |                            — |         3,03 req/s — **✗** |
| Fração rate-limitada (`rate_limited_rate`)   | < 0,1%                           |   — (sem threshold no smoke) |              97,6% — **✗** |
| Checks                                       | ≥ 99% (`smoke`) / > 99% (`load`) |   100% (188.384/188.384) — ✓ |   100% (40.490/40.490) — ✓ |
| 429 (`rate_limited_total`)                   | informativo                      | 129.718 de 129.890 iterações | 27.267 de 27.892 iterações |

&emsp; Na versão revisada, respostas 429/503 não são mais aceitas como sucesso;
os
thresholds que **provam** RNF09/RNF14 na taxa alvo (vazão útil e fração
rate-limitada) são os que reprovam, corretamente, nesta rodada de origem
única.

| Cenário         | Latência p95 (todas, incl. 429) |
| :-------------- | ------------------------------: |
| A — pesada      |                         0,71 ms |
| B — leve        |                         0,69 ms |
| C — diagnóstico |                         0,70 ms |
| F — eventos     |                         0,70 ms |

&emsp; _(pendente: `breakpoint` — em que taxa a API começa a saturar?
`estresse`/`spike` — como se comporta acima da capacidade e quanto tempo
leva para recuperar? `soak` — há degradação ao longo de 2h? Nenhum dos
quatro foi executado nesta rodada.)_

### 3.4 RNF04 — controle de acesso (`auth-check.js`)

&emsp; 27 checks passaram, 10 falharam — exatamente as 5 rotas de leitura
que ainda não aplicam RNF04 (2 checks cada: sem cookie e com cookie
inválido, ambas deveriam ser 401 e não são).

| Rota                                             | Sem cookie                              | Cookie inválido | Sessão válida | Conforme hoje?               |
| :----------------------------------------------- | :-------------------------------------- | :-------------- | :------------ | :--------------------------- |
| `auth_session`                                   | 401 ✓                                   | 401 ✓           | 200 ✓         | **Sim**                      |
| `dashboard_overview`                             | 200 ✗ (esperado 401)                    | 200 ✗           | 200/503 ✓     | **Não**                      |
| `incidents_list`                                 | 200 ✗                                   | 200 ✗           | 200 ✓         | **Não**                      |
| `incident_diagnosis`                             | 404 ✗                                   | 404 ✗           | 404 ✓         | **Não**                      |
| `incident_events`                                | 404 ✗                                   | 404 ✗           | 404 ✓         | **Não**                      |
| `monitoring_overview`                            | 200/503 ✗                               | 200/503 ✗       | 200/503 ✓     | **Não**                      |
| `incident_event_detail` (sem guarda alguma)      | 503 (esperado — sem checagem de sessão) | —               | —             | Gap conhecido, fora do RNF04 |
| `hypothesis_review`                              | 401 ✓                                   | 401 ✓           | 404 ✓         | **Sim**                      |
| `reanalyze`                                      | 401 ✓                                   | 401 ✓           | 404 ✓         | **Sim**                      |
| `import_start`/`import_complete`/`import_status` | 401 ✓                                   | 401 ✓           | 503 ✓         | **Sim**                      |
| `auth_login`/`auth_callback` (fora da matriz)    | 503 ✓ (fail-closed, não é RNF04)        | —               | —             | N/A                          |
| `auth_logout` (fora da matriz)                   | 204 ✓ (idempotente, não é RNF04)        | —               | —             | N/A                          |

&emsp; **7 das 12 rotas da matriz já cumprem o RNF04 hoje** (`auth_session`,
`hypothesis_review`, `reanalyze`, as três de `imports*`); **5 dependem da
proteção ainda não aplicada** às rotas de leitura (`dashboard_overview`,
`incidents_list`, `incident_diagnosis`, `incident_events`,
`monitoring_overview`).

### 3.5 RNF01/RNF02/RNF03 — ingestão (`ingestao-batch.js`)

&emsp; Confirmado nesta rodada: `setup()` detecta corretamente o estado
fail-closed (`503 FEATURE_UNAVAILABLE` em `POST /api/v1/imports` com corpo e
sessão válidos) e aborta com a mensagem esperada, sem tentar simular um
resultado. O script foi também corrigido nesta revisão para seguir
`contracts/openapi/public.openapi.json` à risca (201/`data.id` no início,
202/`data.status:"queued"` no complete, status minúsculo no polling — ver
§2.3), mas isso não pôde ser validado de ponta a ponta porque o adaptador
continua indisponível: sem uma configuração de S3 + tarefa de ingestão, não
há como observar uma resposta de sucesso real.

### 3.6 Limitações a declarar

1. **Ambiente local de desenvolvimento, não homologação.** Os números de
   latência/CPU acima refletem um processo Node.js sem contêiner rodando na
   mesma máquina do gerador — não são comparáveis à capacidade de produção
   (ECS Fargate 0,25 vCPU).
2. Volume sintético — incidentes gerados por seed determinístico, não
   refletem a distribuição real de produção.
3. **RNF09/RNF14 não foram comprovados na taxa alvo de 137 req/s** — o
   rate limit por IP (180 req/min) tetou a vazão útil observada a ~3 req/s
   (medido: 3,03 req/s). A latência de negócio isolada (p95 64 ms) sugere que
   a API aguentaria mais, mas isso precisa ser confirmado distribuindo a
   origem do gerador ou ajustando o limite na janela do teste.
4. `breakpoint`, `spike`, `estresse` e `soak` não foram executados nesta
   rodada (tempo) — ficam pendentes de uma bateria completa em homologação.
5. RNF01/RNF02/RNF03 não são medíveis nesta branch (ver §3.5).
6. Autenticação forjada mede o comportamento da API para uma sessão válida,
   não o fluxo de login Cognito/OIDC em si.

---

## 4. Observabilidade

> **Painel Grafana provisionado** — `View Show — API (RED)` configura painéis
> de latência p95, throughput, erros por segundo e CPU em
> `grafana/provisioning/dashboards/json/view-show-api.json`; o alvo
> `view-show-api` está habilitado em `prometheus.yml`. Ainda faltam capturas
> de tela/valores de uma execução com a pilha subida.
> Este ambiente de execução não tinha Docker disponível para subir a pilha
> completa, então as subseções abaixo trazem **valores brutos capturados
> direto de `GET /metrics`** durante a rodada `load` da Seção 3 — evidência
> real dos números, não a visualização em painel que o item 3 do artefato
> pede. Falta: subir a pilha com Docker, descomentar o alvo, provisionar um
> dashboard e capturar os mesmos números por lá.

### 4.1 Latência

&emsp; `http_request_duration_seconds_sum` por rota, acumulado durante
`smoke` + `load` (a API não expõe p95 diretamente via `/metrics` — o
histograma completo está nos buckets `_bucket`; o p95 por status:200 já foi
calculado pelo próprio k6 na Seção 3.3: **64,25 ms**):

| Rota                                  | `_sum` (segundos) | Requisições 200 |
| :------------------------------------ | ----------------: | --------------: |
| `GET /api/v1/incidents`               |              8,87 |             525 |
| `GET /api/v1/incidents/:id/diagnosis` |              0,73 |             115 |
| `GET /api/v1/incidents/:id/events`    |              0,58 |              68 |
| `GET /api/v1/dashboard/overview`      |              0,64 |             105 |
| `GET /api/v1/monitoring/overview`     |              0,38 |              56 |

### 4.2 Throughput

&emsp; `http_requests_total{status_code="429"}` acumulado sob a label
`route="unmatched"`: **156.986** — achado de observabilidade: como o rate
limiter roda em `app.use()` antes do roteamento (`src/app.ts`), toda
requisição rejeitada por 429 cai como rota `unmatched` no Prometheus, então
**não dá para saber, só pela métrica da API, qual endpoint estava sendo
chamado quando foi limitado** (o k6 sabe, via `rate_limited_total{rota=...}`
no lado do cliente — ver resumo JSON). Vazão útil medida pelo k6 na mesma
janela: 3,03 req/s (`http_reqs{status:200}`, Seção 3.3).

### 4.3 Erros por segundo

&emsp; Nenhum 5xx genuíno (bug) observado — só os estados já documentados
como esperados: 429 (rate limiter, 156.986 acumulados), 503 em
`dashboard_overview`/`monitoring_overview`/`import_*`/`auth_login`/
`auth_callback`/`incident_event_detail` (todos fail-closed/DATA_UNAVAILABLE
por design), 401/404/400 de validação e controle de acesso. Consulta correta
para isolar erros reais quando a pilha estiver de pé:
`rate(http_requests_total{status_code=~"5..",route!="unmatched"}[1m])`
excluindo explicitamente `route="unmatched"` (que é dominado pelo rate
limiter, não por falha real).

### 4.4 Uso de CPU

&emsp; Capturado ao final da rodada `load` (processo acumulado desde o
início, ~220 mil requisições entre `smoke` e `load`):

| Métrica                                      |   Valor |
| :------------------------------------------- | ------: |
| `view_show_process_cpu_user_seconds_total`   | 31,02 s |
| `view_show_process_cpu_system_seconds_total` | 15,49 s |
| `view_show_process_resident_memory_bytes`    | 96,4 MB |
| `view_show_nodejs_eventloop_lag_seconds`     | 1,55 ms |

&emsp; Sem um limite de vCPU imposto (processo local, não contêiner), não é
possível calcular percentual de utilização comparável ao Fargate de
produção — apenas os segundos de CPU acumulados. Event loop lag baixo
(1,55 ms) indica que a thread principal não estava bloqueada, consistente
com a latência de negócio baixa (p95 64 ms) apesar do volume alto de 429.

---

## 5. Como reproduzir

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
