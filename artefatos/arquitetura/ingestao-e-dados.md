# Ingestão e dados: ARGUS → DynamoDB

- **Status:** aprovado para implementação
- **Versão:** 1.1
- **Última atualização:** 06/09/2026
- **Responsáveis:** equipe de ingestão e dados
- **Região AWS:** `us-east-1`

## 1. Finalidade

Este documento é a fonte normativa da arquitetura de ingestão e do contrato de dados entre o ARGUS e o View Show. Ele define:

- como o serviço de ingestão é organizado e executado;
- quais dados entram a partir do Argus;
- como os registros físicos são validados;
- como são transformados em registros canônicos;
- como identidades, timestamps, números e qualidade são representados;
- como os registros são persistidos em `monitoracao-operacional`;
- como idempotência, retenção, checkpoints e evolução de schema funcionam;
- quais projeções são produzidas para a API e para o Worker de Análise;
- como o serviço é implantado, observado e recuperado na AWS.

### 1.1 Decisão arquitetural

A primeira versão do Data Ingestion Service é um monólito modular escrito em Python, com separação entre domínio, casos de uso, portas e adaptadores. Ele não é uma API HTTP: cada operação é iniciada como uma tarefa do ECS/Fargate e termina após processar a janela solicitada.

```text
ARGUS/MySQL
  → adaptador da origem
  → domínio canônico
  → casos de uso de ingestão
  → DynamoDB e projeções
  → outbox
  → SQS de análise
```

A persistência dos dados ingeridos é direta no DynamoDB. A fila não transporta todos os registros do ARGUS; ela recebe somente solicitações para que o Worker de Análise processe uma janela que já foi materializada. Essa separação impede que uma indisponibilidade do Worker bloqueie a ingestão.

### 1.2 Estrutura lógica do serviço

```text
apps/backend/ingestion-data/
├── domain/         modelos, valores e regras canônicas
├── application/    backfill, sync, reprocessamento e projeções
├── ports/          contratos de leitura, persistência, e observabilidade
├── adapters/       MySQL, DynamoDB, S3, SQS e CloudWatch
└── bootstrap/      CLI, configuração e composição das dependências
```

Os casos de uso dependem de portas e não conhecem detalhes do MySQL, DynamoDB ou SQS. Essa separação permite trocar a origem ativa por BigQuery ou outro adaptador equivalente sem alterar as identidades canônicas nem o frontend.

Portas principais:

- `SourceReader`: valida o schema e lê páginas por chave natural;
- `CanonicalRecordSink`: persiste registros canônicos no DynamoDB;
- `ProjectionRepository`: consulta fatos e grava modelos de leitura;
- `CheckpointRepository`: controla retomada e publicação de janelas;
- `LeaseRepository`: controla o bloqueio temporário das execuções;
- `AnalysisRequestPublisher`: publica pedidos de análise após a materialização;
- `RunRepository` e `MetricsPublisher`: registram execução e observabilidade.

### 1.3 Comandos operacionais

```text
validate             verifica ambiente e contratos sem gravar fatos
backfill             processa uma janela histórica de um dump restaurado
sync                 processa a janela incremental do banco ativo
reprocess            relê uma fonte e uma janela informadas
rebuild-projections  reconstrói projeções sem consultar o ARGUS
```

O comando `sync` é executado a cada 15 minutos pelo EventBridge Scheduler. A importação de dump utiliza `backfill` em uma tarefa isolada, mas reutiliza os mesmos adaptadores, contratos canônicos e regras de persistência.

### 1.4 Fluxo resumido

```text
adquirir bloqueio temporário
  → validar ambiente e schema físico
  → calcular a janela de leitura
  → ler, normalizar e comparar registros em páginas
  → gravar somente itens novos ou alterados
  → atualizar as projeções afetadas
  → publicar watermark e outbox na mesma transação
  → enviar solicitações de análise à SQS
  → finalizar a execução e liberar o bloqueio
```

A solicitação `ANOMALY_DETECTION` é publicada para a janela de 15 minutos mais recente. Quando uma nova janela horária estiver completa, a mesma execução também publica `QOE_FORECAST`. Cada tipo possui um item independente na outbox, permitindo repetir somente a publicação pendente sem duplicar a análise.

### 1.5 Implantação, segurança e observabilidade

O serviço utiliza os seguintes recursos em `us-east-1`:

- EventBridge Scheduler para a execução periódica;
- ECS/Fargate para `sync`, `backfill` e reprocessamento;
- Secrets Manager para as credenciais da origem;
- S3 para dumps e payloads autorizados que ultrapassem o limite interno;
- DynamoDB para fatos, projeções, checkpoints, execuções e outbox;
- SQS para solicitações de análise;
- CloudWatch para logs, métricas e alarmes.

A tarefa não possui porta HTTP nem entrada pública. Sua função IAM permite somente as operações necessárias sobre a origem, o S3, a tabela operacional e a fila de análise. Ela não pode ler nem escrever no conjunto de diagnósticos confirmados.

Logs estruturados registram `runId`, fonte, etapa, duração, contagens e watermarks. Os alarmes mínimos cobrem ausência de execução bem-sucedida, atraso da fonte, falha permanente, mudança incompatível de schema, projeção atrasada e outbox pendente além do período esperado.

### 1.6 Estratégia de testes e implantação gradual

A implementação deve possuir testes unitários para identidades, tempo, `Decimal`, TTL, hashes e qualidade; testes de contrato para cada origem; e testes de integração do MySQL até o DynamoDB. Também devem ser exercitados reprocessamento idempotente, retomada após interrupção, disputa pelo bloqueio, falha de projeção e recuperação de publicação da SQS.

A implantação começa com `validate`, avança para uma fonte e uma janela curta, executa a reconciliação das contagens, habilita as projeções e somente então ativa o Scheduler. Uma reversão pausa novas execuções e reprocessa as janelas afetadas depois da correção; não exige apagar dados já persistidos.

## 2. Fronteiras do contrato

```text
Argus físico
  → adapter da origem
  → contrato canônico
  → adapter de persistência
  → monitoracao-operacional
```

Este contrato não define DTOs HTTP do dashboard. A API transforma os read models do DynamoDB em seu contrato público sem expor `pk`, `sk`, TTL, checkpoints ou identificadores físicos da origem.

O Serviço de Ingestão não lê nem escreve `monitoracao-golden-set`. O Worker de Análise possui somente leitura nessa tabela, conforme o contrato de análise.

## 3. Perfil da entrada

### 3.1 Origem inicial

- Motor: MySQL 8.0/Percona 8.0.
- Collation esperada: `utf8mb4_bin`.
- Timestamps: predominantemente epoch em milissegundos UTC.
- Snapshot: dump restaurado em MySQL, nunca interpretado diretamente pelo Serviço de Ingestão.
- Operação contínua: conexão ao banco vivo do Argus quando ela estiver disponível.

Perfis suportados:

```text
ARGUS_SOURCE_MODE=snapshot
ARGUS_SOURCE_MODE=live
```

Ambos implementam o mesmo `SourceReader`. Host, porta, banco e credenciais são fornecidos por segredo de ambiente.

### 3.2 Evolução da origem

Um futuro `ArgusBigQueryReader` pode substituir o reader MySQL. O mecanismo de leitura é registrado em `ingestion.readerAdapter`, mas não participa da identidade do fato.

Quando BigQuery expuser os mesmos dados lógicos:

```text
source.system     permanece argus
source.dataset    permanece estável
naturalKey        permanece estável
recordId          permanece estável
readerAdapter     muda de argus_mysql para argus_bigquery
```

Uma fonte semanticamente diferente recebe outro namespace.

## 4. Datasets aceitos no contrato v1

| Dataset físico | Tipo canônico | Grão | Lookback de sync |
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
| `collector_run` e `*_run` | `UpstreamCollectorRun` | execução | desde checkpoint |

Não entram no v1:

- `signal_point` e `prom_point`, pelo volume e duplicação funcional;
- `incidents_platform`, por pertencer a outro escopo;
- `incident_label`, para impedir promoção automática ao golden set;
- `dashboard_artifact`, porque alguns payloads passam de 8 MB;
- `player_live_hourly` e `live_event`, reservados para outra iteração;
- qualquer evento individual inferido a partir de agregados.

## 5. Contratos físicos

### 5.1 `signal_bucket`

Chave natural:

```text
source + entity + metric + bts
```

| Campo | Obrigatório | Semântica |
|---|---:|---|
| `bts` | sim | início do bucket de 15 minutos em epoch ms UTC |
| `source` | sim | fonte de telemetria |
| `entity` | sim | entidade dentro da fonte |
| `metric` | sim | métrica dentro da fonte |
| `value` | sim | valor já resolvido pelo Argus |

`source`, `entity` e `metric` são case-sensitive. A unidade é resolvida pela combinação `source + metric`, nunca somente por `metric`.

### 5.2 `live_active_15min`

Chave natural:

```text
bucket_ts + sinal
```

Dimensão: `channel = sinal`.

Medidas:

- `active_sessions`;
- `active_with_error`;
- `joins_in_bucket`;
- `latency_ms_p50` e `latency_ms_p95`;
- `bufferratio_avg`;
- `jointime_s_avg`;
- `dropped_frames_avg`.

`active_with_error` representa sessões concorrentes com erro, não usuários únicos durante a janela.

### 5.3 `live_qoe_hourly`

Chave natural:

```text
hour_ts + sinal
```

Dimensão: `channel = sinal`.

Medidas:

- `sessions`, `errors`, `startup_errors`;
- `latency_ms_avg`, `latency_ms_p50`, `latency_ms_p95`;
- `bufferratio_avg`, `jointime_s_avg`;
- `dropped_frames_avg`, `stalls_avg`.

### 5.4 `player_hourly`

Chave natural: `hour_ts + player`. Dimensão: `player`. Medidas: `sessions`, `errors`.

### 5.5 `device_hourly`

Chave natural: `hour_ts + device`. Dimensão: `device`, preservada no formato original `vendor|model`. Medidas: `sessions`, `errors`.

O contrato não converte automaticamente modelo em `deviceType`. Essa conversão exige catálogo versionado.

### 5.6 `geo_hourly`

Chave natural:

```text
hour_ts + state_province + isp
```

Dimensões: `state`, `isp` e `region` derivada por catálogo UF → região versionado. Medidas: `sessions`, `errors`.

Não há latência nem perda de eventos nessa tabela.

### 5.7 `live_error_attr_hourly`

Chave natural:

```text
hour_ts + sinal + cdn + tier + http_code + error_name
```

Dimensões:

- `channel`;
- `cdn`;
- `tier`;
- `httpCode`;
- `errorName`.

Medida: `errors`.

Valores conhecidos de `tier`: `playback_api`, `edge_isp`, `core`, `other`.

### 5.8 `error_cat_hourly`

Chave natural:

```text
hour_ts + kind + category
```

Dimensões:

- `contentKind`: `live` ou `vod`;
- `errorCategory`: `entrega`, `origem`, `acesso`, `player` ou `outros`.

Medidas: `errors` e `topErrors`.

`top_names` é JSON de origem. Parse inválido gera `quality.flags = ["INVALID_SOURCE_JSON"]`, mas não invalida `errors`. O payload bruto não é persistido e a lista normalizada é limitada.

### 5.9 `incidents`

Chave física: `opened_at + sys_id`. Identidade semântica: `servicenow + sys_id`.

Campos permitidos:

- `sys_id`, usado somente como referência interna;
- `number`;
- abertura, resolução e encerramento;
- prioridade e estado;
- assignment group, business service e CMDB CI;
- categoria e subcategoria;
- componente de impacto;
- flags de impacto externo e mudança/deploy;
- relação pai/filhos;
- fornecedor e ticket do fornecedor, quando sanitizados.

Campos proibidos ou condicionados:

- `scr_vendor_point_of_contact`: sempre proibido;
- descrições, causa e notas livres: somente após sanitização explícita;
- secrets, tokens, e-mails e nomes pessoais: proibidos.

### 5.10 Saúde e runs upstream

`signal_meta` fornece watermark e contagens por fonte. `collector_run` e as tabelas legadas fornecem início, fim, janela, duração e quantidades.

O adapter normaliza a diferença entre epoch ms de `collector_run` e timestamps ISO textuais das tabelas legadas.

## 6. Validação do schema físico

Cada dataset possui um descriptor versionado com:

```json
{
  "dataset": "live_active_15min",
  "contractVersion": "1.0",
  "requiredColumns": {
    "bucket_ts": "BIGINT",
    "sinal": "VARCHAR",
    "active_sessions": "BIGINT",
    "active_with_error": "BIGINT"
  },
  "optionalColumns": {
    "latency_ms_p95": "DOUBLE"
  }
}
```

Regras:

- coluna obrigatória ausente: falha a fonte;
- tipo incompatível: falha a fonte;
- enum novo: falha a fonte;
- coluna nova: ignorada e registrada;
- coluna opcional ausente: qualidade parcial;
- chave, timestamp ou medida obrigatória inválida: falha a fonte;
- campo opcional inválido: registro parcial com flag.

O fingerprint do schema observado é salvo no run.

## 7. Envelope canônico

```json
{
  "schemaVersion": "1.0",
  "recordType": "signal_observation",
  "recordId": "rec_...",
  "source": {
    "system": "argus",
    "dataset": "signal_bucket",
    "naturalKey": {
      "source": "rpaas",
      "entity": "br1|playback.video.globo.com",
      "metric": "p95_ms",
      "bts": 1787788800000
    }
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

Enums:

```text
measurement.status = measured | estimated | unknown
quality.status     = verified | partial | delayed | unavailable
```

`null` significa indisponível ou não medido. Zero significa medido sem ocorrência.

## 8. Identidades e hashes

Canonicalização:

- UTF-8;
- chaves ordenadas;
- timestamps ISO UTC;
- `Decimal` em base 10 sem locale;
- listas em ordem semântica definida;
- proibição de `NaN` e infinito.

```text
recordId = "rec_" + base32(
  sha256(schemaVersion + recordType + source.system + source.dataset
         + canonicalNaturalKey)
)[:26]
```

`payloadHash` inclui payload, janela, medição e qualidade. Não inclui `runId`, `ingestedAt` ou `readerAdapter`. O `recordId` permanece estável entre versões do dataset para permitir comparação e rastreabilidade; o isolamento entre versões é realizado pelas chaves físicas que incluem `datasetVersion`.

### 8.1 Incidentes

```text
incidentId = "inc_" + base32(
  sha256("incident:v1:servicenow:" + sys_id)
)[:26]
```

| Campo | Uso |
|---|---|
| `recordId` | idempotência da ingestão |
| `incidentId` | ID canônico usado no domínio, DynamoDB e API |
| `sourceIncidentId` | `sys_id`, referência interna |
| `number` | referência humana `INC...`, pode ser `null` |

O `number` nunca é chave primária.

## 9. Contratos canônicos

### 9.1 `SignalObservation`

```json
{
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
```

### 9.2 `DimensionalMetricAggregate`

```json
{
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
```

### 9.3 `Incident`

```json
{
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
  "externalImpact": true,
  "causedByChangeOrDeploy": false
}
```

## 10. Contrato de persistência

### 10.1 Tabelas físicas

```text
monitoracao-operacional  fatos, incidentes, projeções e controle
monitoracao-golden-set   curadoria humana/ML; inacessível à ingestão
```

`monitoracao-operacional` usa `pk`, `sk`, modo `PAY_PER_REQUEST`, TTL no atributo `ttl` e GSI esparso `trace-index`.

### 10.2 Fatos temporais

```text
PK = DATASET#<datasetVersion>#FACT#TS#<seriesId>#<YYYYMMDD>
SK = T#<epochMs>#<recordId>
```

`seriesId` é o hash do dataset lógico, fonte, entidade, métrica e dimensões ordenadas. Os valores originais permanecem como atributos. `datasetVersion` identifica a versão física criada por uma importação e impede que um backfill sobrescreva gradualmente a versão que ainda atende às consultas.

Exemplo:

```json
{
  "pk": "DATASET#dsv_01K2F8BAYX#FACT#TS#4e98a1...#20260826",
  "sk": "T#1787788800000#rec_a23...",
  "datasetVersion": "dsv_01K2F8BAYX",
  "recordType": "signal_observation",
  "seriesId": "4e98a1...",
  "observedAt": "2026-08-26T18:00:00.000Z",
  "payload": {
    "telemetrySource": "rpaas",
    "entity": {
      "type": "edge_vhost",
      "id": "br1|playback.video.globo.com"
    },
    "metric": {
      "name": "p95_ms",
      "value": 310,
      "unit": "milliseconds"
    }
  },
  "payloadHash": "sha256:...",
  "ttl": 1790380800
}
```

### 10.3 Incidentes

```text
PK = DATASET#<datasetVersion>#INCIDENT#<incidentId>  SK = META
PK = DATASET#<datasetVersion>#INCIDENT#<incidentId>  SK = EVIDENCE#<evidenceId>
PK = DATASET#<datasetVersion>#INCIDENT#<incidentId>  SK = HYPOTHESIS#<hypothesisId>
PK = DATASET#<datasetVersion>#INCIDENT#<incidentId>  SK = TIMELINE#<timestamp>#<itemId>
```

O worker v1 grava apenas `META`. Outros casos de uso autorizados podem gravar evidências, hipóteses e timeline na mesma partição.

Índices de listagem:

```text
PK = DATASET#<datasetVersion>#VIEW#INCIDENTS#DAY#<YYYYMMDD>
SK = OPENED#<epochMs>#<incidentId>

PK = DATASET#<datasetVersion>#VIEW#INCIDENTS#ACTIVE
SK = PRIORITY#<priority>#STARTED#<epochMs>#<incidentId>
```

### 10.4 Controle

```text
PK = DATASET#<datasetVersion>#INGESTION#SOURCE#<source>  SK = CHECKPOINT
PK = DATASET#<datasetVersion>#INGESTION#SOURCE#<source>  SK = HEALTH
PK = INGESTION#SOURCE#<source>  SK = LEASE

PK = INGESTION#RUN#<runId>      SK = META
PK = INGESTION#RUN#<runId>      SK = ERROR#<sequence>

PK = CONTROL#DATASET             SK = ACTIVE
activeDatasetVersion = <datasetVersion>
```

O item `CONTROL#DATASET/ACTIVE` é o único ponto usado pelo Backend e pelo Worker para selecionar a versão consultável. Cada `ImportJob` registra `candidateDatasetVersion`; a troca condicional de `activeDatasetVersion` ocorre apenas depois que fatos, projeções e watermarks da candidata foram validados. Uma falha mantém o ponteiro anterior e deixa a versão incompleta invisível para as consultas.

### 10.5 Tipos DynamoDB

- timestamps de negócio: string ISO UTC;
- timestamps usados em ordenação: epoch ms incorporado na `sk`;
- TTL: epoch em segundos no atributo `ttl`;
- números: DynamoDB Number produzido a partir de `Decimal`;
- booleanos: DynamoDB Boolean;
- campos indisponíveis: `NULL` quando semanticamente necessário;
- mapas e listas: limitados e validados;
- floats especiais: proibidos.

### 10.6 Projeções e padrões de consulta

Os fatos canônicos são mantidos para auditoria e reconstrução. A API não deve consultá-los para montar cada tela em tempo real. O serviço de ingestão produz modelos de leitura com as combinações de dimensões autorizadas pelo contrato.

```text
fatos canônicos
  → identificar janelas e partições afetadas
  → consultar inputs com Query
  → aplicar fórmula versionada
  → calcular qualidade, cobertura e observedThrough
  → gravar somente quando o payloadHash mudar
  → avançar o checkpoint da projeção
```

Projeções principais:

```text
PK = DATASET#<datasetVersion>#VIEW#OVERVIEW#<sliceId>#<YYYYMMDD>
SK = T#<epochMs>

PK = DATASET#<datasetVersion>#VIEW#INCIDENTS#DAY#<YYYYMMDD>
SK = OPENED#<epochMs>#<incidentId>

PK = DATASET#<datasetVersion>#VIEW#INCIDENTS#ACTIVE
SK = PRIORITY#<priority>#STARTED#<epochMs>#<incidentId>

PK = DATASET#<datasetVersion>#VIEW#MONITORING#<source>#<YYYYMMDD>
SK = T#<epochMs>

PK = DATASET#<datasetVersion>#VIEW#GEOGRAPHY#<metric>#<YYYYMMDD>
SK = T#<epochMs>#<dimensionId>
```

Cada projeção registra `datasetVersion`, `projectionVersion`, `formulaVersion`, datasets usados, watermarks de entrada, `observedThrough`, cobertura e qualidade. Uma falha de projeção não remove fatos nem retrocede o checkpoint da fonte.

Na visão geral, erros por minuto são derivados de contagens de categorias disjuntas divididas pela duração da janela; sessões afetadas e observadas vêm de `live_active_15min`; e a participação afetada é calculada pela divisão entre essas duas grandezas. A projeção de monitoramento utiliza contagens dos runs, checkpoints e dados de saúde da origem para apresentar leitura, escrita, rejeições, duração, atraso e cobertura. Toda fórmula possui versão explícita e preserva `null` quando a entrada necessária não foi medida.

As consultas seguem estes padrões:

| Necessidade | Operação | Partição consultada |
| --- | --- | --- |
| Série de uma métrica | `Query` por intervalo de `sk` | `DATASET#<datasetVersion>#FACT#TS#<seriesId>#<dia>` |
| Visão geral | `Query` por janela, em ordem temporal | `DATASET#<datasetVersion>#VIEW#OVERVIEW#<sliceId>#<dia>` |
| Incidentes do dia | `Query` paginada | `DATASET#<datasetVersion>#VIEW#INCIDENTS#DAY#<dia>` |
| Incidentes ativos | `Query` por prioridade e início | `DATASET#<datasetVersion>#VIEW#INCIDENTS#ACTIVE` |
| Detalhe de incidente | `Query` da partição completa ou prefixos de `sk` | `DATASET#<datasetVersion>#INCIDENT#<incidentId>` |
| Saúde da ingestão | `GetItem` | `DATASET#<datasetVersion>#INGESTION#SOURCE#<source>` |
| Execução específica | `Query` | `INGESTION#RUN#<runId>` |

Antes de consultar fatos ou projeções, o Backend e o Worker leem `activeDatasetVersion`; uma execução de análise conserva a versão recebida no evento até o fim. Consultas que atravessam mais de um dia executam uma `Query` por partição diária da mesma versão e combinam os resultados no Backend. `Scan` não faz parte do caminho operacional. O cursor público da API é opaco e encapsula `datasetVersion` e a última chave avaliada, sem expor `pk` ou `sk` ao frontend. As páginas seguintes continuam na versão do cursor mesmo que outra versão se torne ativa durante a navegação.

A visão geral não calcula uma média de percentis segmentados. Quando não existe uma distribuição ou um agregado global confiável, o valor global é `null` e a medição recebe o estado `unknown`. Dados geográficos vêm de `geo_hourly`; nesse recorte, latência e perda permanecem indisponíveis enquanto a origem não as fornecer.

### 10.7 Outbox de solicitações de análise

O watermark e todos os itens de outbox exigidos pela janela são gravados na mesma transação. Cada item representa exatamente um evento e possui estado próprio. Assim, toda janela de 15 minutos cria um item `ANOMALY_DETECTION`; quando ela também conclui uma hora, a mesma transação cria outro item `QOE_FORECAST`.

```text
PK = INGESTION#OUTBOX#<YYYYMMDD>
SK = CREATED#<epochMs>#<eventType>#<eventId>
eventId = "evt_" + hash("event:" + datasetVersion + eventType + windowEnd)
idempotencyKey = "ana_" + hash("analysis:" + datasetVersion + eventType + windowEnd)
status = PENDING | PUBLISHED
```

Depois da confirmação individual da SQS, somente o item correspondente passa para `PUBLISHED`. Se a detecção for aceita e a previsão falhar, por exemplo, a previsão permanece `PENDING` e é a única republicada. Se a tarefa for interrompida depois da publicação e antes da atualização, a execução seguinte republica o mesmo `eventId` e a mesma `idempotencyKey`; o Worker trata essa repetição sem criar uma nova execução lógica.

## 11. Semântica da escrita

Para cada chunk:

1. normalizar e validar;
2. calcular chaves, `recordId` e `payloadHash`;
3. consultar chaves existentes com `BatchGetItem`, até 100 por lote;
4. separar novos, alterados e inalterados;
5. escrever novos/alterados com `BatchWriteItem`, até 25 por lote;
6. repetir `UnprocessedKeys` e `UnprocessedItems` com backoff;
7. reconciliar contagens;
8. avançar `resumeCursor`.

Uma reexecução com o mesmo conteúdo não consome escrita para itens inalterados. Uma falha após a escrita e antes do checkpoint apenas causa uma releitura idempotente.

## 12. Checkpoint e bloqueio temporário

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

- `resumeCursor`: último chunk persistido;
- `publishedWatermark`: fim da última janela inteiramente concluída;
- o dashboard usa somente watermarks publicados ou projetados;
- fatos e projeções mantêm checkpoints separados.

O bloqueio temporário, também chamado de *lease*, impede que duas tarefas atualizem a mesma fonte simultaneamente. O item contém `ownerRunId`, `leaseExpiresAt` e o instante da última renovação. A aquisição utiliza escrita condicional: ela só é aceita quando o item não existe ou quando o prazo anterior já expirou.

Existem dois níveis: um bloqueio global evita duas sincronizações completas ao mesmo tempo; um bloqueio por fonte evita que `sync`, `backfill` e `reprocess` disputem o mesmo checkpoint. A tarefa renova o prazo enquanto trabalha e só pode liberar o item se ainda for sua proprietária. Um conflito encerra a nova execução como `SKIPPED_LOCKED`, sem interromper a tarefa ativa.

O TTL remove itens antigos, mas não determina a validade do bloqueio. A decisão sempre compara `leaseExpiresAt` com o horário atual, pois a remoção por TTL não é imediata.

## 13. Retenção e limites

| Item | Retenção |
|---|---|
| fatos e projeções temporais | 30 dias desde `observedAt` |
| incidente aberto | sem TTL |
| incidente finalizado e filhos | 90 dias desde encerramento/resolução |
| runs e erros | 90 dias |
| checkpoints e health atual | sem TTL |
| lease | curto, somente para limpeza |
| golden set | sem TTL e fora da ingestão |

O limite interno por registro é 200 KB, deixando margem diante do limite físico do DynamoDB. Payload maior é dividido ou armazenado no S3 com referência canônica. A mensagem de análise não transporta esse payload.

## 14. Erros e qualidade

| Situação | Resultado |
|---|---|
| timeout/throttling | retry com backoff e jitter |
| opcional inválido | registro parcial com flag |
| obrigatório inválido | falha a fonte |
| schema drift | falha antes da leitura |
| projeção inválida | fatos permanecem |

Erros sanitizados usam:

```text
PK = INGESTION#RUN#<runId>
SK = ERROR#<sequence>
```

Não contêm payload completo, PII, segredo, DSN ou stack trace com parâmetros.

## 15. Publicação para a SQS de análise

A saída canônica grava diretamente no DynamoDB. Depois que fatos, projeções e watermark estiverem consistentes, a outbox publica uma referência para a janela na SQS de análise:

```json
{
  "eventId": "evt_...",
  "eventType": "ANOMALY_DETECTION",
  "schemaVersion": "1.0",
  "idempotencyKey": "ana_...",
  "traceId": "trc_...",
  "source": "data-ingestion-service",
  "occurredAt": "2026-08-26T18:00:00.000Z",
  "producedAt": "2026-08-26T18:16:00.000Z",
  "runId": "run_...",
  "payload": {
    "window": {
      "start": "2026-08-26T17:45:00.000Z",
      "end": "2026-08-26T18:00:00.000Z",
      "grainSeconds": 900
    },
    "inputWatermark": "2026-08-26T18:00:00.000Z",
    "datasetVersion": "dsv_..."
  }
}
```

Um item adicional e independente de outbox para `QOE_FORECAST` é criado quando a janela horária estiver completa. O contrato integral das mensagens está em [Análise de dados e diagnóstico por IA](analise-e-ia.md). O consumidor tolera mensagens duplicadas e fora de ordem. A API usa o watermark de materialização, nunca apenas o estado de publicação na fila.

## 16. Critérios de conformidade

Uma implementação está conforme quando:

- produz IDs e hashes determinísticos;
- mantém identidade ao trocar MySQL por BigQuery equivalente;
- rejeita schema drift incompatível;
- diferencia `null` de zero;
- não calcula média de percentis;
- não transforma agregado em evento individual;
- não expõe `sys_id` ao frontend;
- impede o Serviço de Ingestão de acessar `monitoracao-golden-set`;
- não depende de `Scan`;
- permite reexecução sem duplicação;
- persiste somente itens novos ou alterados;
- mantém fatos e projeções recuperáveis de forma independente;
- respeita TTL, limite de 200 KB e região `us-east-1`.

## 17. Documentos relacionados

- [Visão geral da arquitetura](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Análise de dados e diagnóstico por IA](analise-e-ia.md)
- [API do dashboard](api-dashboard.md)
- [Status de implementação](status-implementacao.md)
