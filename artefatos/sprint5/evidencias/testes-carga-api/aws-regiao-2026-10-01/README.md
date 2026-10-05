# Rodadas AWS com gerador dentro da região — 01/10/2026

Rodadas do `k6/front-api.js` (versão revisada) contra a stack do Learner Lab
(conta `080158589617`, `us-east-1`), com o k6 v2.2.0 instalado no bastion
(t3.micro, 2 vCPU, 0,9 GB, `us-east-1a`) e alvo no API Gateway
(`https://0s1i46nqgi.execute-api.us-east-1.amazonaws.com`). Do bastion o RTT é de
~45 ms ao API Gateway e ~5 ms ao ALB; da rede de casa, ~190 ms. A API estava com uma
task Fargate de 256 CPU / 512 MiB (revisão `view-show-iac-api-task:4`, alterada para
a `:5` só para elevar `RATE_LIMIT_PER_MINUTE` a 1.000.000), autoscaling 1–4 por CPU
alvo 50%, e a tabela `view-show-iac-operacional` com o seed sintético de 300
incidentes (`seed-carga.cjs`, 4.123 itens).

Cada pasta tem `resumo-k6.json` (saída do k6, cookie redigido), `sumario.txt`
(sumário impresso) e `cloudwatch.json` (ECS, ALB, API Gateway e DynamoDB por minuto,
coletados com `get-metric-data`).

| Pasta | Perfil | Início–fim (epoch UTC) | Resultado |
| --- | --- | --- | --- |
| `smoke` | 1/s, 30 s | 1790818088–1790818118 | 98/98 thresholds; p50 20–45 ms |
| `spike-rate10` | 10→40/s | 1790818187–1790818358 | pico com 42% de falha; 523 timeouts de 8 s; CPU 84% (máx. 99,6%); task substituída por health check |
| `load-rate10` | 10/s por 5 min | 1790818476–1790818822 | 104/104 thresholds; patamar p50 20 / p95 32 / p99 124 ms; CPU 31–39% |
| `breakpoint-rampas` | rampas 10→150/s | 1790819490–1790819858 | 0% de falha até 25/s; 21% em r50; 57–70% em r75–r150; task substituída 2x |
| `load-rate137` | 137/s por 5 min (RNF14) | 1790819936–1790820289 | 69% de falha no patamar; 19.463 de 44.197 chegadas não emitidas |
| `soak-rate15-30min` | 15/s por 30 min | 1790820440–1790822241 | 27.001 iterações; p95 de 30 a 38 ms; memória 16,7%→17,3% |
| `breakpoint-patamares` | degraus de 10 a 50/s (sobe 10 s, segura 50 s) | 1790822323–1790822811 | 0% de falha até 25/s; p95 503 ms a 30/s; 25% de falha a 35/s |

## Como ler

- **Joelho:** o patamar de 30/s já mostra a saturação (p95 503 ms, p99 1,2 s) e o de
  35/s falha em 25%. A CPU da task cresce ~2,8 pontos percentuais por req/s e chega a
  100% perto de 36 req/s; isso equivale a ~7–9 ms de vCPU por requisição. Memória
  fica em 14–23% e o DynamoDB não registra throttling (`GetItem` ≈ 2 ms), então o
  gargalo é a CPU da task.
- **Health check:** nas rodadas saturadas a task falhou no `/health` do ALB e o ECS a
  substituiu ("replaced 1 tasks due to an unhealthy status"). Isso zera a capacidade
  por ~45 s no pior momento, zera a média de CPU do serviço e impede o alarme de
  scale-out (3 pontos consecutivos acima de 50%) de disparar: `spike-rate10` e
  `breakpoint-rampas` não tiveram atividade de autoscaling; em `load-rate137` o
  scale-out (desired=3) só ocorreu às 23:04:47 BRT, no fim da rodada.
- **Carga entregue:** em `load-rate10` o ALB contou 600 req/min no patamar (10/s) e o
  total de 3.244 requisições bate com as 3.243 do k6. Em `load-rate137` o gerador só
  emitiu 24.734 das 44.197 chegadas previstas, porque os 500 VUs esgotam quando cada
  requisição fica 8 s presa (137 x 8 ≈ 1.100 VUs). A conclusão (falha) vale, mas a
  carga efetiva foi ~70 req/s. O script revisado dimensiona `maxVUs` por taxa x timeout.
- **Respostas 5xx:** o k6 vê só timeouts (status 0). O ALB gerou ~6.250 respostas 5xx
  próprias no `breakpoint-rampas` e o API Gateway ~8.800; o cliente já tinha desistido.
- **Limitações:** a rodada `soak` começou com 3 tasks (o autoscaling desfez um
  `desired=1` manual) e só caiu para 1 após ~15 min de CPU baixa; a primeira metade mediu
  3 tasks. As rodadas `spike`, `load`, `breakpoint-rampas`, `load-rate137` e `soak` usaram
  a versão do script anterior ao dimensionamento de VUs; `breakpoint-patamares` usou a
  versão final. 22% do mix toca rotas que respondem sem trabalho real (monitoramento é
  stub, eventos vazios). O volume de dados é o do seed (300 incidentes); com mais
  incidentes o custo por requisição sobe (medido localmente: 3,9 → 8,2 ms de CPU de 300
  para 2.500).
