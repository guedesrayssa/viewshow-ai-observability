# Testes de Carga da API

> Este documento registra o planejamento, o método e os resultados das execuções de carga da API de backend consumida pelo frontend View Show. O escopo deste artefato é o módulo da API; sua organização permite que os resultados sejam incorporados posteriormente a um relatório consolidado dos módulos do sistema.

## Sumário

1. [Introdução](#1-introdução)
2. [Escopo do módulo](#2-escopo-do-módulo)
3. [Método de teste](#3-método-de-teste)
4. [Cenários e critérios](#4-cenários-e-critérios)
5. [Ambiente de execução](#5-ambiente-de-execução)
6. [Resultados](#6-resultados)
7. [Análise](#7-análise)
8. [Limitações](#8-limitações)
9. [Reprodução](#9-reprodução)
10. [Encerramento do ambiente](#10-encerramento-do-ambiente)
11. [Referências e evidências](#11-referências-e-evidências)
12. [Revisão técnica e erratas](#12-revisão-técnica-e-erratas)

---

## 1. Introdução

### 1.1 Objetivo

&emsp;O objetivo foi observar o comportamento da API sob níveis crescentes de carga e identificar a faixa em que a configuração testada começa a apresentar degradação. A API recebe as consultas do frontend e compõe respostas a partir de dados operacionais e projeções armazenadas no DynamoDB.

&emsp;Foram executados quatro perfis em uma stack temporária na AWS: verificação básica (*smoke*), carga sustentada (*load*), estresse (*stress*) e rajada (*spike*). Os resultados das seções 6 e 7 correspondem às execuções realizadas em 30/09/2026. A reexecução de 01/10/2026, com o gerador dentro da região e métricas de CloudWatch, está na seção 12.1 e é a base das conclusões de capacidade.

### 1.2 Organização para consolidação

&emsp;Este é o relatório específico do módulo `apps/backend/api`. Os resultados, critérios, limites e evidências estão agrupados por esse módulo para permitir sua incorporação posterior a um documento geral de testes de carga. A consolidação poderá referenciar esta seção como o capítulo da API e acrescentar capítulos equivalentes para frontend, ingestão e demais módulos, sem atribuir a este relatório conclusões sobre esses outros componentes.

&emsp;O planejamento e os resultados da rodada local, além da matriz histórica de requisitos não funcionais, permanecem no documento [Testes de Carga e Observabilidade](../sprint3/testes-carga-inicial.md). Este relatório detalha a rodada AWS posterior.

### 1.3 Convenções

- **Iteração:** uma execução da mistura de rotas configurada no cenário k6. Uma iteração pode gerar mais de uma requisição quando há paginação.
- **Req/s:** taxa de chegada de iterações por segundo configurada no gerador; não representa necessariamente a taxa média observada durante etapas de subida e descida.
- **p95 / p99:** percentis 95 e 99 de duração. Quando indicado, referem-se somente às respostas HTTP 200.
- **Iterações descartadas:** chegadas que k6 não conseguiu iniciar dentro da taxa programada.
- **`DATA_UNAVAILABLE`:** resposta `503` esperada pela suíte para a projeção de monitoramento quando ela não está disponível ou seu snapshot envelheceu.
- **Resultado aprovado/reprovado:** refere-se aos thresholds automatizados desta suíte e deste perfil, não a um SLO de produção.

---

## 2. Escopo do módulo

### 2.1 Aplicação sob teste

&emsp;O alvo foi `apps/backend/api`, a API HTTP usada pelo frontend. A suíte simulou uma mistura de consultas semelhante às sessões de navegação do painel, usando autenticação válida e identificadores de requisição exclusivos.

<div align="center">

<strong>Tabela 1: Recursos cobertos pela suíte da API</strong>

</div>

| Recurso consultado | Operação exercitada | Peso na escolha de rota |
| --- | --- | ---: |
| Incidentes | Listagem, filtros por janela, prioridade e status | 32% |
| Dashboard | `GET /api/v1/dashboard/overview` | 18% |
| Diagnóstico | `GET /api/v1/incidents/{id}/diagnosis` | 16% |
| Eventos do incidente | `GET /api/v1/incidents/{id}/events` | 12% |
| Eventos globais | `GET /api/v1/events` | 10% |
| Monitoramento | `GET /api/v1/monitoring/overview` | 7% |
| Sessão | `GET /auth/session` | 4% |
| Integração Argus | `GET /api/v1/integrations/argus` | 1% |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026), conforme pesos de `front-api.js`.</sup>

</div>

&emsp;O script previa solicitar uma segunda página em 15% das consultas de incidentes que oferecessem cursor, mas a API não devolve cursor nessa rota (`nextCursor` é sempre `null`), então nenhuma segunda página foi pedida. As requisições excedem as iterações em uma só, a checagem `/health` do `setup()` (ver seção 12, item 1).

### 2.2 Exclusões

&emsp;A bateria avaliou o plano HTTP de consulta da API. Não executou rotas de importação nem tarefas batch, pipeline de ingestão, normalização, análise ou chamadas a LLM. Também não submeteu escrita funcional de incidentes. A persistência recebeu somente dados sintéticos para preparar o cenário de consulta.

&emsp;O login Cognito não foi repetido sob carga. O runner preparou uma sessão assinada em memória antes de iniciar as iterações. Dessa forma, os números medem as rotas protegidas com sessão válida, e não a capacidade do fluxo de autenticação.

---

## 3. Método de teste

### 3.1 Geração de carga

&emsp;Foi usado k6 com executores de chegada aberta (`constant-arrival-rate` e `ramping-arrival-rate`). O gerador tenta iniciar iterações conforme a taxa configurada, mesmo que as respostas fiquem mais lentas. Esse modelo torna visível a saturação por meio da latência, dos VUs adicionais e das iterações que não puderam ser iniciadas.

&emsp;Cada iteração escolhe uma rota pela distribuição da Tabela 1. As consultas de incidentes também alternam entre filtros. Um identificador `X-Request-Id` é criado para cada requisição e sua presença na resposta é conferida.

### 3.2 Massa de dados

&emsp;Antes de cada perfil, a rotina AWS preparou a tabela operacional com dados sintéticos. O seed incluiu 4.110 itens normais, 10 itens de projeção de visualização e 4 itens de dataset versionado. A massa permite exercitar paginação, filtros e respostas do dashboard sem executar o pipeline que produziria esses dados em produção.

&emsp;As projeções têm validade limitada. Em rodadas de vários minutos, snapshots do dashboard ou do monitoramento podem ultrapassar a janela de frescor mesmo que tenham sido criados antes do início do teste.

### 3.3 Verificações e métricas

&emsp;Além da duração HTTP, a suíte verifica o status e o formato mínimo das respostas, o schema da listagem de incidentes, a ausência de campos físicos internos e o eco do identificador de requisição. Para a rota de monitoramento, aceita `503 DATA_UNAVAILABLE` como estado conhecido do contrato.

<div align="center">

<strong>Tabela 2: Thresholds configurados no cenário k6</strong>

</div>

| Métrica | Smoke | Load, stress e spike |
| --- | --- | --- |
| Checks de resposta e conteúdo | 100% (`rate == 1`) | acima de 98% (`rate > 0.98`) |
| Sucesso do contrato por iteração | 100% (`rate == 1`) | acima de 98% (`rate > 0.98`) |
| `http_req_failed` | 0% (`rate == 0`) | abaixo de 2% (`rate < 0.02`) |
| p95 das respostas 200 | abaixo de 2 s | abaixo de 2 s |
| p99 das respostas 200 | abaixo de 5 s | abaixo de 5 s |
| Respostas 429 | nenhuma | nenhuma |
| Iterações descartadas | nenhuma | nenhuma |

<div align="center">

<sup>Fonte: thresholds definidos em `apps/backend/api/loadtest/k6/front-api.js`.</sup>

</div>

&emsp;A medição de erro HTTP considera os status inesperados. Um `503 DATA_UNAVAILABLE` vindo da rota de monitoramento está marcado como resposta esperada pelo k6 e contabilizado separadamente. A taxa de sucesso do contrato considera essa condição somente para a rota de monitoramento; nas demais rotas, espera HTTP 200.

---

## 4. Cenários e critérios

&emsp;Os quatro perfis executados estão resumidos na Tabela 3. Taxas são iterações iniciadas por segundo, conforme configuração do cenário. `RATE=10` define a base do perfil load, stress e spike; os estágios de rampa alteram a pressão ao longo do tempo.

<div align="center">

<strong>Tabela 3: Perfis de carga executados</strong>

</div>

| Perfil | Perfil de chegada | Duração aproximada | Objetivo |
| --- | --- | ---: | --- |
| Smoke | 1 iteração/s constante | 30 s | Confirmar saúde, autenticação, dados e checks antes de cargas maiores |
| Load | rampa de 1 a 10/s em 30 s; 10/s por 5 min; rampa de saída de 15 s | 5m45s | Observar estabilidade sob carga sustentada |
| Stress | 10/s por 1 min; subida para 20/s em 30 s; 20/s por 3 min; retorno a 10/s e sustentação | 6 min | Medir resposta a aproximadamente o dobro da taxa base |
| Spike | 10/s por 1 min; subida para 40/s em 10 s; 40/s por 30 s; retorno a 10/s e sustentação | 2m50s | Avaliar uma rajada de quatro vezes a taxa base e a recuperação |

<div align="center">

<sup>Fonte: Material produzido pelos autores (2026), conforme os estágios de `front-api.js`.</sup>

</div>

&emsp;Os perfis `breakpoint` e `soak` estão implementados na suíte, mas não foram executados nesta rodada AWS. O teste foi encerrado após a rajada demonstrar degradação acentuada.

---

## 5. Ambiente de execução

<div align="center">

<strong>Tabela 4: Configuração do ambiente AWS utilizado</strong>

</div>

| Componente | Configuração observada |
| --- | --- |
| Conta | AWS Learner Lab `908494055566` |
| Região | `us-east-1` |
| Entrada HTTP | API Gateway HTTPS, integrado à stack temporária |
| URL usada | `https://s8s2rl5v1c.execute-api.us-east-1.amazonaws.com/` |
| Serviço da API | ECS Fargate `view-show-iac-api-service` no cluster `view-show-iac-cluster` |
| Tarefa da API | 256 CPU e 512 MiB de memória |
| Auto scaling | mínimo 1 e máximo 4 tarefas, alvo por CPU |
| Persistência | tabela operacional do DynamoDB com seed sintético |
| Gerador | k6 executado em uma única máquina, fora da região da AWS (mediana de ~140 a 150 ms, compatível com o RTT de uma rede externa) |

<div align="center">

<sup>Fonte: configuração da stack e registros das execuções realizadas em 30/09/2026.</sup>

</div>

&emsp;A stack do Learner Lab possuía rate limit nominal de 180 requisições por minuto, insuficiente para medir as taxas dos perfis. Para as rodadas de carga, o preset protegido `loadtest-20000` elevou temporariamente o limite para 20.000 requisições por minuto. Após os testes, o preset `baseline` restaurou o limite nominal de 180 requisições por minuto.

&emsp;O runner `run-aws.mjs` conferiu o ID da conta antes de operar, verificou que o serviço ECS estava ativo, esperou a rota `/health` responder HTTP 200 e leu o segredo de sessão da definição ativa da tarefa somente em memória. O segredo não foi impresso nem incluído nos arquivos de resultado.

---

## 6. Resultados

### 6.1 Visão consolidada

&emsp;A Tabela 5 resume os valores dos arquivos brutos k6. As durações p95 e p99 são da métrica completa `http_req_duration`; a coluna adicional de p95/p99 HTTP 200 indica as respostas válidas usadas pelos thresholds de latência. As taxas observadas são médias da execução inteira e, portanto, são menores que a taxa de pico nas rodadas com rampa. As latências foram medidas por um gerador fora da região e incluem o RTT de rede: de dentro da VPC, a mediana de um perfil equivalente é de ~20 ms (seção 12.1). Os valores da coluna "Falhas HTTP inesperadas" não contam respostas 503, que o script tratava como esperadas em todas as rotas; os indicadores efetivos de falha são as colunas Contrato e Checks (seção 12, item 3).

<div align="center">

<strong>Tabela 5: Resumo quantitativo das execuções AWS</strong>

</div>

| Perfil | Iterações (taxa média) | Requisições | Iterações descartadas | p95 / p99 geral | p95 / p99 HTTP 200 | Falhas HTTP inesperadas | Contrato | Checks | `503 DATA_UNAVAILABLE` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke | 30 (0,99/s) | 31 | 0 | 278 / 280 ms | 278 / 280 ms | 0 | 100% | 100% (96/96) | 3 |
| Load | 3.239 (9,38/s) | 3.240 | 0 | 256 / 362 ms | 258 / 364 ms | 0 | 100% | 100% (10.533/10.533) | 208 |
| Stress | 5.699 (15,81/s) | 5.700 | 0 | 262 / 414 ms | 263 / 418 ms | 0 | 100% | 100% (18.458/18.458) | 435 |
| Spike | 2.719 (15,95/s) | 2.720 | 180 | 24,83 / 30,12 s | 18,58 / 28,86 s | 0 | 97,17% | 98,20% (8.534/8.690) | 285 |

<div align="center">

<sup>Fonte: arquivos JSON em `apps/backend/api/loadtest/results/aws/`. Valores de latência arredondados para apresentação. Latências medidas de fora da região.</sup>

</div>

&emsp;As quatro rodadas não produziram resposta 429. Os checks incluem mais de uma verificação por iteração, pois podem conferir status, conteúdo, identificador e paginação. Durante a spike, 77 iterações falharam a métrica de sucesso do contrato e 156 checks individuais falharam.

&emsp;Cópias dos resumos JSON foram preservadas em `artefatos/sprint5/evidencias/testes-carga-api/aws/` para que esta documentação e a futura consolidação permaneçam apoiadas por evidências mesmo quando os resultados gerados localmente forem ignorados pelo Git. O campo de sessão nos arquivos está redigido.

### 6.2 Smoke

&emsp;O perfil curto gerou 30 iterações e 31 requisições em aproximadamente 30 segundos. Não descartou chegadas, não recebeu 429 e concluiu todos os 96 checks e todos os checks de contrato. Três respostas `503 DATA_UNAVAILABLE` foram aceitas para monitoramento.

&emsp;O p95 foi 278 ms e o p99 280 ms. Os thresholds do smoke foram atendidos.

### 6.3 Load

&emsp;O perfil de carga sustentou a taxa configurada de 10 iterações/s durante cinco minutos, precedida por uma rampa de 30 segundos e seguida por uma rampa de saída de 15 segundos. No total, o k6 registrou 3.239 iterações e 3.240 requisições em aproximadamente 5m45s.

&emsp;Não houve iteração descartada, resposta 429, erro HTTP inesperado (o script não contava 503) ou falha de check. O p95 foi 256 ms e o p99 362 ms na métrica geral; nas respostas 200, o p95 foi 258 ms e o p99 364 ms. O perfil atendeu os thresholds configurados.

### 6.4 Stress

&emsp;O perfil começou em 10 iterações/s, passou por rampa de 30 segundos até 20/s e sustentou essa taxa durante três minutos, retornando depois à taxa base. Ao longo de aproximadamente seis minutos, foram concluídas 5.699 iterações e 5.700 requisições. A taxa média completa foi 15,81 iterações/s, abaixo do pico configurado por causa dos estágios de rampa e recuperação.

&emsp;Não houve iteração descartada, resposta 429, erro HTTP inesperado (o script não contava 503) ou falha de check. O p95 foi 262 ms e o p99 414 ms na métrica geral; nas respostas 200, 263 ms e 418 ms, respectivamente. O perfil atendeu os thresholds configurados.

### 6.5 Spike

&emsp;O perfil elevou a taxa de chegada de 10 para 40 iterações/s em dez segundos, manteve o pico durante 30 segundos e retornou à taxa base. A execução completa durou aproximadamente 2m50s, com 2.719 iterações concluídas e 2.720 requisições registradas.

&emsp;A rajada resultou em 180 iterações descartadas. A latência geral alcançou p95 de 24,83 segundos e p99 de 30,12 segundos; considerando somente respostas HTTP 200, os percentis foram 18,58 e 28,86 segundos. A taxa de sucesso do contrato ficou em 97,17%, abaixo do limite de 98%, e a taxa de checks ficou em 98,20%. O perfil **reprovou** thresholds de duração, contrato e iterações descartadas, apesar de não haver resposta 429 nem falha HTTP contada pelo script (que não considerava o 503).

&emsp;O painel desiste de uma requisição após 8 s (`REQUEST_TIMEOUT` em `apps/frontend/lib/data/client.ts`), enquanto o k6 esperava até 60 s. Com mediana de 262 ms e p90 de 11,4 s, pelo menos 10% das requisições teriam virado "indisponível" na tela, inclusive as que o script contou como sucesso por voltarem 200.

---

## 7. Análise

### 7.1 Capacidade observada

&emsp;As rodadas de 30/09 sustentam apenas o seguinte: com a mistura de rotas sintéticas, 300 incidentes e uma tarefa de 0,25 vCPU, a API respondeu sem falhas e com p99 abaixo de 500 ms nos perfis load (10 iterações/s) e stress (pico de 20/s), em rodadas de poucos minutos. Essa latência foi medida de fora da região e inclui o RTT de rede. O resultado não pode ser extrapolado para outras taxas, outros volumes de dados ou outras durações, nem para a taxa do RNF14 (137 req/s), que é de 7 a 14 vezes maior que a dos perfis load e stress.

&emsp;A rajada de 40 iterações/s encontrou um limite claro. A latência aumentou em ordens de grandeza, surgiram chegadas descartadas e a taxa do contrato caiu abaixo do critério. A configuração não absorveu a rajada sem degradação, mesmo que as requisições concluídas não tenham retornado 429 nem falha HTTP contada pelo script.

&emsp;A reexecução de 01/10, com o gerador dentro da região e métricas de CloudWatch (seção 12.1), localiza o limite. Com 300 incidentes, uma tarefa de 0,25 vCPU respondeu sem falhas até 30 req/s, com p95 de 503 ms nesse patamar, e passou a falhar em 25% das requisições a 35 req/s. O gargalo é a CPU da tarefa (cerca de 7 a 9 ms de vCPU por requisição), com memória entre 14% e 23% e sem throttling no DynamoDB. Com as quatro tarefas do limite do autoscaling, a capacidade teórica a 100% de CPU é de cerca de 115 req/s, abaixo dos 137 req/s do RNF14, e o autoscaling não reage a tempo a uma rajada (seção 7.2). Na configuração atual, portanto, o RNF14 não é atendido. O teste de 137 iterações/s reprovou com 69% de falha e, como o gerador emitiu só 56% da carga prevista, esse valor é um limite inferior.

&emsp;A capacidade medida vale para 300 incidentes. Incidentes, diagnóstico e overview carregam a projeção inteira (um item do DynamoDB) a cada requisição e, em testes locais, o custo de CPU por requisição passou de 3,9 ms para 8,2 ms ao subir de 300 para 2.500 incidentes. Esse efeito não foi medido na AWS.

### 7.2 Auto scaling e recuperação

&emsp;Durante a execução de spike, o serviço chegou a duas tarefas ativas, enquanto o perfil de load e stress não precisou desse aumento. O scale out observado não evitou a elevação de latência da rajada: a criação de capacidade não foi instantânea e a pressão acumulada no caminho de requisições persistiu. Esse teste não permite concluir qual componente específico foi o gargalo; seria necessário correlacionar as métricas de API Gateway, ECS, ALB e DynamoDB em uma nova rodada. Essa correlação foi feita na reexecução de 01/10 (seção 12.1): o limite é a CPU da tarefa, e o scale out só dispara depois de três minutos consecutivos acima de 50%, o que uma rajada de 30 a 40 s não alcança.

&emsp;Uma hipótese a avaliar é iniciar o teste com mais tarefas ou pré-aquecer a capacidade. Outra é instrumentar e correlacionar o tempo de escala com a latência de cada serviço. Essas são propostas de experimento e não foram validadas por esta bateria.

### 7.3 Indisponibilidade de projeção

&emsp;O contador `front_api_data_unavailable_total` registrou respostas 503 da rota de monitoramento: 3 no smoke, 208 no load, 435 no stress e 285 no spike, cerca de 7% das iterações, o peso da rota no mix. A rota `monitoring/overview` é um stub que sempre responde `503 DATA_UNAVAILABLE` nesta versão da API (ver seção 12, item 2); os valores não decorrem do envelhecimento dos snapshots.

&emsp;Essas ocorrências foram contabilizadas à parte. Elas não representam falha HTTP inesperada, mas significam que a tela de Monitoramento do painel não recebe dado algum e que 7% do mix não exercitou a API.

---

## 8. Limitações

1. A conclusão representa uma conta Learner Lab, uma região, uma definição de tarefa e uma mistura específica de consultas. A massa tem 300 incidentes. Não é uma capacidade garantida para produção nem comprova disponibilidade mensal.
2. O k6 foi executado em uma única máquina, fora da região da AWS, então as latências medidas incluem o RTT de rede; a reexecução de 01/10 usou um gerador dentro da VPC. O teste não modela múltiplos geradores distribuídos nem clientes com redes geograficamente distintas.
3. A massa sintética foi inserida diretamente na tabela operacional. Os resultados não medem ingestão, transformação, publicação de projeção, nem comportamento com distribuição e volume representativos dos dados reais.
4. Os snapshots de dashboard envelhecem (a API passa a responder 200 com o aviso `STALE_SNAPSHOT`). A rota de monitoramento responde sempre `DATA_UNAVAILABLE`, por ser um stub.
5. A sessão válida foi preparada antes da carga. Os resultados não caracterizam throughput de login, callback SSO ou Cognito sob carga.
6. O perfil `breakpoint` — degraus de carga até 150 iterações/s — e o perfil `soak` de longa duração não foram executados nesta rodada AWS; foram executados na reexecução de 01/10 (seção 12.1), com soak de 30 min. Não há medida para carga sustentada por várias horas.
7. A falha no spike indica saturação do conjunto API Gateway, ECS, aplicação e dependências, mas os JSON k6 não identificam sozinhos o recurso limitante. Atribuição de causa exige métricas de infraestrutura correlacionadas, o que foi feito na reexecução de 01/10.

---

## 9. Reprodução

### 9.1 Requisitos

&emsp;A reprodução requer a stack da API aplicada, acesso AWS CLI à mesma conta esperada, Terraform configurado para ler os outputs da stack, Node.js e k6 disponíveis. A stack usada neste relatório foi destruída após a execução; estes comandos não recriam a infraestrutura.

### 9.2 Execução dos perfis

```bash
cd apps/backend/api

# Repetir este seed imediatamente antes de cada perfil. Use o nome da tabela
# retornado pela stack ativa no ambiente que será testado.
ALLOW_REMOTE_SEED=1 AWS_REGION=us-east-1 \
  OPERATIONAL_TABLE_NAME=view-show-iac-operacional \
  node scripts/seed-carga.cjs
EXPECTED_AWS_ACCOUNT_ID=908494055566 MODE=smoke node loadtest/run-aws.mjs

ALLOW_REMOTE_SEED=1 AWS_REGION=us-east-1 \
  OPERATIONAL_TABLE_NAME=view-show-iac-operacional \
  node scripts/seed-carga.cjs
EXPECTED_AWS_ACCOUNT_ID=908494055566 MODE=load RATE=10 node loadtest/run-aws.mjs

ALLOW_REMOTE_SEED=1 AWS_REGION=us-east-1 \
  OPERATIONAL_TABLE_NAME=view-show-iac-operacional \
  node scripts/seed-carga.cjs
EXPECTED_AWS_ACCOUNT_ID=908494055566 MODE=stress RATE=10 node loadtest/run-aws.mjs

ALLOW_REMOTE_SEED=1 AWS_REGION=us-east-1 \
  OPERATIONAL_TABLE_NAME=view-show-iac-operacional \
  node scripts/seed-carga.cjs
EXPECTED_AWS_ACCOUNT_ID=908494055566 MODE=spike RATE=10 node loadtest/run-aws.mjs
```

&emsp;Antes de cada linha de execução k6, semeie novamente os dados; o seed envelhece e não deve ser executado uma única vez para a bateria inteira. O exemplo acima mostra uma rodada, portanto, repita o bloco de seed antes dos outros perfis. Confirme o nome da tabela para a stack ativa. `ALLOW_REMOTE_SEED=1` é obrigatório para autorizar escrita remota, e `CLEAN=1` não deve ser usado na tabela AWS.

&emsp;O runner verifica a conta informada, o serviço ECS e a saúde da API antes de iniciar a execução, obtém a sessão em memória e salva o resumo k6 em `apps/backend/api/loadtest/results/aws/`. Para taxas acima do limite nominal da API, a stack precisa estar com o preset temporário de rate limit; restaure o preset `baseline` imediatamente ao terminar.

&emsp;Para executar o perfil local, consulte o [README operacional da suíte](../../apps/backend/api/loadtest/README.md). A configuração local não substitui uma medição da stack AWS, pois CPU, rede e banco de dados diferem.

---

## 10. Encerramento do ambiente

&emsp;Depois das execuções, o preset `baseline` foi aplicado para restaurar o rate limit nominal de 180 requisições por minuto. Em seguida, a stack foi removida pela rotina protegida de destruição, que registrou:

```text
Apply complete! Resources: 0 added, 0 changed, 129 destroyed.
```

&emsp;A verificação posterior encontrou o cluster ECS como `INACTIVE`, sem serviços ativos ou tarefas em execução; não encontrou a VPC, tabelas DynamoDB ou buckets da stack. O estado Terraform ficou sem recursos gerenciados.

---

## 11. Referências e evidências

### 11.1 Resultados brutos

- [Resumo smoke](evidencias/testes-carga-api/aws/resumo-front-api-smoke.json)
- [Resumo load](evidencias/testes-carga-api/aws/resumo-front-api-load.json)
- [Resumo stress](evidencias/testes-carga-api/aws/resumo-front-api-stress.json)
- [Resumo spike](evidencias/testes-carga-api/aws/resumo-front-api-spike.json)

### 11.2 Implementação e documentos relacionados

- [Cenário k6 da API](../../apps/backend/api/loadtest/k6/front-api.js)
- [Runner AWS](../../apps/backend/api/loadtest/run-aws.mjs)
- [README da suíte de carga](../../apps/backend/api/loadtest/README.md)
- [Plano e resultados locais, RNFs e observabilidade](../sprint3/testes-carga-inicial.md)

---

## 12. Revisão técnica e erratas

&emsp;Em 30/09/2026 a suíte foi revisada executando-a de novo (DynamoDB Local, emulação da task com a mesma imagem e limite de CPU da AWS, controles negativos) e lendo o código da API e do frontend. A revisão corrigiu o script `front-api.js` e o `README` da suíte e registrou aqui o que, neste relatório, não se sustenta. Os números das seções 6 e 7 continuam sendo os brutos dos arquivos JSON; o que muda é a leitura deles.

<div align="center">

<strong>Tabela 6: Erratas e ressalvas</strong>

</div>

| # | Afirmação neste relatório | O que a revisão encontrou |
| --- | --- | --- |
| 1 | Seção 2.1: em 15% das consultas de incidentes com cursor o script pede uma segunda página, por isso as requisições podem exceder as iterações | `GET /api/v1/incidents` devolve `hasMore: true` com `nextCursor: null` em todas as respostas (`incident-use-cases.ts`, `list()`), então a segunda página nunca foi pedida. A diferença de uma requisição a mais que as iterações em todas as rodadas é a checagem `/health` do `setup()`. A paginação por cursor do painel é a da tela de Eventos, que o script não exercitava |
| 2 | Seção 7.3: os `503 DATA_UNAVAILABLE` do monitoramento decorrem de snapshots que envelhecem durante a rodada | `monitoring()` é um stub que responde sempre `503 DATA_UNAVAILABLE` (`dashboard-queries.ts`). Os contadores (3, 208, 435, 285) equivalem a cerca de 7% das iterações, o peso da rota no mix, e não dependem do tempo de seed. A rota não foi exercitada em nenhuma rodada. O envelhecimento de snapshot existe, mas afeta `dashboard/overview` (200 com aviso `STALE_SNAPSHOT`) |
| 3 | Tabela 5: "Falhas HTTP inesperadas = 0" | O script marcava 503 como resposta esperada em **todas** as rotas (`setResponseCallback(200, 503)`), então `http_req_failed` nunca contava 503. Em um controle negativo com o banco fora do ar, 96% das respostas foram 503 e a métrica marcou 0%. Só `checks` e o contrato percebiam |
| 4 | Seção 6.5: contrato de 97,17% na rajada | O painel desiste após 8 s (`REQUEST_TIMEOUT` em `apps/frontend/lib/data/client.ts`) e o k6 esperava 60 s. Na rajada, a mediana foi 262 ms e o p90 11,4 s: pelo menos 10% das requisições teriam virado "indisponível" na tela, mas contavam como sucesso se voltassem 200. O script corrigido usa o mesmo limite de 8 s |
| 5 | Seção 7.1: a API mantém p99 abaixo de 500 ms | Vale para 10 a 20 iterações/s, cerca de 7% a 15% dos 137 req/s do RNF14, em uma task de 0,25 vCPU. Numa emulação local dessa task (mesma imagem, `--cpus=0.25`), a latência estava baixa até 25 req/s (p95 de 54 ms), degradou a 50 req/s (p95 de 3,3 s) e desmoronou a 75 req/s (30% de falhas por timeout), com a CPU presa no teto de 25%. Isso é coerente com a rajada de 40/s da AWS. A seção 7.1 foi reescrita com base nesses dados |
| 6 | Seção 3.2: massa de 300 incidentes | A leitura de incidentes, de diagnóstico e do overview carrega a projeção inteira (um item do DynamoDB) a cada requisição e filtra em memória. Com 2.500 incidentes o custo de CPU por requisição passou de 3,9 ms para 8,2 ms. A capacidade medida vale para 300 incidentes |
| 7 | Seção 1.2: outros capítulos cobririam o frontend (o script se chama `front-api.js`, e o commit e o README falavam em "testes de carga do frontend") | A suíte mede só a API. O painel é um export estático no Amplify: a entrega dos assets (CloudFront, brotli, mas `Cache-Control: max-age=0` também nos arquivos com hash), o salto do Amplify e o tempo de renderização (RNF07) não foram medidos, e o `/metrics` da API não tem nenhuma amostra de Web Vitals: nenhum navegador real reportou até agora |

&emsp;Status: os itens 1 a 5 foram corrigidos no corpo do texto (seções 2.1, 6.1, 6.3 a 6.5, 7.1 a 7.3 e 8); os itens 6 e 7 permanecem como ressalvas.

&emsp;O script corrigido imprime o resultado por rota e por fase, valida o envelope `{data, meta}` que o painel exige, confere a massa antes de gastar a rodada e deixa de tratar 503 como esperado fora do monitoramento. Detalhes de uso e limites conhecidos estão no [README da suíte](../../apps/backend/api/loadtest/README.md).

### 12.1 Reexecução na AWS com o gerador dentro da região (01/10/2026)

&emsp;As rodadas da seção 6 saíram de uma máquina fora da AWS: a mediana de ~150 ms era quase só o RTT até `us-east-1`. Na reexecução o k6 rodou no bastion da própria VPC (RTT de ~45 ms ao API Gateway), com o script revisado, a stack em uma task Fargate de 0,25 vCPU e o seed de 300 incidentes. Os brutos, os sumários e as métricas de CloudWatch estão em [`evidencias/testes-carga-api/aws-regiao-2026-10-01/`](evidencias/testes-carga-api/aws-regiao-2026-10-01/README.md).

<div align="center">

<strong>Tabela 7: Resultados da reexecução na AWS</strong>

</div>

| Perfil | Resultado | Leitura |
| --- | --- | --- |
| Load, 10/s por 5 min | 3.239 iterações, 104/104 thresholds, patamar p50 20 / p95 32 / p99 124 ms, CPU da task 31–39% | Os 256 ms de p95 da seção 6.3 eram rede. O servidor sustenta 10/s com folga |
| Soak, 15/s por 30 min | 27.001 iterações, p95 de 30 a 38 ms em todos os blocos, memória 16,7%→17,3% | Sem degradação nem vazamento em 30 min. A primeira metade rodou com 3 tasks (autoscaling) |
| Breakpoint em patamares de 50 s | 0% de falha até 25/s; a 30/s p95 de 503 ms; a 35/s 25% de falha; 40/s 30%; 50/s 35% | Joelho entre 30 e 35 req/s por task. A CPU chega a 100% perto de 36 req/s (~7–9 ms de vCPU por requisição) |
| Spike, 10→40/s | 42% de falha no pico, 523 timeouts de 8 s, recuperação em ~1 min | Reproduz a seção 6.5. A task chegou a 99,6% de CPU |
| Load, 137/s (RNF14) | 69% de falha no patamar; 19.463 de 44.197 chegadas não emitidas | RNF14 reprovado. O gerador emitiu ~70 req/s efetivos, então é um limite inferior da falha |

&emsp;Três conclusões que as rodadas de 30/09 não permitiam tirar:

1. **O gargalo é a CPU da task.** Memória em 14–23% e `GetItem` do DynamoDB em ~2 ms, sem throttling, em todas as rodadas. Com ~8 ms de vCPU por requisição, uma task de 0,25 vCPU esgota em ~30 req/s e as quatro tasks do limite do autoscaling somariam ~115 req/s a 100% de CPU, abaixo dos 137 do RNF14.
2. **O health check mata a task no pior momento.** Nas rodadas saturadas o `/health` do ALB (intervalo 15 s, 3 falhas, timeout 5 s) não respondeu e o ECS registrou "replaced 1 tasks due to an unhealthy status" (spike, breakpoint e load a 137/s). A capacidade vai a zero por ~45 s, o ALB passa a devolver 5xx próprios (~6.250 no breakpoint em rampas) e o API Gateway ~8.800; o cliente já tinha desistido aos 8 s, então o k6 só vê timeouts.
3. **O autoscaling não protege contra picos.** O alarme exige 3 pontos de 1 min acima de 50%; o spike e o breakpoint não geraram nenhuma atividade de scaling (o alarme teve 0 transições), porque a task substituída zera a média. Na rodada a 137/s o scale-out (desired=3) ocorreu às 23:04:47 BRT, quando o teste terminava, ~6 min depois do início.

&emsp;Validade das rodadas: nas de 10/s o ALB contou 600 req/min no patamar e 3.244 requisições no total, contra as 3.243 do k6, e o CPU do gerador ficou abaixo de 15%, então a carga pretendida foi entregue. Na de 137/s não foi: faltaram VUs (137 x 8 s ≈ 1.100) e 44% das chegadas foram descartadas; o script corrigido dimensiona `maxVUs` por taxa x timeout.
