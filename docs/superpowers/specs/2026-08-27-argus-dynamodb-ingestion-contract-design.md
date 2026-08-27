# Contrato de ingestão Argus → DynamoDB

Status: design aprovado para revisão documental  
Versão: 1.0  
Data: 2026-08-27  
Região AWS: `us-east-1`

## 1. Objetivo

Este documento define o contrato interno de ingestão que lê dados reais do
Argus, normaliza fontes heterogêneas e persiste fatos e projeções no DynamoDB.
O primeiro uso será um backfill histórico; depois, a mesma aplicação fará
sincronizações incrementais periódicas.

O desenho preserva três independências:

1. a origem física pode mudar de MySQL/Percona para BigQuery sem alterar o
   domínio;
2. a persistência direta pode ganhar SQS e DLQ sem alterar os contratos
   canônicos;
3. o contrato HTTP do dashboard pode evoluir sem transformar o worker em um
   produtor de DTOs do frontend.

Este é um contrato de ingestão e persistência. A implementação da aplicação,
da API e da infraestrutura será planejada e executada em outra sessão.

Documentos focados derivados deste design:

- [Contrato normativo de entrada e persistência](../../../artefatos/contratos/argus-dynamodb-ingestion-contract.md);
- [Arquitetura e projeções do Data Ingestion Service](../../../artefatos/arquitetura/data-ingestion-service-architecture.md).

## 2. Decisões arquiteturais

- Aplicação Python em `apps/backend/ingestion-data`.
- Monólito modular nesta fase, preparado para separação futura.
- DDD leve com arquitetura hexagonal/ports and adapters.
- Backfill acionado manualmente.
- Sincronização por ECS `RunTask`, disparada a cada 15 minutos.
- Escrita direta no DynamoDB na primeira fase.
- Sem SQS e DLQ na primeira fase.
- Checkpoints e falhas isolados por fonte.
- Região fixa e validada como `us-east-1`.
- Apenas duas tabelas de aplicação: `monitoracao-operacional` e
  `monitoracao-golden-set`.
- O worker de ingestão não recebe permissão, configuração ou adapter para
  acessar `monitoracao-golden-set`.
- O contrato público do dashboard permanece responsabilidade da API.

## 3. Escopo

### 3.1 Incluído

- leitura do snapshot MySQL 8/Percona do Argus;
- backfill retomável;
- leitura futura do banco vivo do Argus;
- normalização de timestamps, identidades, números, unidades e dimensões;
- persistência idempotente de fatos;
- incidentes do ServiceNow presentes no Argus;
- saúde e cobertura das fontes;
- projeções operacionais para Visão Geral, incidentes, monitoramento e
  geografia;
- reprocessamento de fontes e reconstrução de projeções;
- auditoria de execuções, checkpoints, leases e erros;
- estado explícito para dados medidos, estimados e indisponíveis;
- uma porta de saída que possa receber um publisher SQS no futuro.

### 3.2 Fora do escopo

- implementação da API do dashboard;
- alteração do contrato HTTP entre frontend e backend;
- autenticação e autorização de usuários;
- geração automática de hipóteses causais;
- produção de eventos individuais a partir de agregados;
- escrita automática no golden set;
- BigQuery na primeira versão;
- SQS e DLQ na primeira versão;
- exclusão de tabelas DynamoDB ou recursos AWS legados;
- cópia integral de `dashboard_artifact` para um item DynamoDB.

## 4. Contexto dos dados do Argus

O snapshot fornecido é um dump MySQL 8/Percona com 33 tabelas e cerca de 11 GB
descomprimidos. Os timestamps são predominantemente epoch em milissegundos UTC,
mas os nomes das colunas variam por tabela. As tabelas legadas `*_run` usam
timestamps ISO em texto.

As fontes possuem granularidades diferentes:

| Granularidade | Fontes principais |
|---|---|
| 15 minutos | `signal_bucket`, `live_active_15min`, `rpaas_bucket` |
| 1 hora | tabelas NPAW/Youbora `*_hourly` |
| evento | `incidents`, `tsuru_event`, `live_event` |
| estado atual | `signal_meta` |

`signal_point` e `prom_point` representam a maior parte do volume. A entrada
canônica inicial é `signal_bucket`, que já materializa o sinal em buckets de
15 minutos e é a tabela lida pelo detector do Argus.

As fontes NPAW/Youbora possuem atraso estrutural aproximado de 28 horas. Esse
atraso é parte da semântica da fonte e não deve ser apresentado como perda de
dados quando estiver dentro do SLA configurado.

## 5. Arquitetura hexagonal

Estrutura lógica:

```text
apps/backend/ingestion-data/
├── domain/             entidades, value objects e contratos canônicos
├── application/        backfill, sync, reprocess e projeções
├── ports/              source readers, sinks, checkpoints, locks e métricas
├── adapters/
│   ├── sources/        Argus MySQL; BigQuery futuramente
│   └── sinks/          DynamoDB direto; SQS futuramente
└── bootstrap/          comandos, configuração e composição
```

Fluxo de dependências:

```text
ArgusMySqlReader ─┐
                  ├→ casos de uso → contratos canônicos → CanonicalRecordSink
FutureBigQuery ───┘                                      │
                                                         ├→ DynamoDirectSink
                                                         └→ FutureSqsPublisher
```

O domínio não importa SDKs da AWS, drivers MySQL, nomes de tabelas DynamoDB,
variáveis ECS ou DTOs HTTP.

Portas principais:

```text
SourceReader
CanonicalRecordSink
ProjectionRepository
CheckpointRepository
LeaseRepository
RunRepository
MetricsPublisher
Clock
```

## 6. Camadas de contrato

A ingestão possui três camadas distintas:

1. **Contrato físico da origem:** nomes, tipos e chaves das tabelas do Argus.
2. **Contrato canônico:** representação estável usada pelos casos de uso.
3. **Contrato de persistência:** chaves, TTL e projeções do DynamoDB.

Uma mudança de origem afeta o contrato físico e seu adapter. Uma mudança de
consulta afeta as projeções. Nenhuma das duas deve alterar automaticamente o
contrato canônico.

## 7. Envelope canônico

Todo fato normalizado segue o envelope conceitual:

```json
{
  "schemaVersion": "1.0",
  "recordType": "signal_observation",
  "recordId": "rec_...",
  "source": {
    "system": "argus",
    "dataset": "signal_bucket",
    "naturalKey": {}
  },
  "observedAt": "2026-08-26T18:00:00.000Z",
  "window": {
    "start": "2026-08-26T18:00:00.000Z",
    "end": "2026-08-26T18:15:00.000Z",
    "grainSeconds": 900
  },
  "payload": {},
  "measurement": {
    "status": "measured"
  },
  "quality": {
    "status": "verified",
    "coverageRatio": null,
    "flags": []
  },
  "ingestion": {
    "runId": "run_...",
    "ingestedAt": "2026-08-26T18:16:00.000Z",
    "readerAdapter": "argus_mysql",
    "payloadHash": "sha256:..."
  }
}
```

Regras:

- timestamps canônicos usam ISO 8601 UTC com `Z`;
- o timestamp original pode permanecer em `source.naturalKey` para auditoria;
- `source.system` identifica a origem semântica, não o mecanismo de leitura;
- `ingestion.readerAdapter` registra se a leitura ocorreu por MySQL, BigQuery
  ou outro transporte e não participa da identidade do fato;
- `recordId` é determinístico;
- `payloadHash` é calculado sobre a representação canônica;
- valores numéricos são tratados como `Decimal` antes da escrita no DynamoDB;
- `NaN`, infinito e números formatados como texto são proibidos;
- `measurement.status` usa `measured`, `estimated` ou `unknown`;
- `quality.status` usa `verified`, `partial`, `delayed` ou `unavailable`;
- `null` significa indisponível ou não medido; zero significa medido sem
  ocorrência.

### 7.1 Canonicalização para hashes

O serializer de hash usa:

- UTF-8;
- chaves ordenadas;
- timestamps normalizados em UTC;
- `Decimal` representado em base 10 sem notação dependente de locale;
- listas na ordem semântica definida pelo contrato;
- ausência e `null` como estados distintos;
- proibição de `NaN` e infinito.

Identidade do registro:

```text
recordId = "rec_" + base32(
  sha256(schemaVersion + recordType + source.system + source.dataset
         + canonicalNaturalKey)
)[:26]
```

`payloadHash` inclui payload, janela, medição e qualidade, mas não inclui
`runId`, `ingestedAt` ou `readerAdapter`.

Se o BigQuery futuro expuser os mesmos dados lógicos do Argus, o adapter muda
para `argus_bigquery`, mas `source.system`, `source.dataset`, chave natural e
`recordId` permanecem. Uma fonte semanticamente diferente recebe outro
namespace e, portanto, outra identidade.

## 8. Tipos canônicos

### 8.1 `SignalObservation`

Uma medida de uma série do `signal_bucket`.

```json
{
  "recordType": "signal_observation",
  "payload": {
    "telemetrySource": "rpaas",
    "entity": {
      "type": "edge_vhost",
      "id": "br1|playback.video.globo.com"
    },
    "metric": {
      "name": "p95_ms",
      "value": 310,
      "unit": "milliseconds",
      "aggregation": "source_resolved"
    }
  }
}
```

A unidade e o tipo da entidade são resolvidos por um registro versionado que
usa `telemetrySource + metric`. Uma métrica nunca é interpretada isoladamente.

### 8.2 `DimensionalMetricAggregate`

Uma linha agregada de uma tabela NPAW/Youbora. Uma linha física permanece uma
observação agregada; ela não se torna evento individual.

```json
{
  "recordType": "dimensional_metric_aggregate",
  "payload": {
    "dataset": "live_active",
    "dimensions": {
      "channel": "pfc1"
    },
    "measures": {
      "activeSessions": 184200,
      "activeWithError": 3200,
      "joins": 18700,
      "latencyP50Ms": 220,
      "latencyP95Ms": 640,
      "bufferRatioAverage": 0.068,
      "joinTimeAverageSeconds": 2.8,
      "droppedFramesAverage": 1.2
    }
  }
}
```

### 8.3 `Incident`

Representação canônica de um incidente do ServiceNow presente no Argus.

```json
{
  "recordType": "incident",
  "payload": {
    "incidentId": "inc_...",
    "number": "INC0871263",
    "sourceReference": {
      "system": "servicenow",
      "sourceIncidentId": "sys_id_original"
    },
    "openedAt": "2026-08-26T17:41:00.000Z",
    "resolvedAt": null,
    "closedAt": null,
    "priority": "P1",
    "status": "investigating",
    "businessService": "video",
    "configurationItem": "player",
    "category": "software",
    "subcategory": "playback",
    "impactComponent": "player",
    "externalImpact": true,
    "causedByChangeOrDeploy": false,
    "parentIncident": null,
    "childIncidents": []
  }
}
```

### 8.4 `UpstreamSourceHealth`

Estado atual de uma fonte: último dado observado, última coleta, atraso,
cobertura, contagens e SLA aplicado.

### 8.5 `UpstreamCollectorRun`

Execução de um coletor do Argus: janela, início, fim, duração, linhas, custo e
estado. As variações físicas de `collector_run` e tabelas legadas são
normalizadas pelos adapters.

### 8.6 Registros internos

- `IngestionRun`;
- `IngestionError`;
- `SourceCheckpoint`;
- `ProjectionCheckpoint`;
- `Lease`;
- `ProjectionMetadata`.

## 9. Identidade canônica de incidentes

`recordId`, `incidentId`, `sourceIncidentId` e `number` têm responsabilidades
distintas:

| Campo | Responsabilidade | Exposição pública |
|---|---|---|
| `recordId` | idempotência do registro de ingestão | não |
| `incidentId` | identidade canônica do incidente | sim, como `id` |
| `sourceIncidentId` | `sys_id` do ServiceNow | não |
| `number` | referência humana `INC...` | sim, pode ser `null` |

O ID canônico é estável entre origens:

```text
incidentId = "inc_" + base32(
  sha256("incident:v1:servicenow:" + sys_id)
)[:26]
```

O namespace é `servicenow`, não `argus`. Se o mesmo incidente for lido no
futuro pelo BigQuery com o mesmo `sys_id`, ele produzirá o mesmo `incidentId`.
O número humano não é usado como chave porque pode estar ausente ou mudar.

## 10. Mapeamento físico da origem

| Tabela Argus | Contrato canônico | Grão | Lookback de sync |
|---|---|---:|---:|
| `signal_bucket` | `SignalObservation` | 15 min | 24 h |
| `live_active_15min` | `DimensionalMetricAggregate` | 15 min | 48 h |
| `live_qoe_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `player_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `device_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `geo_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `live_error_attr_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `error_cat_hourly` | `DimensionalMetricAggregate` | 1 h | 48 h |
| `incidents` | `Incident` | evento | novos + não finalizados |
| `signal_meta` | `UpstreamSourceHealth` | atual | leitura completa |
| `collector_run`, `*_run` | `UpstreamCollectorRun` | execução | desde checkpoint |

### 10.1 Chaves naturais

| Dataset | Chave natural |
|---|---|
| `signal_bucket` | `source, entity, metric, bts` |
| `live_active_15min` | `bucket_ts, sinal` |
| `live_qoe_hourly` | `hour_ts, sinal` |
| `player_hourly` | `hour_ts, player` |
| `device_hourly` | `hour_ts, device` |
| `geo_hourly` | `hour_ts, state_province, isp` |
| `live_error_attr_hourly` | `hour_ts, sinal, cdn, tier, http_code, error_name` |
| `error_cat_hourly` | `hour_ts, kind, category` |
| `incidents` | `opened_at, sys_id` na origem; `incidentId` no domínio |
| `signal_meta` | `source` |

### 10.2 Dimensões e medidas

| Dataset | Dimensões | Medidas |
|---|---|---|
| `player_hourly` | `player` | `sessions`, `errors` |
| `device_hourly` | `device` | `sessions`, `errors` |
| `geo_hourly` | `state`, `isp` | `sessions`, `errors` |
| `live_qoe_hourly` | `channel` | sessões, erros, startup errors, latência, buffer, join time, frames, stalls |
| `live_active_15min` | `channel` | sessões ativas, com erro, joins, latência, buffer, join time, frames |
| `live_error_attr_hourly` | `channel`, `cdn`, `tier`, `httpCode`, `errorName` | `errors` |
| `error_cat_hourly` | `contentKind`, `errorCategory` | `errors`, `topErrors` |

`device_hourly.device` é preservado no formato original `vendor|model`. Uma
classificação futura para `deviceType` exige catálogo versionado. `geo_hourly`
recebe `region` derivada de uma tabela de referência UF → região versionada.

`error_cat_hourly.top_names` é parseado defensivamente. JSON inválido gera a
flag `INVALID_SOURCE_JSON`, não invalida a contagem `errors` e não é persistido
como payload bruto. A lista normalizada é limitada para manter o item abaixo
do limite interno.

### 10.3 Exclusões iniciais

- `signal_point` e `prom_point`: volume alto e duplicação funcional com
  materializações selecionadas;
- `incidents_platform`: outro escopo operacional;
- `incident_label`: não deve promover dados automaticamente ao golden set;
- `dashboard_artifact`: payloads podem passar de 8 MB;
- eventos individuais inferidos a partir de agregados;
- `player_live_hourly` e `live_event`: candidatos a uma iteração posterior,
  não fazem parte do contrato v1.

## 11. Validação de schema físico

Cada adapter declara versão, colunas obrigatórias, colunas opcionais, tipos e
enums esperados. Antes da leitura:

- coluna obrigatória ausente: a fonte falha;
- tipo incompatível: a fonte falha;
- coluna nova: é ignorada e registrada;
- coluna opcional ausente: a capability fica parcial;
- enum desconhecido: a fonte falha para evitar mudança semântica silenciosa.

O fingerprint do schema observado é persistido no `IngestionRun`.

Campos opcionais inválidos podem produzir um registro parcial. Chave natural,
timestamp ou medida obrigatória inválida interrompem a fonte e impedem o avanço
do watermark publicado.

## 12. Modelo do DynamoDB

Somente `monitoracao-operacional` é acessada pelo worker. A tabela existente
mantém:

- chave de partição `pk`;
- chave de ordenação `sk`;
- modo `PAY_PER_REQUEST`;
- TTL no atributo `ttl`;
- GSI esparso `trace-index`.

Nenhuma operação inicial exige novo GSI ou `Scan`.

### 12.1 Séries e agregados

```text
PK = FACT#TS#<seriesId>#<YYYYMMDD>
SK = T#<epochMs>#<recordId>
```

`seriesId` é o hash determinístico de dataset, source, entity, metric e
dimensões ordenadas. Os valores originais permanecem no item. A partição diária
limita o crescimento e permite consultar 24 horas acessando no máximo dois dias
por série.

### 12.2 Incidentes

```text
PK = INCIDENT#<incidentId>
SK = META

PK = INCIDENT#<incidentId>
SK = EVIDENCE#<evidenceId>

PK = INCIDENT#<incidentId>
SK = HYPOTHESIS#<hypothesisId>

PK = INCIDENT#<incidentId>
SK = TIMELINE#<timestamp>#<timelineItemId>
```

O worker v1 grava o `META`. Evidências, hipóteses e timeline usam a mesma
partição quando um caso de uso autorizado passar a produzi-las.

Projeções de listagem:

```text
PK = VIEW#INCIDENTS#DAY#<YYYYMMDD>
SK = OPENED#<epochMs>#<incidentId>

PK = VIEW#INCIDENTS#ACTIVE
SK = PRIORITY#<priority>#STARTED#<epochMs>#<incidentId>
```

Atualizações de baixo volume do incidente e de seus índices usam operação
transacional para não deixar entradas ativas obsoletas.

### 12.3 Read models

```text
VIEW#OVERVIEW#<sliceId>#<YYYYMMDD>
VIEW#INCIDENT_IMPACT#<YYYYMMDD>
VIEW#MONITORING#<source>#<YYYYMMDD>
VIEW#GEOGRAPHY#<metric>#<YYYYMMDD>
```

Itens temporais usam `SK = T#<epochMs>...`. Cada partição pode ter `SK = META`
com granularidade, dimensões suportadas, fontes, cobertura, watermark, versão da
fórmula e qualidade.

### 12.4 Controle

```text
PK = INGESTION#SOURCE#<source>  SK = CHECKPOINT
PK = INGESTION#SOURCE#<source>  SK = HEALTH
PK = INGESTION#SOURCE#<source>  SK = LEASE

PK = INGESTION#RUN#<runId>      SK = META
PK = INGESTION#RUN#<runId>      SK = ERROR#<sequence>

PK = VIEW#INGESTION_RUNS#<YYYYMMDD>
SK = STARTED#<epochMs>#<source>#<runId>
```

### 12.5 Retenção e tamanho

| Tipo | Retenção |
|---|---|
| fatos e projeções temporais | 30 dias desde `observedAt` |
| incidente aberto | sem TTL |
| incidente finalizado e filhos | 90 dias desde `closedAt` ou `resolvedAt` |
| runs e erros | 90 dias desde o fim da execução |
| checkpoints e estado atual | sem TTL |
| lease | expiração curta para limpeza, não para decisão de lock |
| golden set | sem TTL; fora do worker |

O limite interno é 200 KB por registro, deixando margem para o limite de 256
KB do SQS futuro e o limite de 400 KB do DynamoDB. Payload maior deve ser
dividido ou armazenado no S3, deixando apenas uma referência canônica.

## 13. Projeções e fórmulas

### 13.1 Visão Geral

| Informação | Fonte | Fórmula/semântica |
|---|---|---|
| erros/min global | `error_cat_hourly` | soma de categorias disjuntas ÷ 60 |
| erros/min por canal | `live_qoe_hourly` | `errors ÷ 60` |
| latência p95 por canal | `live_active_15min` ou `live_qoe_hourly` | percentil fornecido pela origem |
| sessões afetadas ao vivo | `live_active_15min` | `active_with_error` do bucket |
| sessões observadas | `live_active_15min` | `active_sessions` |
| participação afetada | `live_active_15min` | `active_with_error / active_sessions` |

`active_with_error` representa sessões concorrentes, não usuários únicos da
janela. P95 global não é média de percentis por canal. Sem um agregado global
explícito, o valor é `null/unknown`.

O gráfico usa uma métrica real, como `errors_per_minute` ou
`affected_session_ratio`. Não existe `experience_health_score` composto no v1.

### 13.2 Incidentes e impacto

Campos diretos do ServiceNow são `measured`. Impacto só é `measured` quando há
vínculo explícito; uma correlação aprovada é `estimated`; ausência de vínculo é
`unknown`. Coincidência temporal pode ser contexto, mas não evidência causal.

A ingestão não cria hipóteses. Quando não houver fonte explícita de diagnóstico:

```json
{
  "impact": {
    "status": "unknown",
    "affectedSessions": null,
    "affectedDevices": null,
    "shareOfObservedSessions": null
  }
}
```

### 13.3 Monitoramento

| Métrica | Cálculo |
|---|---|
| taxa de leitura | `recordsRead / duração em minutos` |
| taxa de escrita | `recordsWritten / duração em minutos` |
| atualizações | itens com `payloadHash` diferente |
| inalterados | itens com `payloadHash` idêntico |
| rejeitados | violações de contrato |
| latência p95 | p95 da duração dos chunks |
| duração | `finishedAt - startedAt` |
| source lag | `finishedAt - max(observedAt)` ajustado ao SLA da fonte |
| cobertura | buckets válidos ÷ buckets esperados |
| fila e DLQ | `null/unknown` no v1 |

O fluxo inicial é `read → normalize → write → project`.

### 13.4 Geografia

`geo_hourly` fornece:

```text
dimensions = state + isp
affectedSessions = errors
observedSessions = sessions
errorSessionRatio = errors / sessions
```

Região é derivada por catálogo versionado de UF. Latência p95 geográfica e
perda de eventos geográfica são indisponíveis no v1 porque a fonte não contém
essas medidas.

### 13.5 Slices suportados

- global;
- canal;
- player;
- modelo de dispositivo;
- estado;
- estado + ISP;
- tipo de conteúdo;
- categoria de erro;
- canal + CDN + camada + código HTTP.

Não são suportados inicialmente `appVersion`, combinações arbitrárias entre
dimensões, latência por estado ou eventos individuais. Apenas slices
representáveis por uma fonte são materializados.

### 13.6 Rastreabilidade

Toda projeção contém `formulaVersion`, fontes de entrada, watermarks, cobertura
e flags. Divisão por zero resulta em `null`; fonte atrasada não vira zero;
percentis não são reagrupados por média.

## 14. Backfill

O dump é restaurado em MySQL 8/Percona. O Python consulta o banco restaurado;
ele não interpreta diretamente o SQL de 11 GB.

Comando conceitual:

```bash
python -m ingestion_data backfill \
  --sources signal_bucket,incidents,live_active_15min \
  --from 2026-07-07T00:00:00Z \
  --to 2026-08-07T00:00:00Z
```

O preflight valida região, tabela, conexão, schema, intervalo disponível,
permissões e versões. A paginação é por chave natural, nunca por `OFFSET`.

Para `signal_bucket`:

```sql
WHERE bts > :last_bts
   OR (bts = :last_bts
       AND (source, entity, metric) > (:source, :entity, :metric))
ORDER BY bts, source, entity, metric
LIMIT :chunk_size
```

Cada página é normalizada e consulta os hashes existentes com `BatchGetItem`
em lotes de até 100 chaves. Somente itens novos ou com `payloadHash` diferente
são enviados ao `BatchWriteItem`, em lotes de até 25 itens. Todos os
`UnprocessedKeys` e `UnprocessedItems` são repetidos antes da reconciliação e do
avanço do cursor. Assim, uma reexecução idempotente não consome escrita para
registros inalterados.

## 15. Checkpoints e sincronização

Cada fonte mantém:

```json
{
  "resumeCursor": {
    "timestamp": 1787788800000,
    "key": ["rpaas", "entity", "p95_ms"]
  },
  "publishedWatermark": 1787787900000,
  "contractVersion": "1.0"
}
```

- `resumeCursor` avança após um chunk completamente persistido;
- `publishedWatermark` avança apenas quando toda a janela termina;
- o dashboard nunca usa `resumeCursor` para frescor.

Sync a cada 15 minutos:

```text
start = publishedWatermark - sourceLookback
end   = now - sourceSafetyDelay
```

O lookback permite receber correções. Incidentes leem novos registros e
revisitam todos os não finalizados. Falha de uma fonte não desfaz fontes já
publicadas.

Fatos e projeções possuem checkpoints separados. Uma projeção pode ser
reconstruída sem consultar o Argus novamente.

## 16. Leases e concorrência

- lease global impede duas sincronizações completas concorrentes;
- lease por fonte impede conflito entre backfill, sync e reprocessamento;
- uma execução concorrente termina como `SKIPPED_LOCKED`;
- lease usa escrita condicional e renovação periódica;
- `leaseExpiresAt` decide expiração; remoção por TTL é apenas limpeza.

## 17. Comandos da aplicação

```text
validate
backfill
sync
reprocess
rebuild-projections
```

`reprocess` relê uma fonte e uma janela. `rebuild-projections` usa os fatos do
DynamoDB sem reler a origem.

## 18. Erros e recuperação

| Categoria | Comportamento |
|---|---|
| transitório | retry com backoff exponencial e jitter |
| opcional inválido | persiste com flag de qualidade |
| obrigatório inválido | falha a fonte, sem publicar watermark |
| schema drift | falha antes da leitura |
| projeção | fatos permanecem; projeção pode ser refeita |
| configuração/autorização | falha toda a execução |

Estados de run: `SUCCEEDED`, `PARTIAL`, `FAILED`, `SKIPPED_LOCKED`.

Erros transitórios têm no máximo cinco tentativas por operação. Erros de
contrato, autenticação e configuração não recebem retry automático.

Erros sanitizados são persistidos em:

```text
PK = INGESTION#RUN#<runId>
SK = ERROR#<sequence>
```

Incluem fonte, etapa, código, severidade, cursor, tentativa, fingerprint,
mensagem segura e timestamp. Não incluem segredo, DSN, payload completo, PII ou
stack trace com parâmetros. Erros iguais são agregados por fingerprint e as
amostras persistidas são limitadas.

Sem DLQ, a recuperação ocorre por checkpoint e `reprocess`.

## 19. Preparação para SQS e DLQ

O domínio publica para `CanonicalRecordSink`. No v1, a implementação é
`DynamoDirectSink`. No futuro:

```text
CanonicalRecordSink
  → SqsPublisher
  → SQS Standard
  → DynamoConsumer
  → DynamoDB
          ↘ falha definitiva → DLQ
```

Envelope futuro:

```json
{
  "eventId": "rec_...",
  "eventType": "signal_observation",
  "schemaVersion": "1.0",
  "idempotencyKey": "rec_...",
  "source": "argus",
  "occurredAt": "2026-08-26T18:00:00.000Z",
  "producedAt": "2026-08-26T18:16:00.000Z",
  "runId": "run_...",
  "payload": {}
}
```

O consumidor tolera duplicação e chegada fora de ordem. Replay da DLQ preserva
`eventId`. O desenho não depende de FIFO.

Com fila, os watermarks são:

```text
sourceWatermark       dados confirmados pelo SQS
materializedWatermark dados persistidos no DynamoDB
projectionWatermark   read models recalculados
```

O dashboard usa somente materialização ou projeção, nunca apenas publicação.
Adicionar SQS exige consumidor e novas métricas, mas preserva readers, domínio,
IDs, contratos canônicos, projeções e modelo DynamoDB.

## 20. Segurança e privacidade

A task pode:

- ler o segredo configurado para a origem;
- escrever e consultar `monitoracao-operacional`;
- escrever logs e métricas.

A task não pode:

- acessar `monitoracao-golden-set`;
- alterar infraestrutura;
- apagar tabelas;
- ler segredos de outros serviços;
- fazer `Scan` operacional amplo.

Configuração mínima:

```text
AWS_REGION=us-east-1
OPERATIONAL_TABLE=monitoracao-operacional
ARGUS_SECRET_ARN=<fornecido pelo ambiente>
ENABLED_SOURCES=<lista aprovada>
CHUNK_SIZE=<valor validado>
```

A aplicação falha se a região for diferente de `us-east-1` ou se a tabela for
o golden set. Conexão remota ao Argus exige TLS. Credenciais não entram na
imagem, no repositório ou nos logs.

O adapter de incidentes usa allowlist. `scr_vendor_point_of_contact` é sempre
proibido. Texto livre só pode entrar após sanitização explícita. `sys_id` fica
como referência interna e não é emitido nas projeções públicas.

## 21. Observabilidade

Cada etapa emite logs JSON com `runId`, fonte, duração, quantidades, watermark e
estado. Métricas:

- sucesso/falha por fonte;
- última execução bem-sucedida;
- source lag e idade de checkpoint;
- duração;
- lidos, escritos, atualizados, inalterados e rejeitados;
- retries;
- cobertura;
- falhas e atraso de projeção;
- lease ocupado ou expirado.

Alarmes iniciais:

- nenhuma sincronização bem-sucedida em 30 minutos;
- fonte além do SLA;
- run `FAILED`;
- schema drift;
- projeção atrasada;
- lease sem renovação.

Fila e DLQ permanecem `null/unknown` até existirem.

## 22. Implantação AWS

Recursos reutilizados em `us-east-1`:

- ECR `data-ingestion-service`;
- cluster `data-ingestion-cluster`;
- task family `data-ingestion-task`;
- DynamoDB `monitoracao-operacional`.

Topologia desejada:

```text
EventBridge Scheduler (15 min)
  → ECS RunTask
      → lê Argus
      → normaliza
      → grava DynamoDB
      → encerra
```

A task batch não expõe porta HTTP, não usa health check HTTP e não precisa de
ALB ou ECS Service permanente. Backfill e reprocessamento usam `RunTask` com
command override.

A imagem usa tag imutável baseada no commit. A task definition configura
`awslogs`, task role, execution role, secrets e região. O log group
`/ecs/data-ingestion` tem retenção inicial de 90 dias.

O dimensionamento inicial é 1 vCPU e 2 GB de memória. A paginação mantém a
memória limitada; duração, memória, throttling e custo determinam qualquer
ajuste posterior. O gargalo esperado é I/O entre MySQL e DynamoDB.

O Scheduler usa flexible time window desabilitada, retry limitado para falhas
de inicialização e uma role restrita a `ecs:RunTask` e `iam:PassRole`. A task
roda em subnets privadas, sem entrada pública. A conectividade de saída deve
alcançar o Argus e os endpoints AWS necessários.

Antes do backfill, o preflight também confirma TTL no atributo `ttl`, Point-in-
Time Recovery e capacidade on-demand. O repositório ECR deve usar scan de imagem
e tags imutáveis para as novas versões; `latest` não identifica um deployment.

Para backfill no ECS, o MySQL restaurado precisa ser acessível pela VPC. O dump
não entra na imagem Docker. A mesma aplicação pode rodar localmente contra um
MySQL local quando esse for o ambiente do snapshot.

Migração segura:

1. publicar a nova imagem;
2. registrar nova revisão da task;
3. manter o placeholder na revisão antiga;
4. executar `validate`;
5. ingerir uma amostra;
6. reconciliar itens, TTL, custo e logs;
7. executar o backfill;
8. habilitar o Scheduler;
9. observar ao menos três sincronizações;
10. retirar o placeholder somente com autorização explícita.

Nenhum recurso legado é removido automaticamente.

## 23. Estratégia de testes

### 23.1 Unitários

- IDs e hashes determinísticos;
- timestamps UTC;
- `Decimal` e TTL;
- unidade por source + metric;
- parsing defensivo;
- qualidade;
- sanitização;
- lookback e checkpoints;
- divisão por zero;
- limite de 200 KB.

### 23.2 Contrato dos adapters

Fixtures válidas e inválidas para cada tabela verificam colunas, tipos, enums,
chaves, timestamps, nulos e schema drift. Um reader falso implementando a porta
prova que o domínio não depende do MySQL.

### 23.3 Integração

```text
MySQL 8 com schema e fixtures
  → aplicação
  → DynamoDB Local
```

Cobertura: paginação, batch write, `UnprocessedItems`, leases, checkpoints,
transações de incidentes, queries, reprocessamento, projeções e retomada.

### 23.4 Idempotência e falhas

- executar o mesmo backfill duas vezes;
- interromper entre chunks e retomar;
- alterar uma linha e executar lookback;
- falhar uma fonte;
- falhar uma projeção;
- reconstruir projeções;
- disputar o mesmo lease.

### 23.5 Reconciliação

Para cada fonte e janela:

```text
recordsRead = new + updated + unchanged + rejected
```

Também são comparados timestamps mínimo/máximo, chaves distintas, somas
aditivas, amostras determinísticas e cobertura.

## 24. Critérios de aceite

- backfill pode ser retomado sem reiniciar do zero;
- reexecução produz o mesmo estado;
- sync termina antes do próximo intervalo de 15 minutos;
- nenhuma consulta operacional usa `Scan`;
- uma fonte falha sem bloquear as demais;
- fatos e projeções possuem checkpoints distintos;
- números possuem unidade, origem e qualidade;
- indisponibilidade usa `null`, não zero;
- percentis não são promediados;
- sessões concorrentes não são rotuladas como usuários únicos;
- incidentes usam ID canônico estável;
- o worker não acessa o golden set;
- logs e erros são sanitizados;
- memória é limitada pelos chunks;
- região diferente de `us-east-1` é rejeitada;
- readers e sinks podem ser substituídos sem alterar o domínio;
- read models atendem somente capacidades sustentadas por dados reais;
- o frontend pode exibir dados reais ou estados explícitos de indisponibilidade;
- SQS e DLQ podem ser adicionados sem substituir os contratos canônicos.

## 25. Rollout

```text
validate sem escrita
  → uma fonte/uma hora
  → reconciliação
  → todas as fontes/um dia
  → projeções
  → backfill de 30 dias
  → Scheduler
  → três sincronizações observadas
```

Rollback operacional significa pausar o Scheduler, preservar os itens e
checkpoints para diagnóstico, corrigir e reprocessar. Não há exclusão ou
rollback destrutivo automático.

## 26. Relação com o dashboard

O worker não grava respostas HTTP. A sequência permanece:

```text
Argus → contratos canônicos → DynamoDB/read models → API → frontend
```

A API é responsável por transformar projeções em envelopes públicos, aplicar
capabilities, distinguir `null` de zero e esconder chaves físicas. Filtros não
representáveis pelo Argus permanecem indisponíveis. Eventos individuais, fila
e DLQ não são simulados.

O documento do contrato do dashboard é mantido por outro fluxo e não é
modificado por esta especificação.

## 27. Próxima fase

Após a revisão deste documento, outra sessão do Superpowers criará o plano de
implementação da aplicação Python, adapters, testes, task ECS, Scheduler,
observabilidade e rollout. Esta especificação é a entrada normativa dessa
sessão.
