# Arquitetura e projeções do Data Ingestion Service

Status: aprovado para planejamento de implementação  
Versão: 1.0  
Data: 2026-08-27  
Região AWS: `us-east-1`

## 1. Objetivo

Este documento define a arquitetura da aplicação que executará o contrato
[Argus → DynamoDB](../contratos/argus-dynamodb-ingestion-contract.md), incluindo
componentes, casos de uso, fluxo operacional, projeções, AWS, observabilidade,
segurança e rollout.

O histórico consolidado está no
[Design completo da ingestão](../../docs/superpowers/specs/2026-08-27-argus-dynamodb-ingestion-contract-design.md).

## 2. Decisão principal

A primeira versão é um monólito modular Python com DDD leve e arquitetura
hexagonal.

```text
Argus/MySQL
  → source adapter
  → domínio canônico
  → casos de uso
  → DynamoDB direto
  → projeções
  → backend API
  → frontend
```

O Data Ingestion Service não é uma API HTTP nesta fase. Sua interface
operacional é composta por comandos executados como ECS tasks. O backend HTTP
existente lê os read models produzidos pela ingestão.

Isso elimina ALB, porta pública e processo permanentemente ocioso para um job
que só precisa executar periodicamente.

## 3. Objetivos arquiteturais

- trocar MySQL por BigQuery sem alterar o domínio;
- manter backfill e sync no mesmo código;
- retomar uma execução interrompida;
- isolar falha por fonte;
- impedir execução concorrente da mesma fonte;
- gravar fatos auditáveis e projeções eficientes;
- suportar dados parciais sem inventar métricas;
- adicionar SQS/DLQ futuramente sem substituir contratos canônicos;
- operar exclusivamente em `us-east-1`;
- impedir acesso do worker ao golden set.

## 4. Estrutura do código

```text
apps/backend/ingestion-data/
├── domain/
│   ├── models/
│   ├── value_objects/
│   ├── contracts/
│   └── services/
├── application/
│   ├── backfill/
│   ├── sync/
│   ├── reprocess/
│   └── projections/
├── ports/
│   ├── source_reader.py
│   ├── record_sink.py
│   ├── projection_repository.py
│   ├── checkpoint_repository.py
│   ├── lease_repository.py
│   └── observability.py
├── adapters/
│   ├── sources/
│   │   └── argus_mysql/
│   └── sinks/
│       └── dynamodb/
└── bootstrap/
    ├── cli.py
    ├── config.py
    └── container.py
```

Cada módulo possui responsabilidade única. Casos de uso dependem de portas;
adapters dependem dos contratos definidos pelas portas.

## 5. Portas

### `SourceReader`

Oferece paginação por chave natural, introspecção de schema e intervalo
disponível. Implementações iniciais: snapshot MySQL e banco vivo MySQL.

### `CanonicalRecordSink`

Recebe contratos canônicos. Implementação v1: DynamoDB direto. Implementação
futura: publisher SQS.

### `ProjectionRepository`

Lê fatos por partição e grava read models versionados.

### `CheckpointRepository`

Controla cursor retomável, watermark publicado e watermark das projeções.

### `LeaseRepository`

Adquire, renova e libera locks temporários usando escrita condicional.

### `RunRepository` e `MetricsPublisher`

Persistem execução, erros sanitizados, contagens e métricas operacionais.

## 6. Comandos

```text
validate
backfill
sync
reprocess
rebuild-projections
```

### `validate`

Valida configuração, região, IAM, segredo, conexão, schemas, DynamoDB, TTL,
PITR e versões sem escrever fatos.

### `backfill`

Processa uma janela histórica do MySQL restaurado, com paginação por chave e
checkpoint por chunk.

### `sync`

Relê o intervalo entre watermark, lookback e safety delay. É o comando padrão
da task agendada.

### `reprocess`

Relê uma fonte e janela explícitas após correção de dado ou adapter.

### `rebuild-projections`

Reconstrói read models usando fatos já persistidos, sem acessar o Argus.

## 7. Fluxo de execução

```text
adquirir lease global
  → validar ambiente
  → para cada fonte habilitada
      → adquirir lease da fonte
      → validar schema físico
      → calcular janela
      → ler páginas por chave
      → normalizar
      → comparar payloadHash
      → persistir novos/alterados
      → reconciliar contagens
      → publicar watermark da fonte
      → liberar lease da fonte
  → recalcular projeções afetadas
  → publicar watermarks das projeções
  → finalizar run
  → liberar lease global
```

Falha em uma fonte não desfaz outra fonte já concluída. O run final fica
`PARTIAL` quando há sucesso e falha na mesma execução.

## 8. Backfill

O dump de 11 GB é restaurado em MySQL 8/Percona. Não é colocado na imagem
Docker nem analisado diretamente pelo Python.

Paginação de `signal_bucket`:

```sql
WHERE bts > :last_bts
   OR (bts = :last_bts
       AND (source, entity, metric) > (:source, :entity, :metric))
ORDER BY bts, source, entity, metric
LIMIT :chunk_size
```

`OFFSET` é proibido porque degrada com o crescimento da tabela e não oferece
retomada estável.

O backfill pode rodar:

- no ECS, quando o MySQL restaurado estiver acessível pela VPC;
- localmente, quando o snapshot existir apenas na máquina de desenvolvimento.

A imagem e os contratos são os mesmos nos dois casos.

## 9. Sincronização

Executada a cada 15 minutos:

```text
start = publishedWatermark - lookback
end   = now - safetyDelay
```

Lookbacks:

- `signal_bucket`: 24 horas;
- NPAW/Youbora: 48 horas;
- incidentes: novos + todos os não finalizados;
- metadados de saúde: leitura completa.

O lookback absorve correções tardias. Idempotência impede duplicação e
`payloadHash` evita reescrita desnecessária.

## 10. Checkpoints

Existem três marcos conceituais:

```text
source checkpoint      fatos lidos e publicados
materialized watermark fatos disponíveis no DynamoDB
projection checkpoint  read models reconstruídos
```

Na escrita direta, source e materialização terminam juntos. Quando SQS for
adicionado, eles se tornam etapas separadas.

`resumeCursor` avança por chunk. `publishedWatermark` só avança após a janela
completa. A API nunca usa um cursor intermediário como prova de frescor.

## 11. Lease

Lease é um lock distribuído com prazo.

```json
{
  "pk": "INGESTION#SOURCE#signal_bucket",
  "sk": "LEASE",
  "ownerRunId": "run_123",
  "acquiredAt": "2026-08-26T10:00:00Z",
  "leaseExpiresAt": "2026-08-26T10:20:00Z"
}
```

Aquisição:

```text
criar se não existe
ou substituir se leaseExpiresAt passou
```

A task renova o lease durante o trabalho. Se travar, outra task assume após a
expiração. TTL apenas limpa o item; a regra de lock compara `leaseExpiresAt`.

Dois níveis:

- global, para duas sincronizações completas não coincidirem;
- por fonte, para sync, backfill e reprocessamento não disputarem os mesmos
  checkpoints.

Conflito termina como `SKIPPED_LOCKED`.

## 12. Organização do DynamoDB

O contrato detalhado de chaves está no documento de ingestão. A organização
lógica é:

| Família | Exemplo de `pk` | Uso |
|---|---|---|
| fato temporal | `FACT#TS#seriesId#dia` | auditoria e reconstrução |
| incidente | `INCIDENT#incidentId` | detalhe e filhos |
| projeção | `VIEW#OVERVIEW#slice#dia` | consulta rápida da API |
| fonte | `INGESTION#SOURCE#source` | checkpoint, health e lease |
| run | `INGESTION#RUN#runId` | execução e erros |

Essa é uma single-table design: uma tabela física, várias famílias lógicas.
Read models duplicam somente o necessário para eliminar `Scan` e joins em
tempo de request.

## 13. Pipeline de projeções

```text
fatos canônicos
  → selecionar buckets afetados
  → carregar inputs por Query
  → aplicar fórmula versionada
  → calcular medição, qualidade e cobertura
  → comparar payloadHash
  → persistir projeção
  → avançar projection checkpoint
```

Uma falha de projeção não remove fatos nem retrocede o checkpoint da fonte.

Cada projeção registra:

- `projectionVersion`;
- `formulaVersion`;
- datasets usados;
- watermarks de entrada;
- `observedThrough`;
- cobertura;
- qualidade e flags.

## 14. Projeção de Visão Geral

| Métrica | Fonte | Fórmula |
|---|---|---|
| erros/min global | `error_cat_hourly` | soma das categorias disjuntas ÷ 60 |
| erros/min por canal | `live_qoe_hourly` | `errors ÷ 60` |
| latência p95 por canal | `live_active_15min`/`live_qoe_hourly` | valor da origem |
| sessões afetadas | `live_active_15min` | `active_with_error` |
| sessões observadas | `live_active_15min` | `active_sessions` |
| participação afetada | `live_active_15min` | afetadas ÷ observadas |

Não existe score composto de saúde no v1. O gráfico apresenta uma métrica real.
P95 global fica `unknown` sem agregado global; média de p95 é proibida.

Chaves:

```text
PK = VIEW#OVERVIEW#<sliceId>#<YYYYMMDD>
SK = T#<epochMs>
```

## 15. Projeção de incidentes

Detalhe:

```text
PK = INCIDENT#<incidentId>
```

Listagem temporal:

```text
PK = VIEW#INCIDENTS#DAY#<YYYYMMDD>
```

Incidentes ativos:

```text
PK = VIEW#INCIDENTS#ACTIVE
```

Campos ServiceNow são medidos. Impacto sem vínculo explícito é `unknown`.
Correlação temporal isolada não gera evidência ou hipótese. O worker v1 não
faz diagnóstico causal.

## 16. Projeção de monitoramento

Fontes:

- runs do próprio worker;
- checkpoints;
- `signal_meta`;
- `collector_run` e runs legados.

Métricas:

| Métrica | Fórmula |
|---|---|
| leitura/min | `recordsRead / minutos` |
| escrita/min | `recordsWritten / minutos` |
| atualizados | hash anterior diferente |
| inalterados | hash anterior igual |
| rejeitados | violações de contrato |
| processamento p95 | p95 da duração dos chunks |
| source lag | último dado observado ajustado ao SLA |
| cobertura | buckets válidos ÷ esperados |

Fila e DLQ são `null/unknown` no v1.

```text
PK = VIEW#MONITORING#<source>#<YYYYMMDD>
```

## 17. Projeção geográfica

Origem: `geo_hourly`.

```text
affectedSessions = errors
observedSessions = sessions
errorSessionRatio = errors / sessions
```

Dimensões: estado, ISP e região derivada por catálogo versionado. Latência e
perda geográficas ficam indisponíveis porque não existem na fonte.

```text
PK = VIEW#GEOGRAPHY#<metric>#<YYYYMMDD>
```

## 18. Capabilities dos dados

Slices suportados:

- global;
- canal;
- player;
- modelo de dispositivo;
- estado;
- estado + ISP;
- tipo de conteúdo;
- categoria de erro;
- canal + CDN + tier + HTTP code.

Indisponíveis inicialmente:

- `appVersion`;
- combinações arbitrárias entre dimensões;
- `deviceType` sem catálogo de modelos;
- latência por estado;
- eventos individuais;
- fila e DLQ.

A API usa essas capacidades para desabilitar filtros ou apresentar estados
indisponíveis, sem mocks em produção.

## 19. Erros

Estados de run:

```text
SUCCEEDED
PARTIAL
FAILED
SKIPPED_LOCKED
```

Transitórios recebem até cinco tentativas com backoff exponencial e jitter.
Schema drift, configuração e autorização não recebem retry automático.

Falha obrigatória interrompe somente a fonte e não publica seu watermark.
Falha de projeção preserva fatos. Erros sanitizados são agrupados por
fingerprint e retidos por 90 dias.

## 20. Segurança

Task role de menor privilégio:

- leitura do segredo da origem;
- `GetItem`, `BatchGetItem`, `PutItem`, `UpdateItem`, `BatchWriteItem`, `Query`
  e `TransactWriteItems` em `monitoracao-operacional`;
- logs e métricas necessários.

Negado por construção:

- `monitoracao-golden-set`;
- alteração de infraestrutura;
- exclusão de tabelas;
- secrets de outros serviços;
- `Scan` operacional amplo.

A aplicação rejeita região diferente de `us-east-1` e configuração que aponta
para o golden set.

## 21. Preparação para SQS e DLQ

Hoje:

```text
CanonicalRecordSink → DynamoDirectSink
```

Futuro:

```text
CanonicalRecordSink
  → SqsPublisher
  → SQS Standard
  → DynamoConsumer
  → DynamoDB
          ↘ DLQ
```

IDs determinísticos garantem idempotência. O consumidor não depende de ordem e
o replay preserva `eventId`. O limite de 200 KB mantém os registros compatíveis
com mensagens SQS.

Adicionar a fila cria consumidor e métricas novas, mas não altera readers,
domínio, contratos canônicos, IDs ou projeções.

## 22. AWS

Recursos reutilizados em `us-east-1`:

- ECR `data-ingestion-service`;
- ECS cluster `data-ingestion-cluster`;
- task family `data-ingestion-task`;
- DynamoDB `monitoracao-operacional`.

Topologia:

```text
EventBridge Scheduler a cada 15 minutos
  → ECS RunTask com comando sync
      → execução
      → encerramento
```

A task batch não possui porta HTTP, ALB ou health check HTTP. Backfill e
reprocessamento usam command override.

Configuração inicial:

```text
1 vCPU
2 GB de memória
subnets privadas
sem entrada pública
CloudWatch /ecs/data-ingestion com retenção de 90 dias
```

O Scheduler usa flexible time window desabilitada e role restrita a
`ecs:RunTask` e `iam:PassRole`. Imagens usam tag imutável de commit e scan no
ECR.

## 23. Observabilidade

Logs JSON carregam `runId`, source, stage, duração, contagens e watermark.

Alarmes:

- nenhuma execução bem-sucedida em 30 minutos;
- fonte além do SLA;
- run `FAILED`;
- schema drift;
- projeção atrasada;
- lease sem renovação.

Métricas de SQS/DLQ não são publicadas enquanto a fila não existir.

## 24. Testes

- unitários para IDs, tempo, Decimal, TTL, hashes e qualidade;
- contrato de cada source adapter;
- integração MySQL 8 → aplicação → DynamoDB Local;
- backfill duplicado;
- interrupção e retomada;
- correção tardia dentro do lookback;
- fonte e projeção com falha;
- disputa de lease;
- reconciliação por fonte e janela;
- teste IAM provando que o golden set é inacessível.

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

O ECS Service e o ALB placeholders permanecem durante a validação. Sua remoção
ou redução para zero exige autorização explícita. Rollback significa pausar o
Scheduler, corrigir e reprocessar, sem exclusão destrutiva.

## 26. Entrada para o desenvolvimento

A próxima sessão deve usar este documento e o contrato de ingestão como fonte
normativa para criar o plano de implementação com Superpowers. A ordem esperada
é:

1. domínio e contratos;
2. testes de contrato;
3. reader MySQL;
4. repositórios DynamoDB;
5. backfill e checkpoints;
6. sync e leases;
7. projeções;
8. container e CLI;
9. ECS/Scheduler/observabilidade;
10. rollout controlado.
