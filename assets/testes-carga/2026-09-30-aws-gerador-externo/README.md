# Rodada AWS de 30/09/2026 — gerador externo, script original

**Status: histórica.** Primeira execução do `k6/front-api.js` na AWS (commit `3764b18`), com o k6 em uma
máquina fora da região. Os brutos estão aqui como foram medidos, mas as conclusões originais não se
sustentavam (veja "Erratas"). A medição de referência é a de
[`2026-10-01-aws-gerador-na-regiao/`](../2026-10-01-aws-gerador-na-regiao/README.md), analisada em
[`artefatos/sprint5/testes-de-carga-da-api.md`](../../../artefatos/sprint5/testes-de-carga-da-api.md).

## Ambiente

| Componente | Configuração |
| --- | --- |
| Conta / região | AWS Learner Lab `908494055566` / `us-east-1` (stack temporária, destruída ao final) |
| Entrada | API Gateway HTTPS (`https://s8s2rl5v1c.execute-api.us-east-1.amazonaws.com/`) |
| API | ECS Fargate `view-show-iac-api-service` (cluster `view-show-iac-cluster`), 256 CPU e 512 MiB; autoscaling de 1 a 4 tarefas por CPU |
| Persistência | Tabela operacional do DynamoDB com o seed sintético (4.110 itens normais, 10 de projeção de visualização e 4 de dataset versionado) |
| Rate limit | 180/min elevado para 20.000/min pelo preset protegido `loadtest-20000` e restaurado com o preset `baseline` |
| Gerador | k6 em uma única máquina, fora da região (mediana de ~140 a 150 ms, compatível com o RTT de uma rede externa) |

O runner `run-aws.mjs` conferiu a conta, esperou o `/health` responder 200 e leu o segredo de sessão
da definição da tarefa, só em memória.

## Perfis e resultados

Taxas em iterações por segundo; `RATE=10` é a base de load, stress e spike.

| Perfil | Chegada | Duração |
| --- | --- | ---: |
| Smoke | 1/s constante | 30 s |
| Load | rampa de 1 a 10/s em 30 s; 10/s por 5 min; saída em 15 s | 5m45s |
| Stress | 10/s por 1 min; rampa a 20/s em 30 s; 20/s por 3 min; retorno a 10/s | 6 min |
| Spike | 10/s por 1 min; rampa a 40/s em 10 s; 40/s por 30 s; retorno a 10/s | 2m50s |

| Perfil | Iterações (taxa média) | Requisições | Descartadas | p95 / p99 geral | p95 / p99 HTTP 200 | Falhas HTTP inesperadas ¹ | Contrato | Checks | `503 DATA_UNAVAILABLE` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Smoke | 30 (0,99/s) | 31 | 0 | 278 / 280 ms | 278 / 280 ms | 0 | 100% | 100% (96/96) | 3 |
| Load | 3.239 (9,38/s) | 3.240 | 0 | 256 / 362 ms | 258 / 364 ms | 0 | 100% | 100% (10.533/10.533) | 208 |
| Stress | 5.699 (15,81/s) | 5.700 | 0 | 262 / 414 ms | 263 / 418 ms | 0 | 100% | 100% (18.458/18.458) | 435 |
| Spike | 2.719 (15,95/s) | 2.720 | 180 | 24,83 / 30,12 s | 18,58 / 28,86 s | 0 | 97,17% | 98,20% (8.534/8.690) | 285 |

¹ O script marcava 503 como resposta esperada em todas as rotas, então a coluna não conta 503.

Nenhuma rodada produziu 429. Smoke, load e stress atenderam os thresholds. O spike reprovou os de
duração, contrato e iterações descartadas: a mediana foi de 262 ms, mas o p90 foi de 11,4 s. Na rajada,
77 iterações falharam a métrica de contrato e 156 checks individuais falharam.

Ao final, a stack foi removida pela rotina protegida de destruição (`Apply complete! Resources: 0 added,
0 changed, 129 destroyed.`); o cluster ECS ficou `INACTIVE` e a VPC, as tabelas e os buckets da stack
deixaram de existir.

## Erratas

Revisão de 30/09 a 01/10, com novas execuções e leitura do código da API. Os itens abaixo já estão
corrigidos no relatório atual e no script.

| # | Afirmação original | O que a revisão encontrou |
| --- | --- | --- |
| 1 | Em 15% das consultas de incidentes com cursor o script pede a página 2, por isso as requisições excedem as iterações | `GET /api/v1/incidents` devolve `hasMore: true` com `nextCursor: null` em todas as respostas (`incident-use-cases.ts`, `list()`), então a página 2 nunca foi pedida. A requisição a mais que as iterações, em todas as rodadas, é o `/health` do `setup()`. A paginação por cursor do painel é a de Eventos |
| 2 | Os 503 do monitoramento decorrem de snapshots que envelhecem | `monitoring()` é um stub que responde sempre `503 DATA_UNAVAILABLE`. Os contadores (3, 208, 435, 285) são cerca de 7% das iterações, o peso da rota, e não dependem do tempo de seed. A rota não foi exercitada. O envelhecimento afeta `dashboard/overview` (200 com `STALE_SNAPSHOT`) |
| 3 | "Falhas HTTP inesperadas = 0" | `setResponseCallback(200, 503)` valia para todas as rotas, então `http_req_failed` nunca contava 503. Com o banco fora do ar, 96% das respostas foram 503 e a métrica marcou 0%. Só `checks` e o contrato percebiam |
| 4 | Contrato de 97,17% na rajada | O painel desiste após 8 s (`REQUEST_TIMEOUT` em `apps/frontend/lib/data/client.ts`) e o k6 esperava 60 s. Com p90 de 11,4 s, pelo menos 10% das requisições teriam virado "indisponível" na tela e contavam como sucesso se voltassem 200 |
| 5 | A API mantém p99 abaixo de 500 ms | Vale para 10 a 20 iterações/s, 7% a 15% dos 137 req/s do RNF14, e a latência incluía o RTT de uma rede externa. De dentro da VPC a mediana do mesmo perfil é de ~20 ms e o limite está em ~30 req/s por tarefa |
| 6 | Massa de 300 incidentes | A leitura de incidentes, diagnóstico e overview carrega a projeção inteira (um item do DynamoDB) a cada requisição; com 2.500 incidentes o custo de CPU por requisição passou de 3,9 para 8,2 ms. A capacidade medida vale para 300 incidentes |

## Arquivos

`resumo-front-api-<perfil>.json`: saída do `handleSummary()` do k6 para smoke, load, stress e spike
(cookie de sessão redigido).
