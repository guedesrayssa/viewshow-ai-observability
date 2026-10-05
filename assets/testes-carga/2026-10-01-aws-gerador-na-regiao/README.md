# Rodadas AWS de 01/10/2026 — gerador dentro da região

**Status: vigente.** Medição de referência da API na AWS, com o `k6/front-api.js` revisado. A análise
está em [`artefatos/sprint5/testes-de-carga-da-api.md`](../../../artefatos/sprint5/testes-de-carga-da-api.md);
aqui ficam os brutos e as condições de cada rodada.

## Condições

| Item | Valor |
| --- | --- |
| Conta / região | AWS Learner Lab `080158589617` / `us-east-1` |
| Gerador | k6 v2.2.0 no bastion da VPC (t3.micro, 2 vCPU, 0,9 GB, `us-east-1a`), alvo no API Gateway (`https://0s1i46nqgi.execute-api.us-east-1.amazonaws.com`); RTT de ~45 ms ao API Gateway e ~5 ms ao ALB |
| API | ECS Fargate `view-show-iac-api-service`, 256 CPU / 512 MiB, imagem `view-show-iac-api:6d40f7e2e6b2`; autoscaling de 1 a 4 tarefas por CPU (alvo 50%) |
| Rate limit | Elevado a 1.000.000/min por uma revisão temporária da definição da tarefa (`:5`) e revertido ao padrão de 180/min (`:4`) ao final |
| Dados | Seed sintético de `seed-carga.cjs` com 300 incidentes (4.123 itens), aplicado uma vez antes das rodadas e desfeito depois (a tabela voltou idêntica ao backup). Sem novo seed entre as rodadas, as respostas de dashboard trazem `STALE_SNAPSHOT` |

## Rodadas

Horários em UTC. Cada pasta tem `resumo-k6.json` (saída do k6, cookie redigido), `sumario.txt` (sumário
impresso) e `cloudwatch.json` (métricas por minuto, exceto no smoke).

| Pasta | Perfil | Janela | Observação |
| --- | --- | --- | --- |
| `smoke` | 1/s, 30 s | 01:28:08 a 01:28:38 | |
| `spike-rate10` | 10 a 40/s | 01:29:47 a 01:32:38 | 47 chegadas descartadas (1,6%) |
| `load-rate10` | 10/s por 5 min | 01:34:36 a 01:40:22 | O ALB contou 3.244 requisições; o k6, 3.243 |
| `breakpoint-rampas` | rampas de 10 a 150/s | 01:51:30 a 01:57:38 | Rampas lineares: a taxa média de cada degrau não é a rotulada. Superado por `breakpoint-patamares`; mantido pelas métricas de 5xx do ALB e do API Gateway |
| `load-rate137` | 137/s por 5 min (RNF14) | 01:58:56 a 02:04:49 | 19.463 de 44.197 chegadas não emitidas (os VUs esgotaram); a falha é um limite inferior |
| `soak-rate15-30min` | 15/s por 30 min | 02:07:20 a 02:37:21 | Começou com 3 tarefas (o autoscaling desfez um `desired=1` manual) e só caiu para 1 após ~15 min |
| `breakpoint-patamares` | degraus de 10, 15, 20, 25, 30, 35, 40 e 50/s (sobe 10 s, segura 50 s) | 02:38:43 a 02:46:51 | 237 chegadas descartadas (1,8%) |

As rodadas `spike-rate10`, `load-rate10`, `breakpoint-rampas`, `load-rate137` e `soak-rate15-30min` usaram
a versão do script anterior ao dimensionamento de `maxVUs` por taxa x timeout (500 VUs em `load`, 700 em
`breakpoint`); `breakpoint-patamares` usou a versão atual.

## Séries de `cloudwatch.json`

Período de 60 s. ECS (`CPUUtilization` média e máxima, `MemoryUtilization`); ALB (`RequestCount`,
`HTTPCode_Target_2XX/4XX/5XX_Count`, `HTTPCode_ELB_5XX_Count`, `TargetResponseTime` média e p95,
`HealthyHostCount`, `UnHealthyHostCount`, `TargetConnectionErrorCount`); API Gateway (`Count`, `4xx`, `5xx`,
`Latency` média e p95, `IntegrationLatency`); DynamoDB (`ConsumedReadCapacityUnits`, `ReadThrottleEvents`,
`SuccessfulRequestLatency` de `GetItem`). O arquivo é a lista crua de `get-metric-data`, com `Id`, `Label`,
`Timestamps` e `Values` por série.
