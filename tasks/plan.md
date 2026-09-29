# Plano: observabilidade da ingestão no artefato de testes finais

## Contexto da entrega

O artefato avaliado será `artefatos/testes-carga-finais.md`. A contribuição desta
tarefa é especificar a observabilidade da camada de ingestão: quais indicadores
são relevantes, como interpretar os quatro indicadores exigidos em um worker
batch, quais logs precisam existir e como registrar método, evidências, resultados
e impactos arquiteturais.

Esta tarefa não implementa o dashboard Grafana. Ela entrega o contrato que a tarefa
seguinte usará para construir o módulo da ingestão no Grafana.

## Relação com os itens avaliados

| Item da especificação | Contribuição da observabilidade da ingestão |
| --- | --- |
| (1) RNFs e planos aprimorados | Traduzir os cenários de 10 mil eventos/min, fila cheia e timeout para sinais mensuráveis do pipeline batch. |
| (2) Resultados e resiliência | Definir o que coletar antes, durante e depois de cada cenário e como distinguir fato medido de configuração existente. |
| (3) Grafana/Prometheus | Definir os painéis, métricas, logs, fonte de dados, janela e evidência visual da ingestão. |

O foco principal é o item 3, sem perder a rastreabilidade com os cenários e
resultados dos itens 1 e 2.

## Tradução dos cenários para o worker atual

| Cenário da especificação | Interpretação correta na arquitetura batch | Evidência esperada |
| --- | --- | --- |
| 10 mil eventos/min | Processar uma janela equivalente a 150 mil eventos em 15 min, sem perda silenciosa | duração, lidos, escritos, inalterados, rejeitados e reconciliação final |
| Fila cheia | Acúmulo de lotes/janelas na fila incremental ou na outbox, não HTTP 429 | profundidade, idade da mensagem mais antiga, DLQ, tempo de drenagem e recuperação |
| Timeout | Comando ou dependência excede o prazo e termina explicitamente em falha/parcial | duração, estado terminal, etapa, código seguro de erro e recuperação posterior |

Para a vazão, `RecordsRead / duração` representa processamento e
`RecordsWritten / duração` representa novas escritas. Runs retomados podem produzir
`RecordsUnchanged`; portanto, vazão e integridade devem ser analisadas junto da
reconciliação `lidos = escritos + inalterados + rejeitados`, nunca apenas pelo
contador de escrita.

## Decisão de escopo

A ingestão atual é um worker batch em ECS/Fargate e já emite logs JSON e métricas
EMF no CloudWatch. O caminho mais simples e coerente é:

- usar **CloudWatch Metrics** como fonte das métricas de aplicação e AWS;
- usar **CloudWatch Logs** como fonte dos logs estruturados;
- usar o **data source CloudWatch do Grafana** na tarefa seguinte;
- usar Prometheus/OTLP apenas se uma necessidade do ambiente local não puder ser
  atendida pelo caminho acima.

Não faz parte desta tarefa criar novos exportadores, instrumentar chamadas de SDK,
propagar traces por fila, criar Alertmanager ou redesenhar a plataforma LGTM.

## Tradução dos quatro indicadores obrigatórios

Os indicadores da rubrica não devem ser interpretados como RED de uma API HTTP:

| Indicador exigido | Interpretação na ingestão batch | Sinal principal |
| --- | --- | --- |
| Latência | Tempo para um comando ou etapa concluir | `RunDurationMs` e, para diagnóstico, `StageDurationMs` |
| Throughput | Registros lidos/escritos por unidade de tempo | `RecordsRead` e `RecordsWritten`, normalizados pela janela |
| Erros por segundo | Falhas/parciais de execução e registros rejeitados por tempo | `Runs{status=FAILED|PARTIAL}` e `RecordsRejected` |
| CPU | Utilização real da task, não CPU do processo isolado | `ECS/ContainerInsights` (`CpuUtilized` / `CpuReserved`) |

No artefato, cada painel deve declarar a unidade e a janela. Para runs pouco
frequentes, apresentar falhas por minuto ou por janela é mais legível, mas a taxa
por segundo deve permanecer calculável para atender ao critério.

## Métricas prioritárias

### Essenciais para o módulo Grafana

| Prioridade | Pergunta operacional | Métrica/fonte existente | Visualização recomendada |
| --- | --- | --- | --- |
| P0 | A execução concluiu? | `Runs` por `command` e `status` | Série temporal por resultado + total do último período |
| P0 | Quanto tempo levou? | `RunDurationMs` por `command` | p50/p95 ou máximo quando houver poucas amostras |
| P0 | Qual foi a vazão? | `RecordsRead` e `RecordsWritten` | registros/s ou registros/min |
| P0 | Houve erro ou perda rejeitada? | `Runs` em `FAILED`/`PARTIAL` e `RecordsRejected` | taxa de falha + rejeitados por tempo |
| P0 | A task saturou CPU? | Container Insights `CpuUtilized`/`CpuReserved` | utilização percentual |
| P0 | O dado está fresco? | `SourceLagSeconds` e `IncrementalBatchLagSeconds` | maior lag por dataset |
| P0 | Existe backlog ou mensagem perdida? | idade/volume de SQS, outbox e DLQ | idade da mais antiga + profundidade |
| P0 | O contrato do dado degradou? | `SchemaDrift`, `RecordsRejected`, `IncrementalBatchQuarantined` | ocorrências por janela |

### Diagnósticas, sem ocupar a primeira visão

- `StageDurationMs` e `StageFailures` para localizar a etapa lenta ou quebrada;
- `MySqlPageDurationMs`, `MySqlRetries` e `MySqlPreflightFailures` para a fonte;
- memória e armazenamento efêmero da task;
- `AthenaFailures`, `ProcessedBytes` e `ArchiveFailures`;
- `OutboxOldestAgeSeconds` e métricas específicas do incremental.

Esses sinais devem ficar numa segunda linha ou em drill-down. Colocar todos na
visão principal prejudicaria a leitura e não aumentaria a nota do artefato.

## Logs que importam

O artefato deve documentar o contrato atual de logs, sem propor log por registro.

| Evento | Nível | Quando emitir | Campos essenciais |
| --- | --- | --- | --- |
| `ingestion.run.started` | `info` | Início do comando | `runId`, `command`, `stage`, janela/dataset quando existirem |
| `ingestion.run.finished` | `info` | Término de qualquer run | `runId`, `command`, `status`, `durationMs`, contagens |
| `ingestion.run.partial` | `warn` ou `error` | Run com resultado parcial | campos comuns + `stage`, `errorCode` seguro |
| `ingestion.run.failed` | `error` | Exceção ou falha terminal | campos comuns + `stage`, `errorCode`, mensagem sanitizada |

Campos comuns esperados: `timestamp`, `level`, `service_name`, `environment`,
`event`, `runId`, `command` e, quando houver, `traceId`, `dataset`,
`datasetVersion`, `windowStart`, `windowEnd` e contagens.

Não registrar payload bruto, SQL, senha, token, connection string, corpo, URL
assinada ou registro individual. Retry repetitivo deve ser métrica agregada; log
só é necessário quando altera o estado ou esgota as tentativas.

## Onde documentar

Para evitar documentação duplicada:

- **`artefatos/testes-carga-finais.md`:** fonte principal desta entrega. Deve conter
  plano, consultas, ambiente, janela, capturas, resultados, limitações e decisões
  arquiteturais da observabilidade da ingestão.
- **`assets/testes-carga/<data>-ingestao/`:** arquivos brutos e capturas citados
  pelo artefato. Toda imagem precisa apontar para um dado reproduzível.
- **`apps/backend/ingestion-data/README.md`:** somente comandos operacionais e de
  reprodução que precisam continuar úteis depois da entrega; o artefato deve linkar
  para eles, não copiá-los integralmente.
- **`artefatos/arquitetura/ingestao-e-dados.md`:** apenas decisões arquiteturais
  permanentes. Resultados datados e screenshots não pertencem a esse arquivo.

Não é necessário criar um novo documento de observabilidade separado.

## Estrutura proposta no artefato final

```text
Observabilidade da camada de ingestão
  1. Semântica batch e relação com os RNFs
  2. Arquitetura de coleta e fontes de dados
  3. Indicadores obrigatórios: latência, throughput, erros/s e CPU
  4. Indicadores de frescor, qualidade e backlog
  5. Contrato de logs e correlação por runId
  6. Resultados no Grafana/CloudWatch
  7. Limitações, lacunas e impacto nas decisões de arquitetura
  8. Procedimento de reprodução e evidências brutas
```

As seções de resultado só devem ser preenchidas depois da execução. Configuração
existente deve ser rotulada como “configurado”; apenas série ou log capturado na
janela pode ser apresentado como “medido”.

## Evidência exigida para a tarefa seguinte do Grafana

Para cada painel da ingestão, registrar:

1. nome do indicador e relação com o RNF;
2. data source, namespace, métrica, dimensões, estatística e período;
3. intervalo temporal exato do teste;
4. captura do painel com legenda e unidade legíveis;
5. bruto da consulta salvo em `assets/testes-carga/<data>-ingestao/`;
6. interpretação do resultado e limitação do leito.

## Fora de escopo

- implementar ou provisionar o dashboard Grafana;
- executar os testes de carga nesta etapa de definição;
- criar novas métricas sem antes confirmar uma lacuna no catálogo existente;
- definir SLO ou afirmar capacidade sem resultado bruto;
- alterar o runtime, Terraform ou a pilha LGTM.

## Lista de tarefas

- [x] Tarefa 1: Mapear RNFs e sinais atuais da ingestão.
- [x] Tarefa 2: Fechar o catálogo priorizado de métricas e logs.
- [x] Tarefa 3: Definir o roteiro de evidências para o módulo Grafana.
- [x] Tarefa 4: Redigir a seção de ingestão em `artefatos/testes-carga-finais.md`.

## Critério de conclusão

A próxima tarefa consegue implementar os painéis da ingestão no Grafana sem
rediscutir semântica, prioridade, unidade, fonte de dados ou evidência exigida.
