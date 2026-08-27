# Relatório de Testes de Desempenho — API de Consulta

> Medição de comportamento sob carga controlada da API do View Show, seguindo o
> método do encontro **S04 · Testes de desempenho**: carga como variável de
> entrada; tempo de resposta, vazão e taxa de erro como resposta do sistema.
>
> Todos os números deste documento foram **medidos**, não estimados. Onde há
> estimativa ou projeção, está marcado como tal.

## Sumário

1. [Escopo e alvo](#1-escopo-e-alvo)
2. [Metodologia](#2-metodologia)
3. [Preparação do ambiente](#3-preparação-do-ambiente)
4. [Resultados](#4-resultados)
5. [Leitura do servidor](#5-leitura-do-servidor)
6. [Diagnóstico: a causa raiz](#6-diagnóstico-a-causa-raiz)
7. [Recomendações](#7-recomendações)
8. [Limitações do teste](#8-limitações-do-teste)
9. [Reprodutibilidade](#9-reprodutibilidade)

---

## 1. Escopo e alvo

&emsp; O alvo é a **API de consulta e diagnóstico** da branch `feat/backend-2`
(`apps/backend/api`), publicada em ECS Fargate no cluster
`data-ingestion-cluster` e exposta por um Application Load Balancer
*internet-facing*.

&emsp; **Uma correção de escopo precede os resultados.** O exemplo trabalhado na
aula é a API de ingestão (`POST /events`) do pipeline da Sprint 1. A arquitetura
atual **não expõe endpoint de ingestão** — suas rotas são consulta
(`/api/v1/incidents`, `/api/v1/dashboard/summary`), diagnóstico (`/diagnose`) e
curadoria (`/golden-set`). Isso muda o requisito aplicável: o SLA deixa de ser o
RNF03 (ingestão sem perdas) e passa a ser o **RNF14**.

| Item | Valor |
| --- | --- |
| Serviço ECS | `monitoracao-api-service` |
| Dimensionamento da task | **0,25 vCPU · 0,5 GB** (`cpu: "256"`, `memory: "512"`) |
| Tarefas em execução | 1 (`desiredCount: 1`) |
| Entrada | ALB `data-ingestion-alb`, *internet-facing* |
| Persistência | DynamoDB `monitoracao-operacional` (on-demand) |

> ⚠️ **Armadilha de nomenclatura registrada.** O serviço que responde pelo ALB
> chama-se `data-ingestion-service`, mas quem executa a API é o
> `monitoracao-api-service`. Essa confusão custou uma rodada inteira de
> diagnóstico errado — ver [§5.3](#53-o-erro-de-medição-e-o-que-ele-ensina).

## 2. Metodologia

### 2.1 Ferramenta e modelo de carga

&emsp; **k6 v2.2.0**, script versionado em
[`artefatos/testes-carga/k6/consultas.js`](./testes-carga/k6/consultas.js).

&emsp; A carga usa **modelo aberto** (`constant-arrival-rate` e
`ramping-arrival-rate`), não modelo fechado (`VU` + `sleep`). A razão é que um
operador de SRE não espera a API ficar rápida para outro abrir a tela: a taxa de
chegada é independente do tempo de resposta. Em modelo fechado, a carga cairia
sozinha conforme a API degradasse, **escondendo a saturação** — que é exatamente
o fenômeno que este teste precisa expor.

### 2.2 Carga: de onde vem o número

```
4,1 M sessões simultâneas em pico de evento ao vivo   ← entendimento_negocio.md
÷ 1.000  (fator de escala do MVP, declarado)
= 137 requisições/s  ← alvo do teste
```

&emsp; O fator de 1.000 é **arbitrário e declarado como tal**. A extrapolação
linear do resultado para o pico real é hipótese não validada, não conclusão.

### 2.3 Critérios de aprovação

| Threshold k6 | Origem | Observação |
| --- | --- | --- |
| `http_req_duration: p(95)<2000` | **RNF14** — *"retornar os resultados de uma busca filtrada em até 2 segundos para 95% das solicitações (P95)"* | única linha com SLA documentado |
| `http_req_failed: rate<0.01` | **RNF09** — disponibilidade ≥ 99,9% | traduzido para a janela do teste |
| `http_reqs: rate>130` | vazão mínima = alvo com 5% de folga | decisão do grupo |
| `checks: rate>0.99` | contrato das respostas | guarda-corpo, ver §3.2 |

### 2.4 Origem da carga

&emsp; O k6 rodou de uma instância **EC2 `c7a.large`** (2 vCPU, x86, desempenho
fixo) em `us-east-1`, a mesma região da API. A escolha por instância **não
burstable** é deliberada: em uma `t3`, os créditos de CPU se esgotariam durante
rodadas longas e o gerador viraria o gargalo.

![Execução do k6 a partir da instância EC2](../assets/testes-carga/01-execucao-ec2.png)

&emsp; **Prova de que a rede certa foi usada.** O `time_connect` medido contra o
ALB, cinco amostras de cada origem:

| Origem | `time_connect` mediano |
| --- | ---: |
| Máquina local (fora da AWS) | **~135 ms** |
| EC2 em `us-east-1` | **~1,4 ms** |

&emsp; Quase 100× de diferença. Uma medição feita da máquina local teria
atribuído à API cerca de um terço do orçamento de latência do RNF14 que, na
verdade, é distância de rede.

## 3. Preparação do ambiente

### 3.1 O seed de produção não serve para teste de carga

&emsp; O `scripts/seed.js` do repositório cria **4 incidentes**, suficientes para
o frontend exibir dado plausível. Medir contra isso exercita um caminho
praticamente vazio. Foi escrito um seed de carga
([`seed-carga.js`](./testes-carga/seed-carga.js)) com volume representativo:

| | `seed.js` | `seed-carga.js` |
| --- | ---: | ---: |
| Incidentes | 4 | **300** (12/hora × 25 h) |
| Itens totais | 11 | **2.341** |
| Casos na golden set | 3 | 120 |

&emsp; O gerador usa PRNG com semente fixa, de modo que duas execuções produzem a
mesma base e duas rodadas de teste são comparáveis entre si.

### 3.2 O dado envelhece — e isso quase invalidou o teste

&emsp; A consulta monta os buckets de hora **no instante da requisição**, e o
seed grava **no instante da execução**:

| `window` | Buckets varridos | Cobertura retroativa |
| --- | ---: | --- |
| `15m` / `1h` | 2 | ~1 h |
| *(ausente)* | 7 | ~6 h |
| `24h` | **25** | ~25 h |

&emsp; Na primeira tentativa, `window=24h` devolveu `{"incidents":[]}`: o seed
original tinha mais de 25 horas e havia saído de **todas** as janelas. Um teste
executado ali teria passado em todos os *thresholds* medindo o caminho vazio.

&emsp; Por isso o script inclui o *check* **`pesada: lista não vazia`**. Ele não
valida desempenho — valida que o teste está medindo alguma coisa. É o
guarda-corpo que impediu um falso positivo.

## 4. Resultados

### 4.1 Rodada 1 — smoke com base vazia (1 VU, 30 s)

&emsp; Executada antes do seed. Serve como **linha de base do custo fixo** da
API, sem qualquer dado a processar.

| Métrica | Valor |
| --- | ---: |
| `checks` | ✗ 77,63% (`lista não vazia`: 0 de 174) |
| `http_req_duration` p(95) | ✓ 208,7 ms |
| `http_req_failed` | ✓ 0,00% |
| Vazão | 11,39 req/s |
| Dados recebidos | 121 kB |

| Cenário | Queries no DynamoDB | Mediana |
| --- | ---: | ---: |
| `leve` — `window=15m` | 2 | 6,67 ms |
| `bundle` — GSI `trace-index` | 1 | 7,52 ms |
| `pesada` — `window=24h` | 25 | **105,35 ms** |

&emsp; **Leitura:** com a tabela vazia, o simples *fan-out* de 25 Queries
paralelas custa ~99 ms a mais que 2 Queries. As Queries são disparadas com
`Promise.all`; se o paralelismo fosse efetivo, a latência tenderia à da mais
lenta, não à soma.

### 4.2 Rodada 2 — smoke com 291 incidentes (1 VU, 30 s)

![Resumo do k6 com a base semeada](../assets/testes-carga/02-smoke-com-dados.png)

| Métrica | Vazio | **Com dado** | Fator |
| --- | ---: | ---: | ---: |
| `checks` | 77,63% | **100,00%** | — |
| p(95) geral | 208,7 ms | **589,3 ms** | 2,82× |
| Vazão | 11,39 req/s | **3,84 req/s** | 0,34× |
| Dados recebidos | 121 kB | **7,1 MB** | 59× |

| Cenário | Vazio | Com dado | Fator |
| --- | ---: | ---: | ---: |
| `bundle` — 1 Query no GSI | 7,52 ms | **7,58 ms** | **1,01×** |
| `leve` — 2 buckets, 15 itens | 6,67 ms | 11,03 ms | 1,65× |
| `pesada` — 25 buckets, 291 itens | 105,35 ms | **399,78 ms** | **3,79×** |

&emsp; **O `bundle` é o controle do experimento.** Ele consulta pelo GSI
`trace-index`, devolve 5 evidências, e **não se moveu**. Se houvesse degradação
geral da API, ele teria acompanhado. O que cresceu foi especificamente a rota
que devolve 291 objetos.

&emsp; Decomposição do custo da rota `pesada`:

```
com dado   400 ms
vazio      105 ms   ← fan-out de 25 Queries
           ─────
volume     295 ms   ← 74% do tempo total
```

### 4.3 Rodada 3 — load a 137 req/s (3 min de platô, 30 s de aquecimento)

| Threshold | Resultado |
| --- | --- |
| `checks: rate>0.99` | ✗ **8,19%** |
| `http_req_duration: p(95)<2000` | ✗ **60 s** (timeout) |
| `http_req_failed: rate<0.01` | ✗ **91,90%** |
| `http_reqs: rate>130` | ✗ **39,34/s** |

| Métrica | Valor |
| --- | ---: |
| Requisições emitidas | 10.034 |
| Requisições falhas | 9.222 (91,90%) |
| **Vazão bem-sucedida** | **~3,2 req/s** |
| Iterações descartadas | **17.801** |
| VUs alocados | até 800 (teto configurado) |
| p(95) das requisições **bem-sucedidas** | 36,99 s |

&emsp; **O achado central:**

> **800 VUs entregaram menos requisições bem-sucedidas (~3,2/s) do que 1 VU
> (3,84/s).**

&emsp; É a assinatura de saturação descrita na aula — *"a vazão para de crescer
enquanto os VUs sobem"* —, aqui em sua forma extrema: a vazão sequer chegou a
crescer. O sistema já operava no teto com um único cliente sequencial.

&emsp; As 17.801 iterações descartadas mostram que o k6 não conseguiu sequer
iniciar 64% da carga pretendida: todos os VUs pré-alocados estavam presos
aguardando resposta.

## 5. Leitura do servidor

&emsp; O k6 mede o sintoma do lado do cliente. A causa aparece no servidor.

### 5.1 CPU do container

![CPUUtilization do monitoracao-api-service em 99,93%](../assets/testes-carga/04-cpu-saturada.png)

| Métrica | Estatística | Valor |
| --- | --- | ---: |
| `CPUUtilization` (`monitoracao-api-service`) | **Maximum** | **99,93%** |

&emsp; Platô de saturação claramente visível entre 08:05 e 08:22 UTC. Como a
task reserva **0,25 vCPU**, 100% de utilização significa um quarto de núcleo
plenamente consumido.

### 5.2 DynamoDB

| Métrica | Estatística | Valor |
| --- | --- | ---: |
| `ConsumedReadCapacityUnits` | **Sum** | **58.000 / min** (~967 RCU/s) |
| `ReadThrottleEvents` | Sum | **sem datapoints** — zero eventos |

&emsp; **Não houve throttling.** O banco atendeu tudo que lhe foi pedido. O
gargalo está no container — mas o volume de leitura é anômalo, e é ele que
conduz ao diagnóstico da §6.

### 5.3 O erro de medição, e o que ele ensina

![Duas métricas de CPUUtilization no mesmo cluster](../assets/testes-carga/03-servico-errado.png)

&emsp; A primeira leitura do CloudWatch indicou **CPU em 0,092%** — ociosidade
total durante uma saturação de 91,9% de erro. Isso levou, por um momento, à
hipótese equivocada de exaustão de pool de conexões.

&emsp; Foram **três erros de medição encadeados**:

| # | Erro | Efeito |
| --- | --- | --- |
| 1 | Métrica lida do serviço `data-ingestion-service` | serviço ocioso; o que trabalha é o `monitoracao-api-service` |
| 2 | `CPUUtilization` em `Average` sobre 5 min | platô de 3 min diluído por períodos ociosos |
| 3 | `ConsumedReadCapacityUnits` em `Average` | 3 em vez de 58.000 |

&emsp; O registro deste erro é deliberado. **Cada leitura equivocada apontava
para uma causa raiz diferente e uma recomendação diferente** — e nenhuma delas
teria sido detectada sem cruzar a métrica com o comportamento observado no
cliente. É a razão pela qual a aula insiste que o k6 sozinho não descobre a
causa de um gargalo.

## 6. Diagnóstico: a causa raiz

&emsp; O volume de 967 RCU/s é cerca de **8× maior** do que o resultado devolvido
justificaria. A explicação está na convenção de chaves.

&emsp; Em `src/db/keys.js`:

```js
incidentSk(id)        →  `INCIDENT#${id}`
evidenceSk(id, seq)   →  `INCIDENT#${id}#EVIDENCE#001`
hypothesisSk(id, seq) →  `INCIDENT#${id}#HYPOTHESIS#0000000001`
```

&emsp; **Os três prefixos são idênticos.** E em `src/services/evidenceService.js`:

```js
KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
ExpressionAttributeValues: { ":pk": pk, ":prefix": "INCIDENT#" },
// …
.filter((item) => itemTypeFromSk(item.sk) === "INCIDENT")
```

&emsp; A condição de chave **não discrimina nada**: traz incidentes, evidências e
hipóteses do bucket inteiro, e o Node descarta as duas últimas categorias em
JavaScript, depois de já as ter lido do banco e desserializado.

&emsp; O seed quantifica: **2.341 itens para 300 incidentes**. Uma chamada
`window=24h` lê ~2.300 itens para devolver 291 — **~87% do que é lido e
processado é descartado**.

&emsp; A cadeia causal, com cada elo medido:

```
prefixo de sk não discrimina
        ↓
Query traz o bucket inteiro         → 967 RCU/s (medido)
        ↓
Node desserializa ~2.300 objetos    → CPU 99,93% em 0,25 vCPU (medido)
        ↓
resposta de 135 KB sem paginação    → 7,1 MB em 30 s com 1 VU (medido)
        ↓
teto de ~4 req/s                    → 3,84 req/s com 1 VU (medido)
        ↓
a 137 req/s: 91,9% de erro, p(95) de 60 s (medido)
```

&emsp; Um segundo problema, independente: **a API não pagina**. `GET
/api/v1/incidents` devolve 291 incidentes em um único JSON de 135 KB, sem `limit`
nem cursor. O tamanho da resposta cresce linearmente com a janela consultada,
sem teto.

## 7. Recomendações

| # | Correção | Esforço | Ganho estimado |
| --- | --- | --- | --- |
| **1** | **Discriminar o prefixo de `sk`**: `EVIDENCE#<id>#…` e `HYPOTHESIS#<id>#…` no lugar de `INCIDENT#<id>#…` | 2 linhas em `keys.js` + re-seed | ~8× em RCU e desserialização |
| **2** | **Paginar** `GET /api/v1/incidents` (`limit` + cursor) | média | teto no payload, hoje ilimitado |
| **3** | **Redimensionar** a task acima de 0,25 vCPU | configuração | linear, mas sem 1 e 2 apenas desloca o teto |

&emsp; A ordem importa. As correções 1 e 2 são **defeitos de projeto que nenhuma
quantidade de vCPU resolve**: o custo por requisição continua crescendo com a
janela consultada. Aumentar a CPU antes de corrigi-las trataria o sintoma.

&emsp; A correção 1 não afeta `getIncidentBundle`, que consulta pelo GSI
`trace-index` usando `trace_id` — presente em todos os itens independentemente
do `sk`. O `.filter` no serviço torna-se redundante.

&emsp; **Projeção, a validar por medição:** com a correção 1, a rota `pesada`
deveria cair de ~400 ms para a faixa de 120–180 ms, e o RCU para ~7–10 mil/min.
O `bundle` deve permanecer inalterado — ele é o controle.

## 8. Limitações do teste

&emsp; Um teste prova que, **naquela carga, naquele ambiente e naquele cenário**,
os critérios foram ou não atendidos. Fora disso não afirma nada. As restrições
desta rodada:

1. **Volume sintético.** 300 incidentes gerados por PRNG não reproduzem a
   distribuição real de tamanho, cardinalidade ou concentração temporal.
2. **Poucas partições.** IDs ordinais concentram leitura em poucas partições do
   DynamoDB; o teste **não** exercita *hot-spotting*.
3. **`BEDROCK_ENABLED=false`.** O endpoint `/diagnose` não invoca LLM; a latência
   da camada agêntica real não foi medida.
4. **`/diagnose` e `PATCH /hypothesis/review` ficaram fora da carga.** O primeiro
   escreve no banco a cada chamada (~25 mil escritas na rodada de `load`); o
   segundo promove casos à golden set e corromperia dado curado.
5. **O p(95) de 2 s vem do RNF14**, que trata de "busca filtrada no dashboard".
   Um SLA específico para esta API, negociado com o parceiro, mudaria o critério.
6. **Uma única task, sem autoscaling.** O resultado descreve a capacidade de uma
   instância, não da arquitetura com escala horizontal ativa.

## 9. Reprodutibilidade

| Artefato | Caminho |
| --- | --- |
| Script k6 | [`artefatos/testes-carga/k6/consultas.js`](./testes-carga/k6/consultas.js) |
| Seed de carga | [`artefatos/testes-carga/seed-carga.js`](./testes-carga/seed-carga.js) |
| Runbook | [`artefatos/testes-carga/README.md`](./testes-carga/README.md) |
| Resumos exportados | `resumo-load.json`, `resumo-breakpoint.json` |

```bash
# 1. semear (notebook, com credencial AWS)
cd apps/backend/api && CLEAN=1 node scripts/seed-carga.js

# 2. na EC2, em us-east-1
k6 run -e BASE_URL=http://<alb> -e MODE=smoke consultas.js
k6 run -e BASE_URL=http://<alb> -e MODE=load --summary-export=resumo-load.json consultas.js
```

&emsp; O parâmetro `KEY_SCHEME=v2` no seed grava com o prefixo corrigido da
recomendação 1, permitindo medir o ganho **sem redeployar a imagem** — a Query
em produção passa a casar apenas com incidentes. É prova de conceito, não a
correção definitiva, que exige alterar `keys.js` e reconstruir a imagem.

---

### Conclusão

&emsp; A API **não atende ao RNF14** sob a carga alvo, e a distância não é
marginal: a capacidade sustentável medida é de **~4 requisições por segundo**
contra as 137 pretendidas — um fator de **34×**.

&emsp; A causa, porém, não é dimensionamento. É uma condição de chave que faz
cada consulta ler oito vezes mais dados do que devolve, somada à ausência de
paginação. **São dois defeitos de código, revelados por medição**, e nenhum dos
dois apareceria em revisão de código isolada ou em teste funcional — as duas
rotas retornam exatamente o resultado correto, apenas a um custo que só a carga
expõe.
