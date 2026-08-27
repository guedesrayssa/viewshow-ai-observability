# Contrato de ingestão Argus → DynamoDB

Status: aprovado para implementação  
Versão: 1.0  
Data: 2026-08-27  
Região AWS: `us-east-1`

## 1. Finalidade

Este documento é o contrato normativo de dados da ingestão. Ele define:

- quais dados entram a partir do Argus;
- como os registros físicos são validados;
- como são transformados em registros canônicos;
- como identidades, timestamps, números e qualidade são representados;
- como os registros são persistidos em `monitoracao-operacional`;
- como idempotência, retenção, checkpoints e evolução de schema funcionam.

A arquitetura e as projeções derivadas estão em
[Arquitetura do Data Ingestion Service](../arquitetura/data-ingestion-service-architecture.md).
O histórico consolidado das decisões está em
[Design completo da ingestão](../../docs/superpowers/specs/2026-08-27-argus-dynamodb-ingestion-contract-design.md).

## 2. Fronteiras do contrato

```text
Argus físico
  → adapter da origem
  → contrato canônico
  → adapter de persistência
  → monitoracao-operacional
```

Este contrato não define DTOs HTTP do dashboard. A API transforma os read
models do DynamoDB em seu contrato público sem expor `pk`, `sk`, TTL,
checkpoints ou identificadores físicos da origem.

O worker não lê nem escreve `monitoracao-golden-set`.

## 3. Perfil da entrada

### 3.1 Origem inicial

- Motor: MySQL 8.0/Percona 8.0.
- Collation esperada: `utf8mb4_bin`.
- Timestamps: predominantemente epoch em milissegundos UTC.
- Snapshot: dump restaurado em MySQL, nunca interpretado diretamente pelo
  worker Python.
- Operação contínua: conexão ao banco vivo do Argus quando ela estiver
  disponível.

Perfis suportados:

```text
ARGUS_SOURCE_MODE=snapshot
ARGUS_SOURCE_MODE=live
```

Ambos implementam o mesmo `SourceReader`. Host, porta, banco e credenciais são
fornecidos por segredo de ambiente.

### 3.2 Evolução da origem

Um futuro `ArgusBigQueryReader` pode substituir o reader MySQL. O mecanismo de
leitura é registrado em `ingestion.readerAdapter`, mas não participa da
identidade do fato.

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

`source`, `entity` e `metric` são case-sensitive. A unidade é resolvida pela
combinação `source + metric`, nunca somente por `metric`.

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

`active_with_error` representa sessões concorrentes com erro, não usuários
únicos durante a janela.

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

Chave natural: `hour_ts + player`.  
Dimensão: `player`.  
Medidas: `sessions`, `errors`.

### 5.5 `device_hourly`

Chave natural: `hour_ts + device`.  
Dimensão: `device`, preservada no formato original `vendor|model`.  
Medidas: `sessions`, `errors`.

O contrato não converte automaticamente modelo em `deviceType`. Essa conversão
exige catálogo versionado.

### 5.6 `geo_hourly`

Chave natural:

```text
hour_ts + state_province + isp
```

Dimensões: `state`, `isp` e `region` derivada por catálogo UF → região
versionado. Medidas: `sessions`, `errors`.

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

`top_names` é JSON de origem. Parse inválido gera
`quality.flags = ["INVALID_SOURCE_JSON"]`, mas não invalida `errors`. O payload
bruto não é persistido e a lista normalizada é limitada.

### 5.9 `incidents`

Chave física: `opened_at + sys_id`.  
Identidade semântica: `servicenow + sys_id`.

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

`signal_meta` fornece watermark e contagens por fonte. `collector_run` e as
tabelas legadas fornecem início, fim, janela, duração e quantidades.

O adapter normaliza a diferença entre epoch ms de `collector_run` e timestamps
ISO textuais das tabelas legadas.

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

`null` significa indisponível ou não medido. Zero significa medido sem
ocorrência.

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

`payloadHash` inclui payload, janela, medição e qualidade. Não inclui `runId`,
`ingestedAt` ou `readerAdapter`.

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
monitoracao-golden-set   curadoria humana/ML; inacessível ao worker
```

`monitoracao-operacional` usa `pk`, `sk`, modo `PAY_PER_REQUEST`, TTL no
atributo `ttl` e GSI esparso `trace-index`.

### 10.2 Fatos temporais

```text
PK = FACT#TS#<seriesId>#<YYYYMMDD>
SK = T#<epochMs>#<recordId>
```

`seriesId` é o hash de dataset, fonte, entidade, métrica e dimensões ordenadas.
Os valores originais permanecem como atributos.

Exemplo:

```json
{
  "pk": "FACT#TS#4e98a1...#20260826",
  "sk": "T#1787788800000#rec_a23...",
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
PK = INCIDENT#<incidentId>  SK = META
PK = INCIDENT#<incidentId>  SK = EVIDENCE#<evidenceId>
PK = INCIDENT#<incidentId>  SK = HYPOTHESIS#<hypothesisId>
PK = INCIDENT#<incidentId>  SK = TIMELINE#<timestamp>#<itemId>
```

O worker v1 grava apenas `META`. Outros casos de uso autorizados podem gravar
evidências, hipóteses e timeline na mesma partição.

Índices de listagem:

```text
PK = VIEW#INCIDENTS#DAY#<YYYYMMDD>
SK = OPENED#<epochMs>#<incidentId>

PK = VIEW#INCIDENTS#ACTIVE
SK = PRIORITY#<priority>#STARTED#<epochMs>#<incidentId>
```

### 10.4 Controle

```text
PK = INGESTION#SOURCE#<source>  SK = CHECKPOINT
PK = INGESTION#SOURCE#<source>  SK = HEALTH
PK = INGESTION#SOURCE#<source>  SK = LEASE

PK = INGESTION#RUN#<runId>      SK = META
PK = INGESTION#RUN#<runId>      SK = ERROR#<sequence>
```

### 10.5 Tipos DynamoDB

- timestamps de negócio: string ISO UTC;
- timestamps usados em ordenação: epoch ms incorporado na `sk`;
- TTL: epoch em segundos no atributo `ttl`;
- números: DynamoDB Number produzido a partir de `Decimal`;
- booleanos: DynamoDB Boolean;
- campos indisponíveis: `NULL` quando semanticamente necessário;
- mapas e listas: limitados e validados;
- floats especiais: proibidos.

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

Uma reexecução com o mesmo conteúdo não consome escrita para itens inalterados.
Uma falha após a escrita e antes do checkpoint apenas causa uma releitura
idempotente.

## 12. Checkpoint

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

## 13. Retenção e limites

| Item | Retenção |
|---|---|
| fatos e projeções temporais | 30 dias desde `observedAt` |
| incidente aberto | sem TTL |
| incidente finalizado e filhos | 90 dias desde encerramento/resolução |
| runs e erros | 90 dias |
| checkpoints e health atual | sem TTL |
| lease | curto, somente para limpeza |
| golden set | sem TTL e fora do worker |

O limite interno por registro é 200 KB. Esse limite cabe no SQS futuro, cujo
limite de mensagem é 256 KB, e deixa margem diante dos 400 KB do DynamoDB.
Payload maior é dividido ou armazenado no S3 com referência canônica.

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

## 15. Compatibilidade futura com SQS

A saída canônica é uma porta. Hoje ela grava diretamente no DynamoDB. No
futuro, pode publicar:

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

O consumidor tolera mensagens duplicadas e fora de ordem. Replay da DLQ
preserva `eventId`. A API usa o watermark de materialização, nunca apenas o de
publicação na fila.

## 16. Critérios de conformidade

Uma implementação está conforme quando:

- produz IDs e hashes determinísticos;
- mantém identidade ao trocar MySQL por BigQuery equivalente;
- rejeita schema drift incompatível;
- diferencia `null` de zero;
- não calcula média de percentis;
- não transforma agregado em evento individual;
- não expõe `sys_id` ao frontend;
- não acessa `monitoracao-golden-set`;
- não depende de `Scan`;
- permite reexecução sem duplicação;
- persiste somente itens novos ou alterados;
- mantém fatos e projeções recuperáveis de forma independente;
- respeita TTL, limite de 200 KB e região `us-east-1`.
