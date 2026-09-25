# Ingestão e dados: ARGUS 2.0 → DynamoDB, S3 e análise

- **Status:** fonte normativa em implementação
- **Versão:** 2.2
- **Última atualização:** 17/09/2026
- **Responsáveis:** equipe de ingestão e dados
- **Região do Learner Lab:** `us-east-1`

## 1. Finalidade e fronteiras

Este documento define o contrato técnico de ingestão do ARGUS 2.0. O registro
executável da allowlist é
[`registry.json`](../../apps/backend/ingestion-data/contracts/argus/v2/registry.json):
qualquer tabela fora dele é recusada. Os dados são normalizados uma única vez,
gravados na camada quente e, quando aplicável, publicados no arquivo canônico.

O serviço em `apps/backend/ingestion-data` é **batch-only**: executa um comando
finito e termina. Não expõe rota, porta ou listener HTTP; Flask pertence somente
ao MVP histórico e não é a ingestão atual. O Backend do dashboard continua sendo
a única interface HTTP pública. A UI de importação, `ImportJob` e upload pelo
navegador são evolução futura e não descrevem a primeira operação disponível.

Na primeira prova, o operador fornece manualmente um único `SNAPSHOT`
(`argus_dump.sql.gz`, direto ou extraído de um ZIP) ao uploader, que registra a
evidência imutável em `upload-result.json`; `run_task.py` consome essa evidência
e `terraform-output.json` para iniciar a ECS task de `backfill`. O dump é a
entrada durável e versionada; o MySQL 8 é um sidecar transitório da task, com
volume efêmero. A tarefa usa dois containers: `mysql-snapshot` recebe o dump e
`ingestion` só começa após o health check do banco. Nada do MySQL é retenção de
longo prazo. A prova curta usa `--no-activate`; a ativação posterior usa uma
execução distinta com `--activate` e o override explícito
`ACTIVATE_CANDIDATE=true`. A execução ativadora recebe `clientToken` ECS
distinto e reutiliza, sem expor, o token da versão do segredo/MySQL.

Os comandos `sync` e `reprocess`, o gate dinâmico e o controle autenticado pela
interface estão implementados. O estado autoritativo é o booleano singleton
`CONTROL#ARGUS`/`LIVE_SYNC` da tabela operacional; item ausente equivale a
desligado. O caminho incremental S3 também está implementado, mas nasce com
`incremental_s3_enabled=false`; todos os Schedulers ficam `DISABLED`. Os testes
locais exercitam uma fonte MySQL compatível, porém não há conectividade viva
comprovada com o ARGUS real. A automação deve permanecer desligada até existirem
segredo, rede e evidência operacional homologados.

## 2. Comandos, modos e resultado de processo

| Comando | Finalidade | Fonte necessária |
| --- | --- | --- |
| `validate` | valida contrato e metadados; `--no-write` evita efeitos | snapshot |
| `backfill` | restaura snapshot, cria candidata, materializa, arquiva e pode ativar | snapshot |
| `sync` | lê incremento de uma origem live autorizada | live; controle implementado, prova AWS pendente |
| `reprocess` | relê período e dataset explícitos sem trocar o contrato | live; somente descriptor elegível |
| `rebuild-projections` | refaz projeções de candidata não `ACTIVE`; recusa snapshot ativo | nenhuma origem |
| `publish-outbox` | republica itens pendentes, com `--limit` opcional | SQS e outbox |
| `export-incremental` | exporta a próxima janela fechada para um lote raw imutável | live MySQL, S3 e FIFO |
| `ingest-incremental` | consome referências FIFO e incorpora os lotes ao dataset ativo | S3, FIFO e destinos operacionais |

O CLI local é invocado como `.venv/bin/python -m bootstrap <comando>`. Seus códigos são `0`
para sucesso, `1` para falha operacional ou terminal `PARTIAL`, `2` para
configuração/contrato inválido e `130` para interrupção. `validate --no-write`
é o primeiro passo seguro para um snapshot. `sync` e `reprocess` requerem
`ARGUS_SOURCE_MODE=live` e uma leitura consistente do item
`CONTROL#ARGUS`/`LIVE_SYNC` com `enabled=true`; o botão em **Configurações** ou o
endpoint autenticado altera esse estado sem republicar a task.

`reprocess` não restaura dump e, portanto, nunca usa `snapshot` como fonte. A
allowlist continua fechada e somente descriptors com janela live inequívoca —
partição `event_time` e `timestampField` — são elegíveis. Em especial,
`signal_meta` e `live_event_sde` usam `snapshot_date` e são recusados antes da
construção do reader. Correções de snapshot entram por um novo `backfill` (ou
replay idempotente da mesma evidência imutável). `rebuild-projections` só corrige
uma `datasetVersion` candidata/não `ACTIVE`; para read model ativo, a correção
exige nova versão até existir uma read generation explícita.

### 2.1 Dois fluxos independentes

O fluxo inicial não mudou: o operador envia um `.sql.gz` ou ZIP, `import-dump`
valida e promove o dump, `backfill` materializa uma candidata e uma operação
posterior e explícita pode ativá-la. Esse caminho define a linha de base e
continua sendo recuperável sem a infraestrutura incremental.

O segundo fluxo é aditivo e só opera depois de existir um manifesto `ACTIVE`:
`export-incremental` lê a próxima janela de 15 minutos já fechada de
`signal_bucket`, grava `data.parquet` e, por último, `manifest.json` versionados
sob `raw/argus/incremental/`; somente então publica a referência do manifesto na
FIFO. `ingest-incremental` relê exatamente bucket, chave e `VersionId`, valida a
evidência e incorpora os fatos ao `datasetVersion` ativo. Ele reutiliza a
identidade determinística e a outbox do sync: uma entrega repetida produz zero
fatos e zero eventos lógicos duplicados. Incrementos não criam candidata, não
trocam o manifesto ativo e não representam deletes.

O manifesto raw fechado, versão `1.0`, contém `batchId`, origem/dataset, janela
UTC `[start,end)`, `revision`, referência do Parquet (`key`, `versionId`,
`sizeBytes`, SHA-256), fingerprint e lista ordenada do schema físico, colunas
extras, contagem de linhas e versão do exportador. O `batchId` deriva desses
campos lógicos e o MVP aceita somente `revision=0`; corrigir uma janela exige
uma evolução explícita do contrato, não sobrescrever o lote existente.

Há watermarks separados: o exportador avança `export:<dataset>` por
compare-and-swap somente depois de S3 e FIFO; a ingestão avança o watermark do
dataset junto com fatos/outbox. Falhas antes do avanço deixam o lote retomável.
O estado durável do consumidor percorre `RECEIVED`, `VALIDATING`, `INGESTING`,
`COMMITTING` e `COMPLETED`, com `RETRYABLE_FAILED` e `QUARANTINED` como saídas
controladas.

A política de schema é aditiva: colunas obrigatórias ausentes ou com tipo/
nulabilidade incompatível colocam o lote em quarentena. Colunas físicas extras
são preservadas no Parquet raw e declaradas no manifesto, mas são ignoradas na
forma canônica até entrarem no registry. Nenhum payload raw é promovido por
inferência.

O Scheduler de `sync` permanece em `rate(15 minutes)`, mas o handler só fecha
janelas depois de `SYNC_FINALIZATION_DELAY_SECONDS` para absorver a
materialização tardia de agregados upstream. O default é 900 segundos; o valor
deve ser inteiro, no mínimo 900 e múltiplo de 900. Portanto, às 10:07 a maior
janela finalizável termina às 09:45, e a janela 09:45–10:00 fica pendente para
uma execução posterior.

O `state` do Scheduler é propriedade da aplicação depois da criação e é
ignorado pelo Terraform no recurso existente. `terraform apply` e
`PATCH /api/v1/integrations/argus` devem ser serializados: uma recriação do
schedule usa a seed do deploy e pode divergir transitoriamente até o próximo
`PATCH`; o gate DynamoDB continua sendo a autoridade que permite ou bloqueia a
leitura live.

As variáveis de runtime relevantes são `INGESTION_ENVIRONMENT`, `AWS_REGION`,
`OPERATIONAL_TABLE_NAME`, `SNAPSHOT_BUCKET`, `SNAPSHOT_OBJECT_KEY`,
`SNAPSHOT_OBJECT_VERSION_ID`, `SNAPSHOT_SHA256`, `MYSQL_*`,
`ARCHIVE_BUCKET`, `GLUE_DATABASE`, `ATHENA_WORKGROUP`,
`ATHENA_OUTPUT_LOCATION`, `ANALYSIS_QUEUE_URL` e
`SYNC_FINALIZATION_DELAY_SECONDS`. O caminho S3 acrescenta
`INCREMENTAL_BATCH_BUCKET`, `INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER`, o prefixo
fixo `INCREMENTAL_BATCH_PREFIX=raw/argus/incremental/`,
`INCREMENTAL_BATCH_QUEUE_URL` e `INCREMENTAL_INGEST_LIMIT`; somente o exportador
recebe os cinco campos `LIVE_MYSQL_*`. Senhas e tokens vêm do
Secrets Manager ou do ambiente da task e nunca entram em argumentos, logs ou
documentação de exemplo.

## 3. Contrato físico ARGUS 2.0

`physicalContractVersion` é **`2.0`** e `canonicalSchemaVersion` é **`1.0`**.
Cada descriptor fecha colunas, tipos MySQL, chave natural, cursor, timestamp,
granularidade, retenção, política de cobertura e partição. Coluna obrigatória,
tipo ou chave incompatível falha fechada; não há fallback permissivo.

As 23 tabelas abaixo são a allowlist completa. `*` identifica as seis adições
da versão 2.0; `live_event` deixa de ser reservado e passa a ser dataset
operacional.

| Dataset | Tipo canônico | Grão | Chave natural | Cobertura/partição |
| --- | --- | --- | --- | --- |
| `signal_bucket` | `SignalObservation` | 15 min | `source + entity + metric + bts` | snapshot / tempo do evento |
| `live_active_15min` | `DimensionalMetricAggregate` | 15 min | `bucket_ts + sinal` | atraso upstream / tempo do evento |
| `live_qoe_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + sinal` | atraso upstream / tempo do evento |
| `player_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + player` | atraso upstream / tempo do evento |
| `device_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + device` | atraso upstream / tempo do evento |
| `geo_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + state_province + isp` | atraso upstream / tempo do evento |
| `live_error_attr_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + sinal + cdn + tier + http_code + error_name` | atraso upstream / tempo do evento |
| `error_cat_hourly` | `DimensionalMetricAggregate` | 1 h | `hour_ts + kind + category` | atraso upstream / tempo do evento |
| `incidents` | `Incident` | evento | `opened_at + sys_id` | ground truth de 90 d / tempo do evento |
| `signal_meta` | `UpstreamSourceHealth` | snapshot | `source` | saúde da fonte / data do snapshot |
| `collector_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `apollo_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `ca_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `nr_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `prom_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `rpaas_run` | `UpstreamCollectorRun` | execução | `run_id` | auditoria / tempo do evento |
| `app_error`* | `ApplicationErrorAggregate` | 1 h | `timestamp + error_code + manufacturer` | fonte limitada / tempo do evento |
| `app_error_model`* | `ApplicationErrorAggregate` | 1 d | `day_ts + error_code + manufacturer + model` | fonte limitada / tempo do evento |
| `app_error_version`* | `ApplicationErrorAggregate` | 1 d | `day_ts + error_code + app_version` | fonte limitada / tempo do evento |
| `cdn_vod_shadow`* | `ShadowObservation` | evento | `ts + entity` | experimento encerrado / tempo do evento |
| `finding_status_log`* | `FindingStatusTransition` | evento | `finding_id + ts` | rótulo derivado, não golden set / tempo do evento |
| `live_event_sde`* | `LiveEventContext` | contexto | `sde_id` | editorial / data do snapshot |
| `live_event` | `LiveEventContext` | evento | `tid + start_ts` | editorial / tempo do evento |

O campo físico `errors_bot` de `error_cat_hourly` é normalizado em
`errorsBot`. `humanErrors = errors - errorsBot` só existe quando a primeira
janela com bot confiável foi observada. Como a origem usava zero como default
antes dessa fronteira, `humanErrors` é `null` quando a cobertura é ambígua; zero
nunca significa que todos os erros foram humanos por inferência.

`cdn_vod_shadow` preserva a condição de experimento encerrado e cobertura
limitada. `finding_status_log` é contexto derivado e explicitamente não é
elegível ao conjunto de referência. Os dois datasets editoriais mantêm os campos
estruturados de evento; JSON de origem inválido gera flag de qualidade, não
payload bruto em log.

## 4. Normalização, JSON e identidades

Um registro canônico contém `schemaVersion`, `recordType`, `sourceSystem`,
`sourceDataset`, `naturalKey`, `observedAt`, `window`, `dimensions`,
`measures`, `quality` e `qualityFlags`. O JSON usado em hashes é UTF-8
compacto, chaves ordenadas, sem `NaN`/infinito; `Decimal` é representado sem
perda e timestamps usam UTC com milissegundos. Não se hash serialização
incidental de runtime.

```text
datasetVersion = "dsv_" + SHA-256(JSON canônico({
  sourceSystem, dumpSha256, physicalContractVersion, canonicalSchemaVersion
}))

recordId = "rid_" + SHA-256(JSON canônico({
  schemaVersion, recordType, sourceSystem, sourceDataset, naturalKey
}))

payloadHash = "ph_" + SHA-256(JSON canônico(identidade +
  observedAt + window + dimensions + measures + quality + qualityFlags))
```

Assim, `recordId` identifica o fato lógico independentemente da execução e
`payloadHash` identifica seu conteúdo. `datasetVersion` não deriva de
identificador de importação: deriva exclusivamente da fonte lógica, checksum do
dump e versões física/canônica. Uma reexecução do mesmo objeto S3 gera a mesma
versão e não duplica fatos, Parquet nem eventos lógicos.

## 5. Camada quente, controle e ativação

`g05-s3-operacional` mantém fatos e projeções de baixa latência por até 30
dias, isolados por `datasetVersion`. A família de chave é determinada pelo tipo:
`FACT#TS`, `INCIDENT#TS`, `CONTEXT#TS` ou `INGESTION#SOURCE`. Um fato
temporal é codificado como:

```text
PK = DATASET#<datasetVersion>#<family>#<dataset>#<YYYYMMDD>
SK = TS#<epochMs>#<rid_sha256>
```

O serviço evita `Scan`: hot records, `HOTPART`, catálogo de partições,
checkpoints, leases, runs, manifestos e projeções são lidos por `Query` ou
acesso direto. `HOTPART` guarda a partição quente e o resumo alvo necessários
para expiração segura. Partições de archive são persistidas por dataset e
partição; somente `AVAILABLE` autoriza TTL da cópia quente.

Há manifesto candidato e manifesto ativo. O candidato registra contrato físico,
schema canônico, checksum do dump, `availableIntervals`, `hotFrom`, watermarks,
prefixos S3, tabelas Glue, versões de descriptor/fórmula/projeção, cobertura,
flags de qualidade e validações. Consultas devem reportar os intervalos reais
presentes no manifesto e suas capabilities: **12 meses é meta de retenção**, não
garantia de que o snapshot atual disponibilize esse período.

A máquina de execução é literal:

```text
STARTING → RESTORING → VALIDATING → INGESTING → PROJECTING
→ ARCHIVING → ACTIVATING → PUBLISHING → SUCCEEDED | PARTIAL
```

Uma falha antes de `ACTIVATING` termina em `FAILED` e conserva o manifesto
ativo anterior. `SKIPPED_LOCKED` é terminal fora do caminho normal quando outro
lease ainda é válido. A ativação faz compare-and-swap do manifesto depois das
validações. Falha posterior na publicação SQS não desfaz o ativo: termina em
`PARTIAL`, mantém os itens pendentes e é recuperada por `publish-outbox`.

## 6. S3, Parquet, Glue e Athena

O bucket guarda `raw/argus/incremental/`, `dumps/`, `staging/`, `canonical/` e
`athena-results/` com versionamento, criptografia e bloqueio público. O raw
incremental tem retenção configurável de 90 dias por padrão, inclusive para
versões não correntes e órfãos; seus prefixos não se sobrepõem aos artefatos da
carga inicial nem ao canônico. O objeto canônico é imutável:

```text
staging/run_id=<runId>/dataset=<dataset>/date=<YYYY-MM-DD>/<sha256>.parquet
canonical/schema_version=1.0/dataset_version=<datasetVersion>/
  dataset=<dataset>/year=<YYYY>/month=<MM>/day=<DD>/part-<sha256>.parquet
```

Datasets particionados por snapshot usam `snapshot_date=<YYYY-MM-DD>` no lugar
da hierarquia por data de evento. O runtime cria uma tabela Glue por dataset,
registra a partição e consulta a tabela no Athena. A passagem de estado é
`STAGING → UPLOADED → CATALOGED → VALIDATED → AVAILABLE`; a validação compara a
contagem Athena à contagem Parquet e confere checksum/schema. Terraform possui
o bucket, database e workgroup; o runtime possui tabelas e partições. O
workgroup restringe resultado a `athena-results/` e aplica o cutoff configurado.

A política lógica `canonical_months=12` pode conservar canônico por até 12
meses, mas o contrato de consulta é o `availableIntervals`, não uma duração
presumida. A deleção física automática de `canonical/`, inclusive de versões não
correntes, está deliberadamente desabilitada (fail-closed): excluir objetos sem
reconciliar Glue e o manifesto deixaria metadados apontando para dados ausentes.
Produção só pode automatizá-la quando houver um reconciliador explícito desses
três estados. Dumps, staging e resultados possuem retenções próprias e não são
substitutos do arquivo canônico.

## 7. Outbox e fila de análise

Ao fechar uma janela, a mesma transação persiste watermark e zero, um ou dois
eventos de outbox: `ANOMALY_DETECTION` para janela de 900 s e
`QOE_FORECAST` para janela de 3600 s quando cabível. `eventId` (`evt_...`) e
`idempotencyKey` (`ana_...`) são determinísticos por versão, tipo e fim da
janela. O publisher consulta apenas itens `PENDING` pelo GSI esparso
`outbox-pending-index`, envia para SQS Standard e só então marca `PUBLISHED`.

Entrega é at-least-once. O consumidor deve ser idempotente e tratar duplicatas;
mensagem poison falha fechada, vai à DLQ após o limite configurado e é replayada
com a mesma identidade, nunca reconstruída de forma livre. A fila principal e
as duas DLQs (análise e Scheduler) têm retenção de **14 dias**. Falha de SQS não
apaga watermark, candidata nem arquivo; torna o run `PARTIAL` após ativação.

O Worker de Análise não faz parte desta entrega. Ele recebe referência à janela
materializada, não dump nem registros brutos do ARGUS.

## 8. Perfis de infraestrutura e operação segura

| Aspecto | Learner Lab | Produção moldável |
| --- | --- | --- |
| Rede | `us-east-1`, subnets públicas e IP público quando o lab exige | subnets privadas e sem IP público |
| IAM | `LabRole` é concessão temporária do lab e deve já conter as permissões requeridas; o Academy bloqueia policy adicional | task role explícita da API; Terraform anexa policy mínima para tabela, schedule e `PassRole` condicionado |
| Imagens | digest ECR e MySQL por digest | digests aprovados |
| Bucket S3 | compatibilidade IaC evita a leitura de Object Lock negada pela SCP; configurações seguem em recursos AWS separados | `aws_s3_bucket` nativo e moldável |
| Destruição | bucket e objetos são preservados pelo modo compatível | sem destruição forçada |
| Agenda live | criada desligada | decisão explícita após teste live |

Antes de `apply`, confirme `aws sts get-caller-identity`, região, workspace e
state correto. Não aplique com state vazio/desconhecido. Use
`terraform output ingestion_runbook` para obter nomes e ARNs sem imprimir
segredos; os procedimentos completos estão no
[runbook do serviço](../../apps/backend/ingestion-data/README.md) e na
[documentação fullstack](../../apps/fullstack/documentation/infraestrutura-integracao.md).

## 9. Observabilidade e segurança

Logs JSON da ingestão usam `service_name=g05-s3-ingestion`, `traceId`,
`runId`, `command`, estado, contagens, dataset e versão quando existirem. O
redator remove campos com formato de segredo, payload bruto, senha, token e
conexão. As métricas EMF incluem `Runs`, `RunDurationMs`, `RecordsRead`,
`RecordsWritten`, `RecordsRejected` e `RecordsUnchanged`, com dimensões
controladas de comando, status, modo e dataset allowlisted.

CloudWatch mantém log groups separados para backfill, sync, export incremental e
ingest incremental. O dashboard limita as dimensões incrementais a `command`,
`status` e dataset allowlisted, nunca `batchId`, e acompanha lotes, lag,
colunas extras e quarentena. Alarmes cobrem backlog e idade da FIFO, DLQ não
vazia, quarentena e watermark atrasado, além de falha, schema drift, idade da
outbox e erro do target Scheduler. A ausência de sync só é alarmável quando a
agenda estiver habilitada. O serviço não lê nem escreve `g05-s3-golden-set`.

## 10. Critérios de conformidade

- o registry contém exatamente 23 datasets e contrato físico `2.0`;
- todos os itens persistidos e objetos canônicos carregam a versão determinística;
- TTL quente só é elegível após archive `AVAILABLE` e reconciliação Athena;
- uma reexecução do mesmo snapshot é idempotente;
- nenhum dump inválido troca o manifesto ativo;
- o controle live está implementado, mas permanece desligado até prova de conectividade e operação na AWS;
- o fluxo inicial `.sql.gz`/ZIP continua independente e requer ativação explícita;
- incrementos adicionam ao dataset ativo, usam `revision=0` e não aplicam deletes;
- export e ingest incrementais continuam desabilitados até homologação ARGUS externa;
- capabilities e API expõem cobertura real do manifesto, não uma promessa de duração.

## 11. Documentos relacionados

- [Visão geral](visao-geral.md)
- [Fluxos integrados](fluxos.md)
- [Análise e IA](analise-e-ia.md)
- [API do dashboard](api-dashboard.md)
- [Modelagem da Sprint 3](../sprint3/modelagem.md)
- [Runbook de ingestão](../../apps/backend/ingestion-data/README.md)
