# Testes de Carga da API

> Este relatório preserva a linha de base ECS medida em 01/10/2026.
> Expressões como configuração atual se referem à configuração daquela rodada.
> O resultado nativo EKS e o estado da revisão final da Sprint 5 estão no
> [artefato consolidado](../testes-carga-finais.md). A migração não reatribui
> resultados ECS às imagens e recursos Kubernetes.


> Este documento registra o método, os resultados e a análise dos testes de carga da API de backend (`apps/backend/api`) na AWS: onde a configuração atual satura, por quê, e se ela atende os requisitos de disponibilidade (RNF09) e de latência de consulta (RNF14). Os brutos estão em `assets/testes-carga/`; como executar a suíte está no README de `apps/backend/api/loadtest/`.

## Sumário

1. [Introdução](#1-introdução)
2. [Escopo e método](#2-escopo-e-método)
3. [Ambiente de execução](#3-ambiente-de-execução)
4. [Perfis de carga](#4-perfis-de-carga)
5. [Resultados](#5-resultados)
6. [Análise](#6-análise)
7. [Limitações](#7-limitações)
8. [Conclusões e recomendações](#8-conclusões-e-recomendações)
9. [Referências](#9-referências)

---

## 1. Introdução

### 1.1 Objetivo

&emsp;O objetivo foi observar o comportamento da API sob níveis crescentes de carga, identificar a taxa em que a configuração implantada começa a degradar, atribuir a degradação a um recurso e verificar o RNF09 (disponibilidade de 99,9% sob carga sustentada) e o RNF14 (consulta em até 2 s no p95 a 137 req/s). A API é o backend consumido pelo painel e compõe as respostas a partir de dados operacionais e projeções no DynamoDB.

### 1.2 Convenções

- **Iteração:** uma execução da mistura de rotas do cenário k6; faz uma requisição (mais a segunda página de eventos, quando existe).
- **Taxa:** iterações iniciadas por segundo (modelo de chegada aberta); numa rampa, a taxa média é menor que a de pico.
- **p95 / p99:** percentis 95 e 99 da duração das respostas.
- **Iterações descartadas:** chegadas que o k6 não conseguiu iniciar por falta de VUs.
- **Aprovado ou reprovado:** refere-se aos thresholds do cenário (seção 2.4), não a um SLO de produção.

### 1.3 Documentos relacionados

&emsp;O [README da suíte](../../apps/backend/api/loadtest/README.md) explica como executar e interpretar os testes. Os planos de teste dos quinze RNFs e os resultados da suíte anterior (`consultas.js`) estão em [Testes de Carga e Observabilidade](../sprint3/testes-carga-inicial.md), mantido como registro histórico. Os brutos de cada execução estão no [índice de evidências](../../assets/testes-carga/README.md).

---

## 2. Escopo e método

### 2.1 Aplicação sob teste

&emsp;O alvo é `apps/backend/api`. O cenário `k6/front-api.js` sorteia uma rota por iteração conforme a Tabela 1, que modela as chamadas das telas do painel. Os pesos são uma estimativa, não uma medição de produção.

<div align="center">

<strong>Tabela 1: Mistura de rotas do cenário</strong>

</div>

| Rota | Chamada | Peso |
| --- | --- | ---: |
| Lista de incidentes | `GET /api/v1/incidents?window=24h` e variantes com filtros | 24% |
| Gráfico de incidentes | `GET /api/v1/incidents?window=1h&chartMetric=affected_devices` | 8% |
| Visão geral | `GET /api/v1/dashboard/overview` | 16% |
| Diagnóstico | `GET /api/v1/incidents/{id}/diagnosis` | 16% |
| Eventos do incidente | `GET /api/v1/incidents/{id}/events` | 10% |
| Eventos | `GET /api/v1/events` (lista e agregado de volume) | 10% |
| Monitoramento | `GET /api/v1/monitoring/overview` | 7% |
| Sessão | `GET /auth/session` | 4% |
| Telemetria do navegador | `POST /api/v1/telemetry/rum` (única escrita) | 4% |
| Integração Argus | `GET /api/v1/integrations/argus` | 1% |

<div align="center">

<sup>Fonte: pesos de `apps/backend/api/loadtest/k6/front-api.js`.</sup>

</div>

### 2.2 Exclusões

&emsp;Os testes não executam importação, ingestão, análise com LLM, reanálise nem revisão de hipóteses. O login no Cognito não é repetido sob carga: o runner prepara uma sessão assinada em memória, então os números medem as rotas protegidas com sessão válida e não o fluxo de autenticação. A entrega dos assets estáticos do painel e o tempo de renderização no navegador (RNF07) são medidos à parte e não fazem parte deste relatório.

### 2.3 Geração de carga

&emsp;O k6 usa executores de chegada aberta (`constant-arrival-rate` e `ramping-arrival-rate`): a taxa pedida não cai quando a API fica lenta, o que torna a saturação visível na latência, nos timeouts e nas iterações descartadas. O cenário reproduz o comportamento do cliente real em três pontos: timeout de 8 s por requisição (o painel desiste nesse prazo), validação do envelope `{data, meta}` que o painel exige e um `X-Request-Id` por requisição, conferido na resposta. O número máximo de VUs é dimensionado por taxa x timeout, para o gerador continuar emitindo a carga pedida quando as respostas demoram.

### 2.4 Massa de dados, verificações e critérios

&emsp;A massa é sintética: `seed-carga.cjs` grava 300 incidentes (4.123 itens: incidentes, projeções de visualização e um dataset versionado) na tabela operacional. As projeções envelhecem; sem novo seed, o dashboard responde 200 com o aviso `STALE_SNAPSHOT`, o que não muda o custo da requisição.

&emsp;Cada resposta é verificada por status, pelo envelope do gateway, pelo schema da lista de incidentes, pela ausência de campos físicos de persistência (`pk`, `sk`, `ttl`) e pelo eco do `X-Request-Id`. O 503 `DATA_UNAVAILABLE` só é aceito na rota de monitoramento; em qualquer outra rota é falha. O cenário também conta respostas parciais (`meta.partial`) e snapshots desatualizados, sem reprovar por elas.

<div align="center">

<strong>Tabela 2: Critérios de aprovação</strong>

</div>

| Métrica | Smoke | Load e soak | Stress, spike e breakpoint |
| --- | --- | --- | --- |
| Checks e sucesso do contrato | 100% | acima de 99,9% | acima de 98% |
| `http_req_failed` | 0% | abaixo de 0,1% | abaixo de 2% |
| p95 / p99 das respostas 200, global e por rota | < 2 s / < 5 s | < 2 s / < 5 s | < 2 s / < 5 s |
| Falha e contrato por rota | 0% | abaixo de 2% | abaixo de 2% |
| 429, timeouts de 8 s e iterações descartadas | nenhum | nenhum | nenhum |

<div align="center">

<sup>Fonte: thresholds de `front-api.js`; load e soak seguem o RNF09.</sup>

</div>

---

## 3. Ambiente de execução

<div align="center">

<strong>Tabela 3: Ambiente das rodadas de 01/10/2026</strong>

</div>

| Componente | Configuração |
| --- | --- |
| Conta e região | AWS Learner Lab `080158589617`, `us-east-1` |
| Caminho HTTP | API Gateway HTTP API, ALB, ECS Fargate |
| API | Uma tarefa de 256 CPU (0,25 vCPU) e 512 MiB; imagem `view-show-iac-api:6d40f7e2e6b2`; Node 22 |
| Autoscaling | 1 a 4 tarefas, CPU alvo de 50%, alarme de 3 pontos de 1 min, cooldown de 60 s (expansão) e 120 s (redução) |
| ALB | Health check em `/health` a cada 15 s, 2 sucessos e 3 falhas, timeout de 5 s |
| Persistência | DynamoDB sob demanda, seed de 300 incidentes |
| Gerador | k6 v2.2.0 no bastion da VPC (t3.micro, 2 vCPU, 0,9 GB); RTT de ~45 ms ao API Gateway |
| Rate limit | 180 req/min por IP, elevado a 1.000.000/min durante as rodadas e revertido |

<div align="center">

<sup>Fonte: configuração da stack e registros das rodadas.</sup>

</div>

&emsp;O gerador roda dentro da VPC porque, de fora da região, a mediana medida (~140 a 150 ms) é quase só o RTT de rede; de dentro, a mediana do mesmo perfil é de ~20 ms. O limite padrão de 180 req/min por IP é menor que a menor das taxas testadas além do smoke, então ele foi elevado por uma revisão temporária da definição da tarefa e revertido ao final; sem isso o k6 mediria o 429 e não a API. Os procedimentos estão no README da suíte.

---

## 4. Perfis de carga

<div align="center">

<strong>Tabela 4: Perfis executados em 01/10/2026</strong>

</div>

| Perfil | Chegada | Duração | Objetivo |
| --- | --- | ---: | --- |
| Smoke | 1/s constante | 30 s | Confirmar saúde, dados e checks |
| Load | rampa a 10/s em 30 s; 10/s por 5 min; saída em 15 s | 5m45s | Estabilidade sob carga sustentada |
| Soak | 15/s constante | 30 min | Degradação e vazamento ao longo do tempo |
| Breakpoint | degraus de 10, 15, 20, 25, 30, 35, 40 e 50/s; cada um sobe em 10 s e segura 50 s | 8 min | Achar a taxa em que a API cede |
| Spike | 10/s por 1 min; rampa a 40/s em 10 s; 40/s por 30 s; retorno a 10/s | 2m50s | Rajada de quatro vezes a taxa base e recuperação |
| Load a 137/s | rampa a 137/s em 30 s; 137/s por 5 min | 5m45s | Verificar o RNF14 |

<div align="center">

<sup>Fonte: estágios de `front-api.js`.</sup>

</div>

---

## 5. Resultados

### 5.1 Visão consolidada

<div align="center">

<strong>Tabela 5: Resultados das rodadas de 01/10/2026</strong>

</div>

| Perfil | Iterações | Carga emitida | Latência (p95 / p99) | Falhas | Thresholds |
| --- | ---: | ---: | --- | --- | --- |
| Smoke | 31 | 100% | p95 de até 88 ms por rota | 0% | 98 de 98 |
| Load, 10/s | 3.239 | 100% | patamar: 32 / 124 ms | 0% | 104 de 104 |
| Soak, 15/s por 30 min | 27.001 | 100% | p95 de 33 a 38 ms nos blocos de 5 min após a partida (73 ms no primeiro) | 0,02% (1 timeout) | 112 de 113 |
| Breakpoint | 13.017 | 98,2% | ver Tabela 6 | até 35% | 72 de 119 |
| Spike, 10 a 40/s | 2.852 | 98,4% | pico: p50 de 3,5 s; p95 no timeout de 8 s | 42% no pico (523 timeouts) | 64 de 110 |
| Load, 137/s | 24.734 | 56% | p50 no timeout de 8 s | 69% no patamar | 57 de 104 |

<div align="center">

<sup>Fonte: `assets/testes-carga/2026-10-01-aws-gerador-na-regiao/`.</sup>

</div>

&emsp;No soak, o único threshold reprovado foi o de timeouts (um timeout no primeiro bloco, na partida). O spike recuperou em cerca de 1 minuto: no último trecho de 10/s o p50 voltou a 22 ms.

<div align="center">

<strong>Tabela 6: Breakpoint, resultado por degrau</strong>

</div>

| Degrau | Requisições | Falha | p50 | p95 | p99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10/s | 554 | 0% | 21 ms | 86 ms | 288 ms |
| 15/s | 875 | 0% | 20 ms | 64 ms | 266 ms |
| 20/s | 1.175 | 0% | 19 ms | 49 ms | 253 ms |
| 25/s | 1.475 | 0% | 19 ms | 110 ms | 308 ms |
| 30/s | 1.775 | 0% | 21 ms | 503 ms | 1,24 s |
| 35/s | 1.996 | 24,9% | 3,6 s | 8 s | 8 s |
| 40/s | 2.296 | 29,9% | 5,0 s | 8 s | 8 s |
| 50/s | 2.871 | 34,7% | 4,2 s | 8 s | 8 s |

<div align="center">

<sup>Fonte: `breakpoint-patamares/` das rodadas de 01/10/2026. Os valores de 8 s são o timeout do cliente.</sup>

</div>

### 5.2 Validade das rodadas

&emsp;Uma rodada só sustenta conclusões se entregou a carga pretendida e o gerador não foi o limite. Nas rodadas de 10/s o ALB contou 600 req/min no patamar e 3.244 requisições no total, contra 3.243 do k6; no soak, 900 req/min (15/s) em todo o intervalo. O CPU do gerador ficou em no máximo 14% em todas as rodadas. Nas rodadas que saturaram, o k6 descartou 1,6% (spike) e 1,8% (breakpoint) das chegadas, o que não altera as conclusões. Na rodada de 137/s o gerador emitiu só 56% das 44.197 chegadas previstas, porque os 500 VUs esgotaram com cada requisição presa por 8 s (137 x 8 ≈ 1.100 VUs necessários); a falha de 69% medida é, portanto, um limite inferior e o RNF14 reprova com folga. O soak começou com 3 tarefas, porque o autoscaling desfez uma redução manual, e só caiu para 1 após cerca de 15 minutos; a primeira metade mediu 3 tarefas.

### 5.3 Experimentos locais complementares

&emsp;Quatro experimentos em máquina local, com a mesma imagem da API, apoiam a análise (brutos em `assets/testes-carga/2026-09-30-local/`).

<div align="center">

<strong>Tabela 7: Experimentos locais</strong>

</div>

| Experimento | Resultado |
| --- | --- |
| 300 contra 2.500 incidentes, 50/s por 90 s | CPU por requisição de 3,86 para 8,16 ms; p95 de 9 para 20,5 ms |
| Imagem real limitada a 0,25 vCPU, breakpoint em rampas | 0% de falha até 25/s (p95 de 54 ms); 1% e p95 de 3,3 s no degrau de 50/s; 30% de falha no de 75/s; CPU presa no teto |
| Mesma emulação, 25/s por 90 s | Com 300 incidentes, p95 de 41 a 151 ms; com 2.500, 65% de timeouts |
| Controles negativos | Com o DynamoDB fora do ar, o script original reprovou mas marcou `http_req_failed` em 0% com 96% de respostas 503; o revisado reprova por rota. Com limite de 180/min, 404 de 605 respostas foram 429 e o cenário reprovou |

<div align="center">

<sup>Fonte: `assets/testes-carga/2026-09-30-local/`.</sup>

</div>

### 5.4 Rodada inicial de 30/09/2026

&emsp;A primeira execução do cenário na AWS usou o script original e um gerador fora da região. Smoke, load (10/s) e stress (pico de 20/s) passaram e o spike (pico de 40/s) reprovou, com p95 de 24,8 s e 180 iterações descartadas. Essa rodada foi substituída pelas de 01/10: o script original não contava o 503 como falha, esperava 60 s em vez dos 8 s do cliente e a latência incluía o RTT de rede. Os resultados e as erratas estão em `assets/testes-carga/2026-09-30-aws-gerador-externo/`.

---

## 6. Análise

### 6.1 Capacidade

&emsp;Com 300 incidentes, uma tarefa de 0,25 vCPU responde sem falhas até 30 req/s, com p95 de 503 ms nesse patamar (sinal de saturação), e falha em 25% das requisições a 35 req/s. O consumo de CPU cresce cerca de 2,8 pontos percentuais por req/s e chega a 100% perto de 36 req/s, o que corresponde a 7 a 9 ms de vCPU por requisição. Com as quatro tarefas do limite do autoscaling, a capacidade teórica a 100% de CPU é de ~115 req/s. Atender 137 req/s exige cerca de 1,1 vCPU de trabalho útil, ou ~2,2 vCPU provisionados com o alvo de 50% de CPU. **O RNF14 não é atendido na configuração atual**; o teste de 137/s reprovou com 69% de falha. Já o RNF09 foi atendido na taxa em que a API opera com folga: 15/s por 30 minutos, sem degradação.

### 6.2 Recurso limitante

&emsp;O gargalo é a CPU da tarefa. Em todas as rodadas a memória ficou entre 14% e 23% e o `GetItem` do DynamoDB em torno de 2 ms, sem throttling. O API Gateway acrescenta cerca de 2 ms (latência média de ~19 ms contra ~18 ms de latência de integração). A emulação local da tarefa (7,3 ms de CPU por requisição) reproduz o joelho medido na AWS.

### 6.3 Health check e resiliência sob saturação

&emsp;O `/health` roda no mesmo processo da API. Com a CPU saturada, ele deixa de responder dentro do timeout de 5 s, o ALB marca a tarefa como não saudável e o ECS a substitui ("replaced 1 tasks due to an unhealthy status"), o que ocorreu no spike, no breakpoint e no teste de 137/s. Como só há uma tarefa, a capacidade vai a zero por cerca de 45 s, justamente no pico. No breakpoint em rampas o ALB gerou ~6.250 respostas 5xx e o API Gateway ~8.800; o cliente já tinha desistido aos 8 s, então o k6 só vê timeouts. Além disso, a API continua processando requisições cujo cliente já saiu, o que prolonga a saturação.

### 6.4 Autoscaling

&emsp;O alarme de expansão exige 3 pontos consecutivos de 1 min acima de 50% de CPU. No spike (apenas um minuto acima do alvo) e no breakpoint o alarme não teve nenhuma transição: a tarefa substituída zera a média de CPU do serviço e a sequência nunca se completa. No teste de 137/s a primeira expansão (desired=3) ocorreu às 23:04:47 BRT, quando o teste terminava, e a nova capacidade só ficou registrada ~6 minutos após o início da carga. A redução é lenta: no soak, 3 tarefas passaram a 1 após cerca de 15 minutos de CPU baixa. Em resumo, o autoscaling atual absorve uma subida gradual, mas não uma rajada.

### 6.5 Volume de dados

&emsp;Incidentes, diagnóstico e overview carregam a projeção inteira (um único item do DynamoDB) a cada requisição e filtram em memória, então o custo cresce com o número de incidentes. Localmente, de 300 para 2.500 incidentes a CPU por requisição mais que dobrou, e na emulação da tarefa a 25/s a API deixou de sustentar a carga (65% de timeouts). O limite físico é o item de 400 KB do DynamoDB (~3.300 incidentes). Essa medição não foi feita na AWS; a capacidade da seção 6.1 vale para 300 incidentes.

### 6.6 Limitador de taxa

&emsp;O limitador é por IP, em memória e por tarefa, e com `trust proxy` em produção a chave é o último endereço da cadeia `X-Forwarded-For`, ou seja, o do proxy e não o do usuário. Em teste local, 200 clientes distintos atrás do mesmo endereço esgotaram o balde de 180/min e um usuário novo também recebeu 429. Atrás do API Gateway isso indica que os usuários que saem pelo mesmo endereço do gateway dividem o mesmo limite; a topologia da AWS não foi confirmada com uma rajada. O limitador específico da telemetria do navegador (600/min) é fixo e o mapa de contadores nunca descarta entradas expiradas.

### 6.7 Rotas que não exercitam a API

&emsp;Cerca de 27% da mistura (eventos, 20%, e monitoramento, 7%) toca rotas que hoje respondem sem trabalho real, o que torna as latências mais otimistas que as de uma API completa: `monitoring/overview` é um stub que responde sempre 503; com o seed, `events` volta com 0 itens e incidentes e diagnóstico com `meta.partial=true`; e `GET /api/v1/incidents` devolve `hasMore=true` com `nextCursor=null`, de modo que a lista de incidentes não pagina. O cenário sinaliza as três situações no sumário. Além disso, as rotas de leitura respondem sem sessão (o `auth-check.js` reprova 14 de 37 checks), de modo que o cookie da simulação só é necessário em `/auth/session`, em eventos e na integração Argus.

---

## 7. Limitações

1. Os resultados valem para uma conta de laboratório, uma região, uma definição de tarefa (0,25 vCPU, imagem `6d40f7e2e6b2`) e 300 incidentes sintéticos. A rota de diagnóstico do `develop` posterior a essa imagem faz mais leituras no DynamoDB, então o custo por requisição pode mudar.
2. O efeito do volume de dados (2.500 incidentes) foi medido só localmente e em emulação, não na AWS.
3. A taxa de 137/s não foi emitida por completo (56%); um gerador com mais memória é necessário para essa taxa.
4. O limitador de taxa compartilhado atrás do API Gateway foi verificado só em teste local.
5. A massa sintética não passa pelo pipeline de ingestão e não representa a distribuição dos dados reais.
6. Os pesos da mistura são estimados. As telas se atualizam sozinhas (30 s na visão geral, 45 s em incidentes, 20 s no monitoramento); o modelo de chegada aberta não representa o número de usuários simultâneos.
7. A sessão é preparada antes da carga: login, callback SSO e Cognito sob carga não foram medidos.
8. A duração máxima foi de 30 minutos; não há medida para várias horas.

---

## 8. Conclusões e recomendações

&emsp;Uma tarefa de 0,25 vCPU sustenta até ~30 req/s com 300 incidentes. A configuração atual não atende o RNF14 (137 req/s): quatro tarefas a 100% de CPU somam ~115 req/s e o autoscaling não reage a tempo. O RNF09 foi atendido em 15/s por 30 minutos. Sob saturação a falha não é gradual: a tarefa é morta pelo health check e a capacidade cai a zero por cerca de 45 s.

&emsp;Recomendações, em ordem de impacto:

1. **Reduzir o custo por requisição.** Ler a projeção por incidente em vez de um item único e filtrar em memória, e cachear o overview por alguns segundos; esse custo cresce com o volume de dados.
2. **Dimensionar a capacidade para o RNF14.** São ~1,1 vCPU de trabalho útil a 137 req/s; com o alvo de 50% de CPU, ~2,2 vCPU provisionados (por exemplo, tarefas maiores ou um máximo de tarefas maior que 4).
3. **Evitar que a tarefa saturada seja morta.** Limitar a concorrência e responder 503 rapidamente acima do limite, cancelar o trabalho de requisições abandonadas e tornar o health check mais tolerante (timeout e número de falhas).
4. **Tornar o autoscaling reativo a rajadas.** Janela de avaliação menor (por exemplo, step scaling) e capacidade mínima maior nos horários de pico.
5. **Revisar o limitador de taxa.** Chavear no usuário ou no cliente real, com estado compartilhado entre tarefas ou delegado ao API Gateway, e descartar entradas expiradas do mapa.
6. **Melhorar os testes.** Repetir o breakpoint na AWS com 2.500 incidentes, usar um gerador maior para 137/s, confirmar o limitador com uma rajada na AWS, derivar os pesos da mistura das métricas de rota e passar a rodar `k6 inspect` dos cenários no CI.

---

## 9. Referências

- [README da suíte de carga](../../apps/backend/api/loadtest/README.md)
- [Cenário `front-api.js`](../../apps/backend/api/loadtest/k6/front-api.js) e [runner `run-aws.mjs`](../../apps/backend/api/loadtest/run-aws.mjs)
- [Evidências das rodadas de 01/10/2026](../../assets/testes-carga/2026-10-01-aws-gerador-na-regiao/README.md)
- [Experimentos locais](../../assets/testes-carga/2026-09-30-local/README.md)
- [Rodada de 30/09/2026 e erratas](../../assets/testes-carga/2026-09-30-aws-gerador-externo/README.md)
- [Índice de evidências](../../assets/testes-carga/README.md)
- [Testes de Carga e Observabilidade (Sprint 3)](../sprint3/testes-carga-inicial.md)
