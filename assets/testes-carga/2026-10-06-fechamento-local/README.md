# Fechamento local dos testes não funcionais — 06/10/2026

Esta pasta registra execução dos componentes reais em laboratório local, com
MySQL em Docker, DynamoDB Local, API Node 22 e Prometheus/Grafana. Os resultados
não são atribuídos ao ECS nem ao Amplify. [Análise consolidada](../../../artefatos/testes-carga-finais.md).

## Evidências

| Arquivo/pasta | Experimento e conteúdo | Estado e alcance |
| --- | --- | --- |
| `environment.json` | runtime, plataforma, base commit e hash da fonte na coleta | diferencia a revisão base da fonte complementar e da imagem AWS |
| `timeout-mysql.json` | leitura normal; lock real de tabela; timeout de 1 s, duas tentativas; erro 2013 em 2,017 s; recuperação em 5,866 ms | aprovado no leitor/retry wrapper; não comprova estado terminal de uma task ECS |
| `reader-150000.json` | MySQL keyset, 150.000 registros, desconexão na página 40, 1 retry, zero faltantes/duplicados | leitura em 1,487 s, p95 das páginas 12,824 ms; não inclui persistência/projeção/arquivo |
| `reader-300000.json` | mesmo método com 300.000 | bruto identificado; leitura de fonte, não vazão end-to-end |
| `reader-750000.json` | 750.000 registros, desconexão, 1 retry, zero faltantes/duplicados | leitura em 14,321 s, p95 34,759 ms; completa o volume na fronteira do leitor |
| `mass-*.json` | hashes, distribuição temporal, tabelas e contagens das massas | dados determinísticos; dump gerado fica fora do Git |
| `stream-validated/stream-summary.json` | 1.000 eventos/6 s por 15 min; consulta independente de todos os campos canônicos e replay | **aprovado:** 150.000/150.000; zero faltantes, extras, duplicados e diferenças; p95 de lote 1,179 s; atraso máximo 0,279 s; replay written=0/unchanged=1000 |
| `stream-validated/stream-samples.json` | 150 amostras com relógio, taxa oferecida/persistida, duração e atraso | intervalo configurado 23:36:49,923–23:51:49,923 UTC; último lote concluído em 894,965 s |
| `stream-validated/launch.json` | SHA-256 exato do harness ao lançar a coleta | distingue fonte executada de revisões posteriores da verificação |
| `stream-initial-invalid/` | primeiro fluxo chegou aos 150 mil reportados, mas verificação no destino em memória saturou | inválido para comprovar integridade; não é usado para aprovação |
| `multidataset-contention.json` | dois datasets/grupos FIFO, lease ocupado, cinco recebimentos e duas mensagens na DLQ | defeito reproduzido; RNF03 reprovado nesse caso; Moto/doubles declarados |
| `pytest-resilience.xml` | 168 testes de resiliência, heartbeat, retries e ports observados | 168 aprovados; componente não substitui benchmark AWS |
| `pytest-multidataset.xml` | reproducer específico de concorrência entre grupos | 1 aprovado significa reproducer consistente, não requisito aprovado |
| `node-tests.txt` | controles do k6, disponibilidade, contrapressão e proteção/reversão de política | 19 aprovados (incluindo orçamento proporcional e queries visíveis) |
| `api-baseline/`, `api-load-137/` | primeira rodada válida de smoke e load com 2.500 incidentes | load: 44.098 requisições, zero falha inesperada, 103 chegadas descartadas; manter limites de interpretação por rota |
| `api-battery/` | rodada com destino persistente, controle de indisponibilidade e recuperação no mesmo processo; soak 30 min | consultar brutos e exit codes individuais |
| `observability/` | respostas por painel Grafana, séries Prometheus, targets e validação numérica | o gate exige amostras, status 200 e ausência de erro |
| `grafana-local.png` | captura real do dashboard na janela UTC registrada | viewport do navegador; consultas completas estão nos JSON, sem fabricar imagem |

O primeiro controle de reinício do destino foi invalidado porque o DynamoDB
Local estava em memória e perdeu a massa. O leito foi corrigido para usar volume
persistente, e a bateria foi repetida. O smoke de destino indisponível termina
com falha de preflight (exit 107): é controle negativo da disponibilidade, não
uma medição de latência aprovada. Fonte anterior inválida foi preservada localmente
fora da entrega; o load válido anterior permanece identificado.

O source hash de `environment.json` é explicitamente o **da coleta**. A fonte do
harness foi formatada e recebeu validação adicional após iniciar a primeira
coleta; não se apresenta esse hash como identificação retroativa do bytecode
executado. O commit da aplicação sob teste é a base `eca9de4`; o script de
experimento complementar é distinguido da aplicação.

## Observabilidade e semântica

![Grafana com os dez indicadores da execução válida](stream-validated/grafana-local.png)

A janela válida é 06/10 23:36:49–23:51:50 UTC. O
[gate](stream-validated/observability/observability-validation.json) verificou
cada query visível dos dez painéis. O p95 do lote no gráfico é móvel (1 min)
e aproximado pelos buckets do histograma; o p95 de 1,179 s no resumo usa as
150 durações individuais da execução inteira. Eles não são a mesma estatística.

Latência HTTP é do servidor; k6 inclui transporte. O counter de erro do Grafana
conta os 503 do monitoramento, enquanto o k6 aceita essa indisponibilidade
explicitamente apenas nessa rota. Cerca de 3,5 erros HTTP/s na figura são os 503 da rota de monitoramento
explicitamente indisponível (aproximadamente 7% da mistura de 50/s), que não
aprovam sua funcionalidade. CPU é percentual de um núcleo, não percentual
da reserva ECS. O dashboard da ingestão local mede a normalização/persistência,
com CPU real do processo, latência real de lotes e eventos oferecidos/persistidos.
O host executava experimentos simultâneos; estes números não dimensionam produção.

## Reprodução

[Instruções e arquivos do laboratório](../../../apps/backend/api/loadtest/lab/README.md).
As evidências originais e os hashes ficam preservados. Resultados de componentes
são mantidos separados das coletas AWS, com conta, imagem e período próprios.

## Recuperação da verificação independente

A coleta válida usa SQLite persistente e preservou os 150 mil fatos. A query
sem Limit excedeu o heap de 512 MiB do emulador, registrada em
`stream-validated/emulator-verification-failure.txt`. A verificação foi recuperada
com páginas de 1.000 registros: 151 chamadas, 37,877 s, comparação de todos os
campos canônicos e payloadHash. Nenhuma ingestão adicional foi executada para
substituir a massa; o replay posterior apenas testou idempotência. Esse ajuste
do método de leitura não altera os horários/latências publicados na chegada.

## Bateria da API com armazenamento persistente

| Perfil | Requisições | Falha inesperada | p95 respostas 200 | Descartes | Resultado |
| --- | ---: | ---: | ---: | ---: | --- |
| Smoke | 35 | 0% | 128,858 ms | 0 | Aprovado |
| Load 137/s | 43.169 | 52,691% | 7.469 ms | 1.032 | Reprovado |
| Destino indisponível | 4 | 75% | não é carga válida | 0 | Preflight abortou, controle negativo (exit 107) |
| Recuperação | 35 | 0% | 176,840 ms | 0 | Aprovado, mesmo processo |
| Soak 50/s, 30 min | 89.928 | 0,0801% | 90,941 ms | 76 | Reprovado em timeout/descarte |

O soak atende o limite de 0,1% de falha na janela, mas não todos os thresholds,
e não comprova disponibilidade mensal. O load é limite inferior pelo descarte.
O host compartilhava CPU/memória com outros experimentos. A primeira rodada em
memória e a persistente não são um antes/depois do código: são ambientes distintos.
[Resumo por perfil](api-battery/summary.json). Logs completos em GZIP, com SHA-256
do conteúdo original, evitando 26 MiB de texto na entrega.

## Revisão develop atual e configuração Kubernetes

O fechamento incorporou `d5339f3`, que substitui launchers ECS por Kubernetes.
Passaram o build da API, 14 testes de configuração/launchers/agendamento e
17 testes offline de renderização. Brutos em `latest-develop-api-build.txt`,
`latest-develop-api-tests.txt` e `kubernetes-render-tests.txt`. O
[mapa de recursos](kubernetes-resource-map.md) detalha os 34 objetos gerados da
fixture sintética; `kubernetes-render-resources.json` preserva os objetos completos.
Esses testes não acessam cluster nem provam desempenho do EKS.

A bateria `api-latest-develop/` registra uma nova massa de 2.500 incidentes,
smoke, 137/s por 5 min, indisponibilidade real do DynamoDB Local, recuperação no
mesmo processo e uma janela curta de 2 min a 50/s. Os 2 min são um controle
complementar da revisão nova, não substituem o soak de 30 min da base anterior.
Os metadados distinguem commit e SHA do runner; o pipeline de importação EKS
não é chamado por essa bateria HTTP.
