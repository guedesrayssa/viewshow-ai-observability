# Testes de carga finais — observabilidade da ingestão

## 1. Escopo desta contribuição

Esta seção define a observabilidade da camada de ingestão que será usada nos
testes não funcionais finais. O objetivo é responder, com evidências
reproduzíveis, se o worker processa a carga esperada, degrada de forma visível e
se recupera após falhas.

O recorte cobre os três itens da especificação:

| Item avaliado | Contribuição da ingestão |
| --- | --- |
| RNFs e planos de teste | Traduz os cenários de 10 mil eventos/min, fila cheia e timeout para sinais do pipeline batch. |
| Resultados de desempenho e resiliência | Define as medidas, critérios e evidências que devem acompanhar cada execução. |
| Grafana ou Prometheus | Implementa o módulo de ingestão no Grafana, provisionado sobre o CloudWatch. |

> **Estado em 30/09/2026:** contrato de observabilidade definido; 72 testes locais
> aprovados; cenário AWS de 150 mil registros executado e reprovado end-to-end.
> Fila cheia e capturas do Grafana permanecem pendentes. O dashboard da ingestão
> já está versionado e conectado ao provisionamento AWS; configuração existente e
> teste de componente não são apresentados como resultado de carga do pipeline.

## 2. Semântica dos cenários na arquitetura batch

A ingestão atual é um worker batch em ECS/Fargate, e não uma API HTTP. Por isso,
latência, erro e saturação precisam ser interpretados no contexto de uma
execução e de sua fila.

| Cenário | Preparação e execução | Indicadores observados | Critério de aceite proposto | Estado |
| --- | --- | --- | --- | --- |
| Abertura de venda de 10 mil eventos/min | Disponibilizar uma janela equivalente a 150 mil registros em 15 minutos e executar a ingestão. | duração, lidos, escritos, inalterados, rejeitados, CPU e lag | conclusão explícita sem perda silenciosa; `lidos = escritos + inalterados + rejeitados`; vazão suficiente para drenar a janela sem crescimento contínuo do lag | Executado; reprovado end-to-end |
| Fila cheia | Produzir lotes acima da capacidade momentânea do consumidor incremental e interromper a produção após atingir o backlog planejado. | mensagens visíveis, idade da mais antiga, DLQ, lotes em quarentena e tempo de drenagem | backlog e idade ficam visíveis; não há descarte silencioso; após cessar a produção, a fila retorna a zero ou ao patamar inicial | Pendente de execução |
| Timeout | Forçar o comando ou uma dependência a exceder seu prazo controlado. | duração, `FAILED`/`PARTIAL`, etapa, código de erro, retries, backlog e execução seguinte | a run termina em estado explícito, sem permanecer indefinida; a causa é correlacionável pelo `runId`; uma execução posterior consegue retomar ou recuperar | Observado; reprovado por ausência de estado terminal |

No cenário de carga, `RecordsRead / duração` representa a taxa de processamento,
enquanto `RecordsWritten / duração` representa novas escritas. Uma retomada pode
gerar `RecordsUnchanged`; portanto, analisar somente escritas produziria uma
conclusão incorreta sobre capacidade e integridade.

## 3. Arquitetura de coleta

```mermaid
flowchart LR
    W[Worker de ingestão] -->|logs JSON e EMF| L[CloudWatch Logs]
    L --> M[CloudWatch Metrics<br/>view-show/Ingestion]
    E[ECS Container Insights] --> M
    Q[SQS e DLQs] --> M
    M -->|data source CloudWatch| G[Módulo de ingestão no Grafana]
    L -->|consulta de logs| G
```

O CloudWatch permanece como fonte autoritativa porque o worker já emite métricas
EMF e a infraestrutura já coleta métricas nativas de ECS e SQS. O Grafana é a
camada de visualização, usando o data source CloudWatch já provisionado. Não foi
criado um segundo caminho Prometheus/OTLP sem uma lacuna
comprovada, evitando duplicação de coleta, custo e manutenção.

As métricas de uma execução batch são esparsas. Ausência de amostra fora da
janela agendada significa “nenhuma execução observada”, e não zero. Painéis e
alertas não devem preencher essa ausência como sucesso.

## 4. Indicadores obrigatórios

| Indicador | Fonte e consulta a configurar no Grafana | Unidade e agregação | Interpretação |
| --- | --- | --- | --- |
| Latência | `view-show/Ingestion`, `RunDurationMs`, por `command`; usar percentil 95 e máximo | milissegundos por run | tempo de conclusão do comando; `StageDurationMs` fica disponível para diagnóstico |
| Throughput | soma de `RecordsRead` e `RecordsWritten`, por `command`, dividida pelo período do painel | registros/s e registros/min | capacidade de leitura e persistência; deve ser lida com `RecordsUnchanged` e `RecordsRejected` |
| Erros por segundo | soma de `Runs` com `status=FAILED` ou `PARTIAL`, dividida pelos segundos do período; exibir também `RecordsRejected / período` | erros/s e registros rejeitados/s | falhas de execução e degradação de qualidade são séries distintas |
| CPU | `ECS/ContainerInsights`: `100 * CpuUtilized / CpuReserved`, por `ClusterName` e `TaskDefinitionFamily` | percentual, média e máximo | saturação da task durante a mesma janela do teste |

Quando houver poucas runs, o máximo e o valor individual devem acompanhar o p95;
um percentil calculado sobre uma única amostra não acrescenta evidência. Para
erros raros, o painel pode exibir adicionalmente erros/min, mas a transformação
para erros/s deve permanecer disponível para atender ao critério da rubrica.

### 4.1 Indicadores complementares

| Pergunta operacional | Métrica existente | Fonte/dimensões principais | Prioridade |
| --- | --- | --- | --- |
| A run concluiu? | `Runs` | `view-show/Ingestion`; `command`, `status` | P0 |
| O dado está fresco? | `SourceLagSeconds`, `IncrementalBatchLagSeconds` | `view-show/Ingestion`; `command`, `status`, `dataset` conforme a métrica | P0 |
| Existe fila acumulada? | `ApproximateNumberOfMessagesVisible`, `ApproximateAgeOfOldestMessage` | `AWS/SQS`; `QueueName` | P0 |
| Há mensagens sem recuperação automática? | profundidade das DLQs | `AWS/SQS`; `QueueName` | P0 |
| O contrato do dado degradou? | `SchemaDrift`, `RecordsRejected`, `IncrementalBatchQuarantined` | `view-show/Ingestion`; dimensões de baixa cardinalidade já definidas pelo emissor | P0 |
| Qual etapa ficou lenta ou falhou? | `StageDurationMs`, `StageFailures` | `view-show/Ingestion`; `command`, `stage`, `status` | P1 |
| A origem MySQL degradou? | `MySqlPageDurationMs`, `MySqlRetries`, `MySqlPreflightFailures` | `view-show/Ingestion`; dimensões emitidas pelo adaptador | P1 |
| Houve pressão adicional de recurso ou destino? | memória, armazenamento efêmero, `AthenaFailures`, `ProcessedBytes`, `ArchiveFailures` | Container Insights e `view-show/Ingestion` | P1 |

P0 compõe a primeira visão operacional. P1 é diagnóstico e deve ficar em uma
linha expansível ou drill-down, para que a visão principal permaneça legível.
Dimensões com identificadores únicos, como `runId`, não devem ser usadas em
métricas; a correlação detalhada pertence aos logs.

## 5. Contrato mínimo de logs

| Evento estruturado | Nível atual | Uso |
| --- | --- | --- |
| `ingestion.run.started` | `INFO` | marca o início e permite localizar uma run pelo `runId` |
| `ingestion.run.finished` | `INFO` | registra o estado terminal, duração e contagens |
| `ingestion.run.partial` | `ERROR` | torna visível uma conclusão degradada |
| `ingestion.run.failed` | `ERROR` | registra uma falha terminal ou exceção sanitizada |

Campos comuns: `timestamp`, `level`, `service_name`, `environment`, `event`,
`message`, `runId`, `command` e, quando aplicáveis, `traceId`, `stage`, `status`,
`durationMs`, `dataset`, `datasetVersion`, `windowStart`, `windowEnd`, contagens e
`errorCode` seguro.

Os logs não devem conter payload bruto, registro individual, SQL, senha, token,
secret, connection string, corpo de requisição ou URL assinada. Retentativas
repetitivas devem ser agregadas em métrica; um log adicional só se justifica
quando muda o estado da execução ou quando as tentativas se esgotam. A busca de
um incidente começa por `runId` e então cruza `command`, etapa e janela, sem
transformar valores únicos em dimensões de métrica.

## 6. Módulo de ingestão no Grafana

O dashboard versionado em
`apps/fullstack/observability/aws/view-show-ingestion.json.tftpl` implementa uma
visão pequena, organizada em três linhas:

1. **Saúde e capacidade:** duração da run, throughput de leitura/escrita,
   erros/s e CPU — os quatro indicadores obrigatórios.
2. **Confiabilidade do dado:** lag, reconciliação das contagens, rejeitados,
   schema drift, backlog, idade da mensagem mais antiga e DLQ.
3. **Diagnóstico:** duração por etapa e eventos estruturados dos quatro comandos
   da ingestão. Métricas detalhadas de MySQL, memória, armazenamento e Athena
   permanecem no dashboard CloudWatch nativo para não sobrecarregar a visão.

O dashboard tem UID estável `view-show-ingestion`, usa o data source
`cloudwatch` e é instalado automaticamente pelo mesmo `user_data` da stack de
observabilidade. Os filtros `Comando` e `Task ECS` evitam misturar operações e
recursos diferentes. A implantação e a captura visual continuam dependentes de
habilitar `observabilidade_habilitada=true` no ambiente do teste.

Cada painel deve registrar no próprio título, descrição ou documentação associada:

- data source CloudWatch, namespace, métrica e dimensões;
- estatística, período e unidade;
- comando/dataset selecionado e intervalo temporal exato do teste;
- tratamento de ausência de dados;
- RNF ou pergunta operacional respondida.

O período da consulta deve ser compatível com a duração do teste e permanecer
igual nas séries comparadas. CPU, throughput e falhas só podem ser correlacionados
quando usam a mesma janela temporal.

## 7. Coleta e preservação das evidências

Para cada cenário executado, criar
`assets/testes-carga/<AAAA-MM-DD>-ingestao/` e preservar:

- parâmetros do cenário, horário inicial/final, ambiente e versão implantada;
- saída bruta das consultas CloudWatch usadas nos painéis;
- logs estruturados das runs selecionadas, com dados sensíveis removidos;
- captura do Grafana com título, legenda, unidade e janela temporal visíveis;
- tabela resumida com valor esperado, valor medido, resultado e limitação.

Uma captura sem consulta bruta não é evidência suficiente. Da mesma forma, uma
métrica ou alarme existente na infraestrutura deve ser descrito como
“configurado” até que uma amostra da janela do teste seja preservada.

Modelo para preenchimento após cada execução:

| Cenário | Janela UTC | Versão | Indicador | Esperado | Medido | Resultado | Evidência |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 mil eventos/min | 29/09 23:48:59–30/09 02:56:06 UTC | `47eccb9` | latência, throughput, erros/s, CPU e reconciliação | conclusão em até 15 min | ingestão 621,536 s; projeção 1.088,407 s; sem conclusão end-to-end | Reprovado | Seção 7.1 |
| Fila cheia | Pendente | Pendente | backlog, idade, DLQ e drenagem | conforme Seção 2 | Pendente | Não executado | Pendente |
| Timeout | 29/09 23:48:59–30/09 02:56:06 UTC | `47eccb9` | estado terminal e duração | estado terminal explícito em até 3.600 s | permaneceu em `ARCHIVING`; parada controlada após 11.227,484 s | Reprovado | Seção 7.1 |

### 7.1 Resultado AWS: 150 mil registros

O teste foi executado com uma única task ECS, sem ativação do dataset e sem
paralelismo artificial. A janela observada foi de `2026-09-29T23:48:59.445Z` a
`2026-09-30T02:56:06.929Z`.

| Indicador | Resultado medido | Leitura |
| --- | ---: | --- |
| Registros lidos / escritos / rejeitados | 150.000 / 150.000 / 0 | reconciliação íntegra até a etapa `ARCHIVING` |
| Duração da ingestão | 621,536 s | 241,34 registros/s; superior à entrada equivalente de 166,67 registros/s |
| Duração da projeção | 1.088,407 s | principal etapa concluída e maior que a janela-alvo de 15 min |
| Duração end-to-end observada | 11.227,484 s | execução não concluiu; task interrompida para conter custo |
| CPU média / máxima | 33,12% / 39,99% | CPU não foi o recurso limitante |
| Estado durável final | `ARCHIVING`, sem `finishedAt` | ausência de conclusão explícita |
| Erros/s | indeterminado | não houve métrica/evento terminal após a interrupção externa |

O resultado é **reprovado end-to-end**. Embora a etapa de ingestão isolada tenha
vazão suficiente para 10 mil registros/min e a reconciliação esteja correta, a
projeção excedeu 15 minutos e o arquivamento não terminou após mais de três
horas. Assim, a arquitetura não demonstrou capacidade de concluir a janela no
prazo requerido.

Também foi identificada uma lacuna de observabilidade: o timeout de 3.600 s da
CLI encerra a espera local, mas não interrompe automaticamente a task ECS. Uma
interrupção externa produz `exitCode=137`, porém não emite
`ingestion.run.failed`, `RunDurationMs` final ou `Runs{status=FAILED}`. O painel
deve combinar métricas da aplicação com estado da task ECS e tratar run sem
heartbeat/estado terminal como falha operacional.

Evidências: [resumo estruturado](../assets/testes-carga/2026-09-29-ingestao/aws-backfill-150k-summary.json)
e [eventos selecionados](../assets/testes-carga/2026-09-29-ingestao/aws-backfill-150k-events.md).

### 7.2 Evidências locais coletadas em 29/09/2026

Os testes foram executados na revisão `e9fb599`, com Python 3.12.11 em container
descartável. Esses resultados validam instrumentação e comportamento de
componentes; não substituem as medições de latência, throughput, erros/s e CPU
do pipeline implantado.

| Teste | Resultado medido | Interpretação | Evidência bruta |
| --- | --- | --- | --- |
| Telemetria e observabilidade | 47 aprovados; 0 falhas, erros ou ignorados; 0,840 s | o contrato automatizado de logs, métricas, redaction e runtime está consistente | [JUnit de observabilidade](../assets/testes-carga/2026-09-29-ingestao/pytest-observabilidade.xml) |
| Resiliência incremental | 25 aprovados; 0 falhas, erros ou ignorados; 1,274 s | adapters S3/SQS, CLI e retomadas de exportação/ingestão passaram localmente | [JUnit de resiliência](../assets/testes-carga/2026-09-29-ingestao/pytest-resiliencia-incremental.xml) |
| Geração da massa | 150.000 registros; 917.703 bytes comprimidos; SHA-256 registrado | comprova volume e determinismo da fixture, não desempenho do pipeline | [Manifesto da massa](../assets/testes-carga/2026-09-29-ingestao/manifest-150k.json) |

O [registro completo da rodada](../assets/testes-carga/2026-09-29-ingestao/README.md)
documenta ambiente, comandos lógicos e limitações. O benchmark de leitura não
foi classificado como executado: o harness requer Docker Compose no mesmo runtime
do Python 3.12, combinação indisponível no host. Também não havia AWS CLI, logo
nenhum resultado CloudWatch ou Grafana foi inferido a partir desta rodada.

## 8. Impactos nas decisões de arquitetura

As decisões já sustentadas pela análise do código são:

- CloudWatch é a fonte única de telemetria da ingestão e Grafana será sua camada
  de visualização;
- a observabilidade usa baixa cardinalidade nas métricas e `runId` nos logs;
- backlog, idade e DLQ representam pressão e falha assíncrona melhor que códigos
  HTTP para este worker;
- vazão deve preservar a distinção entre lido, escrito, inalterado e rejeitado.

As decisões de capacidade ainda dependem dos testes. Somente os resultados podem
justificar aumento de CPU/memória, paralelismo, tamanho de lote, política de
retry, timeout ou escalabilidade do consumidor. Essa separação evita otimização
prematura e mantém o artefato auditável.

## 9. Limitações atuais

- Há evidência local e uma rodada operacional AWS, mas ainda não há capturas do
  módulo de ingestão no Grafana.
- A proposta de 150 mil registros representa 10 mil eventos/min por 15 minutos;
  a equivalência deve ser registrada junto ao gerador de carga utilizado.
- Métricas de Scheduler, SQS e ECS dependem de Container Insights e dos recursos
  AWS estarem ativos no ambiente ensaiado.
- Os limiares definitivos devem ser calibrados com uma linha de base real; este
  documento define semântica e método, não um SLO sem evidência.

## 10. Referências e locais de manutenção

- [Teste inicial da Sprint 3](sprint3/testes-carga-inicial.md): histórico e
  limitações dos ensaios anteriores.
- [Runbook da ingestão](../apps/backend/ingestion-data/README.md): comandos
  operacionais e procedimentos duradouros.
- [Emissor de métricas CloudWatch](../apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py)
  e [runtime observado](../apps/backend/ingestion-data/adapters/telemetry/runtime.py):
  contrato implementado de métricas e logs.
- [Infraestrutura de observabilidade](../apps/fullstack/ingestion-observability.tf):
  alarmes, métricas AWS e dashboard CloudWatch existentes.
- [Data source CloudWatch do Grafana](../apps/fullstack/observability/aws/cloudwatch-datasource.yml):
  integração que será reutilizada na próxima tarefa.

Este arquivo é a fonte da metodologia e dos resultados datados. Evidências brutas
ficam em `assets/testes-carga/`; instruções operacionais permanentes ficam no
runbook; decisões arquiteturais permanentes devem ser refletidas no documento de
arquitetura, sem copiar capturas ou resultados temporais.
