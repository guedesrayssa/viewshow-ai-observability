# Importação ARGUS — fase 2: S3 canônico antes do DynamoDB

> **Para quem executar — REQUIRED SUB-SKILL:** conclua primeiro `2026-09-20-argus-import-phase-1-mysql-resilience.md`. Use `superpowers:executing-plans` tarefa a tarefa, `superpowers:test-driven-development` em cada mudança e `superpowers:verification-before-completion` antes de concluir.

**Objetivo:** retirar as transações de fatos quentes do caminho crítico, publicar Parquet reconciliado antes das projeções e atingir a meta inicial de menos de duas horas para 9.253.953 registros no Learner Lab.

**Arquitetura:** novas importações pelo painel executam o pipeline `canonical-v2`: restaurar, validar, extrair para spool local, publicar partições imutáveis no S3, gravar um commit marker do conjunto canônico, reconstruir projeções lendo exclusivamente partições `AVAILABLE` e pular a materialização quente. O pipeline legado permanece para execuções já iniciadas e para o backfill administrativo.

**Stack:** Python 3.12, PyArrow/Parquet, S3, DynamoDB control plane, Glue/Athena, pytest, TypeScript, ECS/Fargate e Terraform.

**Especificação:** `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

## Restrições globais

- Execute no mesmo worktree isolado da fase 1, depois de concluir seu gate e commits. Pare se `git status --short` produzir qualquer saída; não faça stash automático nem misture trabalho preexistente.
- Não use checkpoint de página MySQL como prova de durabilidade no `canonical-v2`: o spool local desaparece junto com a task.
- Cada bloco de comandos parte da raiz do repositório; ao continuar no mesmo shell, execute `cd "$(git rev-parse --show-toplevel)"` antes do próximo bloco.
- Uma retomada só pode pular restore/extract/archive se existir um commit marker validado para o conjunto canônico completo.
- Projeções só leem partições em estado `AVAILABLE`, com checksum e contagem iguais ao commit marker.
- O modo do pipeline é persistido por importação; mudar a feature flag não migra uma importação em andamento.
- `IMPORT_HOT_MATERIALIZATION_ENABLED=false` para importações do painel; o sincronismo incremental permanece inalterado.
- Não use `Scan` para descobrir partições, imports ou projeções.
- Toda mutação AWS usa apenas `--profile default --region us-east-1`; nunca use `nora`.
- O state continua pertencendo somente ao checkout original `/home/messias/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate`. Faça implementação/testes/commits no worktree, integre-os no checkout original limpo e execute `check`/`update` somente ali; nunca copie nem faça symlink do state.

Antes da tarefa 1:

```bash
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git log -1 --oneline
```

---

### Tarefa 1: fixar a versão do pipeline por importação

**Arquivos:**

- Modificar: `apps/backend/api/src/modules/imports/domain/import.ts`
- Modificar: `apps/backend/api/src/modules/imports/ports/import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/application/import-reconciler.ts`
- Modificar: `apps/backend/api/src/modules/imports/adapters/ecs-import-worker-launcher.ts`
- Modificar: `apps/backend/api/src/modules/imports/index.ts`
- Modificar: `apps/backend/api/src/config.ts`
- Modificar: `apps/backend/api/tests/import-domain.test.ts`
- Modificar: `apps/backend/api/tests/import-repository.test.ts`
- Modificar: `apps/backend/api/tests/import-reconciler.test.ts`
- Modificar: `apps/backend/api/tests/import-worker-launcher.test.ts`

**1. Escreva os testes que falham**

Modele um campo interno, não público:

```ts
type ImportPipelineVersion = "legacy-v1" | "canonical-v2";
```

Os testes devem provar:

- registro sem campo é decodificado como `legacy-v1`;
- o reconciliador grava a versão antes de iniciar a task;
- duas reservas concorrentes escolhem uma única versão;
- o launcher envia `IMPORT_PIPELINE_VERSION` à task;
- alterar `IMPORT_CANONICAL_FIRST_ENABLED` depois da reserva não altera o registro;
- itens legados em `PROCESSING` continuam reconciliáveis.

**2. Confirme o RED**

```bash
cd apps/backend/api
npm test -- tests/import-domain.test.ts tests/import-repository.test.ts tests/import-reconciler.test.ts tests/import-worker-launcher.test.ts
```

**3. Implemente a reserva atômica**

Acrescente ao repositório um CAS explícito:

```ts
reservePipeline(input: {
  importId: string;
  expectedVersion: number;
  pipelineVersion: ImportPipelineVersion;
  updatedAt: string;
}): Promise<ImportRecord>;
```

O reconciliador escolhe `canonical-v2` somente para importações ainda sem versão e quando a flag estiver ativa. A task recebe o valor persistido, nunca o valor atual da flag. Não exponha o campo em `ImportSnapshot` nesta fase.

**4. Confirme o GREEN**

```bash
cd apps/backend/api
npm test -- tests/import-domain.test.ts tests/import-repository.test.ts tests/import-reconciler.test.ts tests/import-worker-launcher.test.ts
npm run typecheck
```

**5. Commit**

```bash
git add -- apps/backend/api/src/config.ts apps/backend/api/src/modules/imports/domain/import.ts apps/backend/api/src/modules/imports/ports/import-repository.ts apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts apps/backend/api/src/modules/imports/application/import-reconciler.ts apps/backend/api/src/modules/imports/adapters/ecs-import-worker-launcher.ts apps/backend/api/src/modules/imports/index.ts apps/backend/api/tests/import-domain.test.ts apps/backend/api/tests/import-repository.test.ts apps/backend/api/tests/import-reconciler.test.ts apps/backend/api/tests/import-worker-launcher.test.ts
git diff --cached --name-only
git commit -m "feat(imports): pin pipeline version per import"
```

---

### Tarefa 2: representar o fluxo canônico sem quebrar runs legados

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/domain/run.py`
- Modificar: `apps/backend/ingestion-data/domain/import_job.py`
- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/config.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Modificar: `apps/backend/ingestion-data/application/import_dump.py`
- Modificar: `apps/backend/ingestion-data/adapters/dynamodb/control.py`
- Modificar: `apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/import_progress.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/observed_ports.py`
- Modificar: `apps/backend/ingestion-data/tests/fakes.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_run.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_import_dump.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_import_job.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py`
- Modificar: `apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py`
- Modificar: `apps/backend/ingestion-data/tests/contracts/test_port_contracts.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_lease_contention.py`
- Modificar: `apps/backend/api/contracts/src/index.ts`
- Modificar: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modificar: `apps/backend/api/tests/contracts.test.ts`
- Modificar: `apps/backend/api/tests/import-python-fixture.test.ts`
- Modificar: `apps/frontend/lib/imports/types.ts`
- Modificar: `apps/frontend/lib/imports/types.test.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.test.ts`
- Modificar: `apps/frontend/components/imports/import-status-card.test.tsx`

**1. Escreva os testes que falham**

Adicione sem remover `INGESTING`:

```python
class RunStage(StrEnum):
    EXTRACTING = "EXTRACTING"
    MATERIALIZING_HOT = "MATERIALIZING_HOT"
    FINALIZING_CANDIDATE = "FINALIZING_CANDIDATE"
```

O grafo novo deve aceitar apenas:

```text
VALIDATING -> EXTRACTING -> ARCHIVING -> PROJECTING
           -> MATERIALIZING_HOT -> FINALIZING_CANDIDATE -> PUBLISHING
```

O grafo legado `VALIDATING -> INGESTING -> PROJECTING -> ARCHIVING -> ACTIVATING -> PUBLISHING` permanece válido para runs `legacy-v1`. Como um enum sozinho não distingue os grafos, introduza `RunPipeline` em `RunState`/persistência, substitua o mapa global por `allowed_transitions(pipeline, stage)` e valide contra o grafo correspondente. `ImportProgressRunRepository` também substitui `_STAGE_ORDER` global por uma ordem indexada por pipeline; assim `PROJECTING -> ARCHIVING` continua válido no legado e `ARCHIVING -> PROJECTING` no v2. Registros sem o campo significam `LEGACY_V1`; wrappers de telemetria e fakes devem preservar o campo sem reinterpretá-lo.

Amplie `BackfillRequest`:

```python
pipeline: RunPipeline = RunPipeline.LEGACY_V1
materialize_hot_records: bool = True
```

Os testes de `import_dump` devem esperar `CANONICAL_V2` e `materialize_hot_records=False` quando a variável persistida da importação for `canonical-v2`. O CLI administrativo continua legado/quente por default.

Atualize também a enumeração de stage nos contratos e no parser do frontend. Inclua já, de forma opcional, `substage`, `currentPartition`, `unitsCompleted`, `unitsTotal` e `unitLabel`, pois a tarefa 6 os usa; valide o grupo de unidades como todos-ou-nenhum, não negativo e `completed <= total`. Registros antigos continuam aceitos; `EXTRACTING` aparece como “Extraindo registros”, `ARCHIVING` como “Publicando arquivos canônicos”, `MATERIALIZING_HOT` como “Preparando dados de consulta”/“Ignorado por política” e `FINALIZING_CANDIDATE` como “Finalizando candidato”. O consumidor compatível deve ser publicado antes de qualquer worker começar a emitir os novos valores. Edite `contracts/src/index.ts` e o JSON OpenAPI deliberadamente na mesma mudança — `build:contracts` apenas compila TypeScript — e use `tests/contracts.test.ts` como gate de paridade.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_run.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_import_progress.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/unit/bootstrap/test_config.py tests/contracts/test_port_contracts.py tests/resilience/test_lease_contention.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx
```

**3. Implemente apenas modelo/configuração**

Leia `IMPORT_PIPELINE_VERSION` como enum fechada. Leia `IMPORT_HOT_MATERIALIZATION_ENABLED`, mas rejeite `canonical-v2` com valor verdadeiro no comando `import-dump`: materialização quente v2 fica fora deste caminho crítico e será um job separado quando houver consumidor. Não altere ainda a ordem real do `Backfill`.

**4. Confirme o GREEN e compatibilidade**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_run.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_import_progress.py tests/resilience/test_lease_contention.py tests/unit/application/test_import_dump.py tests/unit/bootstrap/test_config.py tests/contracts/test_port_contracts.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx
```

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/domain/run.py apps/backend/ingestion-data/domain/import_job.py apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/bootstrap/config.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/application/import_dump.py apps/backend/ingestion-data/adapters/dynamodb/control.py apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py apps/backend/ingestion-data/adapters/telemetry/import_progress.py apps/backend/ingestion-data/adapters/telemetry/observed_ports.py apps/backend/ingestion-data/tests/fakes.py apps/backend/ingestion-data/tests/unit/domain/test_run.py apps/backend/ingestion-data/tests/unit/domain/test_import_job.py apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/unit/application/test_import_dump.py apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py apps/backend/ingestion-data/tests/contracts/test_port_contracts.py apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json apps/backend/ingestion-data/tests/resilience/test_lease_contention.py apps/backend/api/contracts/src/index.ts apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/import-python-fixture.test.ts apps/frontend/lib/imports/types.ts apps/frontend/lib/imports/types.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts apps/frontend/components/imports/import-status-card.test.tsx
git diff --cached --name-only
git commit -m "feat(ingestion): model canonical first run stages"
```

---

### Tarefa 3: criar o commit marker do conjunto canônico

**Arquivos:**

- Criar: `apps/backend/ingestion-data/domain/canonical_set.py`
- Modificar: `apps/backend/ingestion-data/ports/contracts.py`
- Modificar: `apps/backend/ingestion-data/ports/__init__.py`
- Criar: `apps/backend/ingestion-data/adapters/archive/s3_canonical_sets.py`
- Modificar: `apps/backend/ingestion-data/domain/archive.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/s3.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/glue.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/athena.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/domain/test_canonical_set.py`
- Criar: `apps/backend/ingestion-data/tests/unit/adapters/test_s3_canonical_sets.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_archive_aws.py`
- Modificar: `apps/backend/ingestion-data/tests/contracts/test_port_contracts.py`

**1. Escreva o domínio e testes que falham**

Use contratos imutáveis:

```python
@dataclass(frozen=True, slots=True)
class CanonicalObjectEvidence:
    object_key: str
    row_count: int
    byte_count: int
    sha256: str

@dataclass(frozen=True, slots=True)
class CanonicalPartitionEvidence:
    dataset: str
    partition: str
    row_count: int
    objects: tuple[CanonicalObjectEvidence, ...]

@dataclass(frozen=True, slots=True)
class CanonicalDatasetEvidence:
    dataset: str
    source_row_count: int
    accepted_row_count: int
    rejected_row_count: int
    schema_fingerprint: str
    coverage: str
    partitions: tuple[CanonicalPartitionEvidence, ...]

@dataclass(frozen=True, slots=True)
class CanonicalSet:
    schema_version: str
    dataset_version: str
    source_sha256: str
    contract_version: str
    snapshot_extracted_on: date
    aggregate_digest: str
    datasets: tuple[CanonicalDatasetEvidence, ...]
    total_source_rows: int
    total_accepted_rows: int
    total_rejected_rows: int

class CanonicalSetStore(ABC):
    @abstractmethod
    def get(self, dataset_version: str) -> CanonicalSet | None:
        raise NotImplementedError

    @abstractmethod
    def commit(self, value: CanonicalSet, *, idempotency_key: str) -> CanonicalSet:
        raise NotImplementedError
```

Invariantes dos testes:

- `datasets` contém exatamente `DatasetRegistry.names()`, inclusive datasets de zero linhas, em ordem e sem duplicatas;
- para cada dataset, `source = accepted + rejected`, soma das partições igual a `accepted`, schema fingerprint/coverage não vazios e snapshot date igual para todo o conjunto;
- somas por dataset iguais aos três totais do conjunto;
- partições ordenadas por `(dataset, partition)` e sem duplicatas;
- chaves preservam o layout atual sob `canonical/schema_version=1.0/dataset_version=<version>/dataset=<dataset>/<partition>/generation=<aggregateDigest>/part-<ordinal>-<sha256>.parquet`, sem bucket fornecido pelo chamador;
- objetos ordenados por chave, sem duplicatas, cada um com no máximo 512 MiB e soma de linhas igual à partição;
- `aggregateDigest` é SHA-256 do JSON canônico da evidência lógica antes de inserir object keys; qualquer mudança em schema, coverage, contagem, partição ou objeto muda a geração;
- `commit` idêntico é replay seguro;
- mesmo `datasetVersion` com qualquer evidência diferente é conflito terminal;
- objeto escrito com `If-None-Match: *`, SHA-256 próprio e `ExpectedBucketOwner`;
- leitura rejeita JSON fora do schema, checksum divergente e chave inesperada.

Chave física única:

```text
canonical/schema_version=1.0/dataset_version=<datasetVersion>/manifest.json
```

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_canonical_set.py tests/unit/adapters/test_s3_canonical_sets.py tests/unit/adapters/test_archive_aws.py tests/contracts/test_port_contracts.py -q
```

**3. Implemente o mínimo e confirme o GREEN**

Não liste prefixos S3 para formar o conjunto; o manifest é a lista autoritativa. Não inclua URL assinada, credencial, `importId` ou caminho local. Estenda `canonical_archive_key()` para exigir `aggregate_digest` e `ordinal`; mantenha um decoder explícito para metadata v1, mas todo write v2 usa a geração. Faça Glue registrar cada partição com `StorageDescriptor.Location` apontando exatamente para seu subprefixo `generation=<aggregateDigest>/`, e faça Athena validar a partição registrada em vez de consultar o root do dataset; um objeto órfão em outra geração não pode alterar a contagem.

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_canonical_set.py tests/unit/adapters/test_s3_canonical_sets.py tests/unit/adapters/test_archive_aws.py tests/contracts/test_port_contracts.py -q
```

**4. Commit**

```bash
git add -- apps/backend/ingestion-data/domain/canonical_set.py apps/backend/ingestion-data/ports/contracts.py apps/backend/ingestion-data/ports/__init__.py apps/backend/ingestion-data/adapters/archive/s3_canonical_sets.py apps/backend/ingestion-data/domain/archive.py apps/backend/ingestion-data/adapters/archive/s3.py apps/backend/ingestion-data/adapters/archive/glue.py apps/backend/ingestion-data/adapters/archive/athena.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/domain/test_canonical_set.py apps/backend/ingestion-data/tests/unit/adapters/test_s3_canonical_sets.py apps/backend/ingestion-data/tests/unit/adapters/test_archive_aws.py apps/backend/ingestion-data/tests/contracts/test_port_contracts.py
git diff --cached --name-only
git commit -m "feat(ingestion): persist canonical set commit marker"
```

---

### Tarefa 4: publicar arquivos canônicos sem depender de projeções ou hot facts

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/application/archive_partition.py`
- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/domain/archive.py`
- Modificar: `apps/backend/ingestion-data/ports/models.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/parquet.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/s3.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/glue.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/athena.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/s3_canonical_sets.py`
- Modificar: `apps/backend/ingestion-data/application/import_dump.py`
- Modificar: `apps/backend/ingestion-data/domain/import_job.py`
- Modificar: `apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py`
- Modificar: `apps/backend/ingestion-data/tests/fakes.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_archive_partition.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_parquet.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_archive_aws.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_archive_ttl_guard.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_import_dump.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_import_job.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py`
- Modificar: `apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json`
- Modificar: `apps/backend/api/contracts/src/index.ts`
- Modificar: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modificar: `apps/backend/api/tests/contracts.test.ts`
- Modificar: `apps/backend/api/tests/import-python-fixture.test.ts`
- Modificar: `apps/backend/api/src/modules/imports/domain/import.ts`
- Modificar: `apps/backend/api/tests/import-domain.test.ts`
- Modificar: `apps/frontend/lib/imports/types.ts`
- Modificar: `apps/frontend/lib/imports/types.test.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.test.ts`

**1. Escreva os testes que falham**

Para `canonical-v2`, prove que:

- `_extract` chama leitor/normalizador/spool, mas nunca `HotRecordSink.write`;
- nenhum checkpoint de página durável avança enquanto os dados existem apenas no spool local;
- `ARCHIVING` recebe somente registros extraídos e não recebe `ProjectionBuildResult`;
- cada partição chega a `AVAILABLE` antes de qualquer chamada à projeção;
- `hotItemCount=0` e `projectionItemCount` deixa de fazer parte da identidade imutável da partição v2;
- row count do Parquet, contagem normalizada e metadado Athena reconciliam;
- retry de uma partição `AVAILABLE` com mesmo `row_count/sha256` não faz novo upload;
- retry com checksum diferente para a mesma identidade falha;
- o commit marker só é gravado depois que todas as partições esperadas estão `AVAILABLE`;
- falha antes do commit marker força nova extração; falha depois dele pula restore/extract/archive.

Classifique falhas com tipos, não por texto:

| tipo | código público | retryable |
|---|---|---:|
| indisponibilidade S3/Glue/Athena | `ARCHIVE_PUBLICATION_FAILED` | `true` |
| throttling DynamoDB após esgotar retry | `DYNAMODB_THROTTLED` | `true` |
| `DiskBudgetExceeded` | `DISK_PRESSURE` | `true` |
| checksum físico/canônico divergente | `CHECKSUM_MISMATCH` | `false` |
| schema/coverage incompatível | `SOURCE_SCHEMA_INVALID` | `false` |
| partição/contagem/evidência conflitante | `DATA_RECONCILIATION_FAILED` | `false` |

Adicione os códigos às allowlists Python/TypeScript/frontend e preserve o formato seguro criado na fase 1.

Mantenha os testes do fluxo legado intactos.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_archive_partition.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_parquet.py tests/unit/adapters/test_archive_aws.py tests/resilience/test_archive_ttl_guard.py tests/resilience/test_idempotent_backfill.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts tests/import-domain.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts
```

**3. Separe extração e publicação**

Extraia do método `_ingest` dois caminhos explícitos chamados `_extract_to_spool` e `_write_hot_from_batches`. O primeiro recebe reader, contexto, request, candidato, data do snapshot, estado e coverage; o segundo recebe request, candidato e `CanonicalSet`.

`_extract_to_spool` não recebe `HotRecordSink` nem `CheckpointRepository`. A contabilização `recordsWritten` permanece zero durante `EXTRACTING` e avança ao confirmar Parquet `AVAILABLE` em `ARCHIVING`.

Não mantenha JSON normalizado e todos os Parquets ao mesmo tempo. Ao fechar uma partição, codifique-a, envie-a para a chave determinística temporária `staging/canonical/<datasetVersion>/<dataset>/<partition>/part-<ordinal>-<sha>.parquet`, valide o `HEAD` e libere os arquivos locais daquela partição. Depois de conhecer toda a evidência, calcule `aggregateDigest` e promova cada objeto por cópia server-side para a chave final com `generation=<aggregateDigest>`. Se a chave temporária ou final já existir com tamanho/checksum iguais, reutilize-a; divergência falha fechado. Só depois do `HEAD` final registre Glue/Athena/`ArchivePartition.AVAILABLE`. O lifecycle da tarefa 7 limpa staging órfão, nunca objetos canônicos.

Refatore `_archive` para devolver:

```python
@dataclass(frozen=True, slots=True)
class ArchiveBuildResult:
    canonical_set: CanonicalSet
    new_objects: int
    written_records: int
    unchanged_records: int
```

O encoder deve mirar row groups de 128 MiB e dividir antes de 512 MiB por objeto. Faça a decisão por bytes estimados/observados, não por uma quantidade fixa de linhas. Partições pequenas geram um único objeto; partições maiores registram vários `CanonicalObjectEvidence` dentro da mesma identidade lógica `(dataset, partition)`. Para metadata v2, persista a lista ordenada de objetos e a geração agregada; continue decodificando o formato v1 de objeto único.

Antes de restaurar MySQL, consulte `CanonicalSetStore.get(candidate)`. Se houver marker válido, reconcilie todas as partições com `ArchivePartitionRepository` e S3 `head`; somente então pule a origem. Caso contrário, ignore checkpoints legados para o caminho v2, faça a extração desde o início e limpe apenas o workdir pertencente a esse run.

**4. Confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_archive_partition.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py tests/unit/adapters/test_parquet.py tests/unit/adapters/test_archive_aws.py tests/resilience/test_archive_ttl_guard.py tests/resilience/test_idempotent_backfill.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts tests/import-domain.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts
```

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/application/archive_partition.py apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/application/import_dump.py apps/backend/ingestion-data/domain/archive.py apps/backend/ingestion-data/domain/import_job.py apps/backend/ingestion-data/ports/models.py apps/backend/ingestion-data/adapters/archive/parquet.py apps/backend/ingestion-data/adapters/archive/s3.py apps/backend/ingestion-data/adapters/archive/glue.py apps/backend/ingestion-data/adapters/archive/athena.py apps/backend/ingestion-data/adapters/archive/s3_canonical_sets.py apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py apps/backend/ingestion-data/tests/fakes.py apps/backend/ingestion-data/tests/unit/application/test_archive_partition.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/unit/application/test_import_dump.py apps/backend/ingestion-data/tests/unit/domain/test_import_job.py apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py apps/backend/ingestion-data/tests/unit/adapters/test_parquet.py apps/backend/ingestion-data/tests/unit/adapters/test_archive_aws.py apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json apps/backend/ingestion-data/tests/resilience/test_archive_ttl_guard.py apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py apps/backend/api/contracts/src/index.ts apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/src/modules/imports/domain/import.ts apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/import-python-fixture.test.ts apps/backend/api/tests/import-domain.test.ts apps/frontend/lib/imports/types.ts apps/frontend/lib/imports/types.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts
git diff --cached --name-only
git commit -m "feat(ingestion): publish canonical archive before serving data"
```

---

### Tarefa 5: construir projeções exclusivamente do conjunto canônico

**Arquivos:**

- Criar: `apps/backend/ingestion-data/application/read_canonical_set.py`
- Modificar: `apps/backend/ingestion-data/application/rebuild_projections.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/s3.py`
- Modificar: `apps/backend/ingestion-data/adapters/archive/parquet.py`
- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/application/test_read_canonical_set.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_projections.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Criar: `apps/backend/ingestion-data/tests/integration/test_canonical_projection_rebuild.py`

**1. Escreva os testes que falham**

Defina uma fonte limitada em memória:

```python
class CanonicalRecordSource(ABC):
    @abstractmethod
    def iter_batches(
        self,
        canonical_set: CanonicalSet,
        *,
        batch_size: int = 2_048,
    ) -> Iterable[ArchiveRecords]:
        raise NotImplementedError
```

Os testes devem provar:

- download somente das chaves presentes no marker;
- `ArchiveState.AVAILABLE` obrigatório antes do download;
- validação de `ExpectedBucketOwner`, tamanho, SHA-256, row count, dataset e partição;
- batches não ultrapassam o limite configurado;
- um objeto de 512 MiB é lido por `pyarrow.parquet.ParquetFile.iter_batches`; o teste espiona o reader e falha se `read_table()`, `read_partition()` ou `tuple(_iter_partition(...))` materializar o arquivo inteiro;
- `ProjectionService.materialize_record_batches` recebe dependências `ArchiveDependency` corretas;
- nenhuma chamada a `ProjectionRepository.iter_input_batches` ou fatos quentes no caminho v2;
- repetição com mesmas revisões é idempotente;
- partição ausente/divergente impede candidato/ativação.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_read_canonical_set.py tests/unit/application/test_projections.py tests/unit/application/test_backfill.py tests/integration/test_canonical_projection_rebuild.py -q
```

**3. Implemente o reader e ligue `ARCHIVING -> PROJECTING`**

Faça download de um objeto por vez para um diretório temporário pertencente ao run e calcule SHA-256 durante o stream. Antes de emitir o primeiro batch, valide tamanho, checksum, footer, schema e metadata; depois use `ParquetFile.iter_batches(batch_size=...)` e confira a contagem acumulada ao EOF. Não chame o `read_partition()` atual, pois ele transforma `_iter_partition()` inteiro em `tuple` e pode expandir 512 MiB para vários GiB. Remova o arquivo temporário em `finally`. O `Backfill` deve liberar o spool depois que o objeto foi confirmado e ler novamente do S3 durante projeção; isso prova que S3 é a fonte de verdade.

Mova `projectionItemCount` para a evidência do candidato/projection result. Ele não bloqueia a publicação do arquivo canônico. Preserve a leitura de metadados antigos que ainda o contenham.

**4. Confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_read_canonical_set.py tests/unit/application/test_projections.py tests/unit/application/test_backfill.py tests/integration/test_canonical_projection_rebuild.py -q
```

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/application/read_canonical_set.py apps/backend/ingestion-data/application/rebuild_projections.py apps/backend/ingestion-data/adapters/archive/s3.py apps/backend/ingestion-data/adapters/archive/parquet.py apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/application/test_read_canonical_set.py apps/backend/ingestion-data/tests/unit/application/test_projections.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/integration/test_canonical_projection_rebuild.py
git diff --cached --name-only
git commit -m "feat(ingestion): build projections from canonical parquet"
```

---

### Tarefa 6: pular materialização quente no v2 e preservar o legado administrativo

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/domain/run.py`
- Modificar: `apps/backend/ingestion-data/application/import_dump.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/integration/test_mysql_to_stores.py`

**1. Escreva os testes que falham**

Cubra os dois pipelines:

```text
painel/canonical-v2:  materialize_hot_records=false
CLI/legacy-v1:        materialize_hot_records=true
```

No modo falso:

- a etapa `MATERIALIZING_HOT` é persistida com zero unidades e substage `SKIPPED_BY_POLICY`;
- `HotRecordSink.write`, `HotExpirationRepository` e restauração via hot facts nunca são chamados;
- o manifesto declara `hotMaterialization: "SKIPPED"` e `hotItemCount: 0`;
- projeções, reconciliação e publicação do candidato continuam obrigatórias; `CONTROL#DATASET/ACTIVE` permanece inalterado até a ação humana existente.

No pipeline legado:

- preserve a ordem, writer transacional, checkpoints, contagens e retomada atuais;
- retry continua sem duplicar itens;
- incremental e reprocess continuam usando o mesmo sink;
- nenhuma permissão `BatchWriteItem` é adicionada nesta fase.

Rejeite explicitamente `canonical-v2 + materialize_hot_records=true`. O futuro hot tail será um job allowlisted que lê `CanonicalSet`; ele não deve reaparecer dentro da importação do painel.

**2. Confirme o RED, implemente e confirme o GREEN**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/unit/application/test_backfill.py tests/resilience/test_idempotent_backfill.py tests/integration/test_mysql_to_stores.py -q
)
```

**3. Execute a suíte de regressão incremental**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/integration/test_incremental_mysql_parquet.py tests/resilience/test_incremental_ingest_resume.py tests/resilience/test_incremental_export_resume.py -q
)
```

Esperado: sem mudanças de semântica.

**4. Commit**

```bash
git add -- apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/domain/run.py apps/backend/ingestion-data/application/import_dump.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py apps/backend/ingestion-data/tests/integration/test_mysql_to_stores.py
git diff --cached --name-only
git commit -m "feat(ingestion): make hot materialization optional"
```

---

### Tarefa 7: habilitar por flag e proteger o rollout

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/domain/disk_budget.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/config.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_disk_budget.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py`
- Modificar: `apps/fullstack/ingestion-ecs.tf`
- Modificar: `apps/fullstack/ingestion-imports.tf`
- Modificar: `apps/fullstack/ingestion-variables.tf`
- Modificar: `apps/fullstack/ingestion-observability.tf`
- Modificar: `apps/fullstack/ingestion-storage.tf`
- Modificar: `apps/fullstack/tests/ingestion_defaults.tftest.hcl`
- Modificar: `apps/fullstack/tests/ingestion_production.tftest.hcl`
- Modificar: `apps/backend/api/tests/ci/fullstack-iac-policy.test.js`
- Modificar: `apps/fullstack/README.md`
- Modificar: `apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Modificar: `scripts/ci/validate-terraform-learner-update-plan.mjs`
- Modificar: `scripts/tests/validate-terraform-learner-update-plan.test.mjs`

**1. Escreva os testes de política que falham**

Exija defaults:

```text
IMPORT_CANONICAL_FIRST_ENABLED=false
IMPORT_HOT_MATERIALIZATION_ENABLED=false
INGESTION_DISK_BUDGET_BYTES=68719476736
```

Quando canonical-first estiver desligado, o API reserva `legacy-v1`. Quando ligado, somente novas importações recebem `canonical-v2`. Produção deve rejeitar a flag ligada sem uma variável explícita de aprovação do rollout.

Eleve `MAX_INGESTION_DISK_BUDGET_BYTES` de 16 GiB para 128 GiB, mantendo a task em 200 GiB, e use 64 GiB apenas no import/backfill snapshot; sync/incremental conservam seus limites atuais. Teste que o preflight falha antes de restaurar/extrair quando o filesystem não possui 64 GiB livres e que 128 GiB é o teto. Adicione lifecycle separado para `staging/canonical/` com expiração de sete dias e abort multipart em um dia; nenhum rule pode abranger `canonical/`.

Estenda os presets seguros do wrapper com `phase2-2000`, `phase2-5000` e `phase2-10000`. Cada um mantém o preflight da fase 1 ligado, usa o page size do nome, liga `IMPORT_CANONICAL_FIRST_ENABLED` e mantém hot materialization desligada. Torne os presets `phase1-*` forward-compatible: depois que a fase 2 existir, eles desligam apenas canonical-first para novas importações e preservam lifecycle, capacidade e alarmes já criados, sem planejar deletes. Estenda a validação de variáveis e a allowlist somente para `aws_s3_bucket_lifecycle_configuration.ingestion`, `aws_cloudwatch_metric_alarm.ingestion_disk_usage_warning`, `aws_cloudwatch_metric_alarm.ingestion_disk_usage_critical` e `aws_cloudwatch_metric_alarm.ingestion_canonical_archive_failures`, além dos recursos stateless já permitidos; continue rejeitando substituição ou delete de bucket/tabela/catálogo. O lifecycle só pode acrescentar a rule `staging-canonical-expiration` limitada ao prefixo `staging/canonical/`; qualquer mudança que alcance `canonical/` falha. O mesmo `GetItem` de `CONTROL#IMPORT/ACTIVE` precisa estar vazio antes do update.

**2. Confirme o RED, implemente e valide**

```bash
cd apps/backend/api
npm run test:ci-policy
cd ../../fullstack
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
terraform test
cd ../..
node --test scripts/tests/aws-learner-lab.test.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_disk_budget.py tests/unit/bootstrap/test_config.py -q
```

**3. Atualize o runbook**

Documente: inspeção do commit marker, contagens/checksums por partição, como diferenciar restart de origem e retomada pelo S3, uso de disco do spool com alarmes em 80%/90%, orçamento do app de 64 GiB dentro dos 200 GiB da task, rollback que afeta somente imports novos e proibição de apagar partições de um candidato em andamento.

**4. Commit**

```bash
git add -- apps/backend/ingestion-data/domain/disk_budget.py apps/backend/ingestion-data/bootstrap/config.py apps/backend/ingestion-data/tests/unit/domain/test_disk_budget.py apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py apps/fullstack/ingestion-ecs.tf apps/fullstack/ingestion-imports.tf apps/fullstack/ingestion-variables.tf apps/fullstack/ingestion-observability.tf apps/fullstack/ingestion-storage.tf apps/fullstack/tests/ingestion_defaults.tftest.hcl apps/fullstack/tests/ingestion_production.tftest.hcl apps/backend/api/tests/ci/fullstack-iac-policy.test.js apps/fullstack/README.md apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs scripts/ci/validate-terraform-learner-update-plan.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
git diff --cached --name-only
git commit -m "infra(ingestion): gate canonical first imports"
```

---

### Tarefa 8: fault injection, benchmark completo e aceite

**Arquivos:**

- Criar: `apps/backend/ingestion-data/tests/resilience/test_canonical_first_failures.py`
- Modificar: `apps/backend/ingestion-data/scripts/benchmark_snapshot_reader.py`
- Modificar: `apps/backend/ingestion-data/tests/performance/test_snapshot_reader_benchmark.py`
- Modificar: `apps/backend/ingestion-data/README.md`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Modificar: `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

**1. Escreva os testes de falha**

Injete falha:

- após extração, antes do primeiro upload;
- após objeto S3 promovido, antes de atualizar estado;
- após algumas partições `AVAILABLE`, antes do commit marker;
- após commit marker, antes da primeira projeção;
- durante projeção e antes do candidato;
- com checksum divergente numa partição já existente.

Para cada ponto, repita a execução e prove: zero perda/duplicação, candidato não ativo durante falha, objeto idêntico não reenviado e nenhuma leitura de hot facts no v2.

Adicione o subcomando `import-canary`, que testa o mesmo fluxo público usado pelo painel em vez do backfill administrativo:

```text
node scripts/aws-learner-lab.mjs import-canary \
  --snapshot <argus_dump.sql.gz> \
  --extracted-on YYYY-MM-DD \
  --username <email> \
  --label <slug> \
  --timeout-seconds <n> \
  [--stop-at-stage EXTRACTING|ARCHIVING|PROJECTING|FINALIZING_CANDIDATE]
```

Obtenha `painel_url` do output Terraform já validado, faça login same-origin e solicite a senha em TTY sem eco. Mantenha senha, cookie e tokens apenas em memória. Faça multipart com partes de 16 MiB e concorrência três, retome upload interrompido via `listParts`, derive idempotency keys estáveis de label + hash e acompanhe a importação até `READY|FAILED|deadline`; nunca ative o candidato. Grave evidência sanitizada em `.artifacts` com modo `0600`, sem senha, cookie, token ou URL assinada. Rejeite symlink, basename diferente de `argus_dump.sql.gz`, usuário/label inválidos e execução sem TTY antes de qualquer chamada externa.

Com `--stop-at-stage`, acompanhe o import ID criado pelo próprio comando, leia por chave exata o registro operacional e o run correspondente e aceite somente o task ARN persistido para esse import. Antes de `ecs:StopTask`, faça `DescribeTasks` no ARN exato e confirme cluster, task definition, override `IMPORT_ID` e estágio; exija confirmação `STOP <account-id> <import-id> <task-arn>`. Sem a opção, não existe caminho de stop. Depois do stop esperado, valide `STOPPED`, container não-zero e candidato não ativo, mas não retorne ainda: com leituras consistentes e deadline explícito, espere o import persistir `FAILED`, `retryable=true` e o item `CONTROL#IMPORT/ACTIVE` desaparecer. Só então grave `faultInjected=true` e encerre o experimento com sucesso, tornando seguro iniciar o recovery sequencial. Teste timeout sem stop, ARN divergente, import divergente, stop único, ausência de `FAILED` e lock não liberado; nunca implemente busca/stop por cluster inteiro.

**2. Execute verificação local completa**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest -m "not mysql" -q
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy bootstrap
cd ../api
npm run verify
npm run test:ci-policy
cd ../../..
node --test scripts/tests/aws-learner-lab.test.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest -m mysql -q
)
```

**3. Commit o harness antes de qualquer rollout**

Ainda no worktree isolado, versione todo o código que será necessário para fault injection e canários. Não inclua agora a especificação: os números reais só serão registrados depois do rollout.

```bash
git add -- apps/backend/ingestion-data/tests/resilience/test_canonical_first_failures.py apps/backend/ingestion-data/scripts/benchmark_snapshot_reader.py apps/backend/ingestion-data/tests/performance/test_snapshot_reader_benchmark.py apps/backend/ingestion-data/README.md scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs
git diff --cached --name-only
git commit -m "test(ingestion): verify canonical first import slo"
```

**4. Integre no checkout que possui o state e faça os canários no Learner Lab**

Depois de commitar a fase 2 no worktree, use `superpowers:finishing-a-development-branch` para integrar esses commits no checkout original. Pare se ele contiver qualquer mudança; não copie nem faça symlink do state. Partindo do checkout original:

```bash
cd /home/messias/Documentos/github/g05-md7/g05
test "$(pwd -P)" = /home/messias/Documentos/github/g05-md7/g05
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test -f apps/fullstack/terraform.tfstate
test ! -L apps/fullstack/terraform.tfstate
test -f .artifacts/argus-benchmarks/100k/argus_dump.sql.gz
test -f .artifacts/argus-benchmarks/1m/argus_dump.sql.gz
test -f /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz
gzip -t /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz
printf '%s  %s\n' c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz | sha256sum --check --status
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs check
aws sts get-caller-identity --profile default --region us-east-1
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase2-5000
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/100k/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase2-100k --timeout-seconds 3600
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase2-1m-fault --timeout-seconds 7200 --stop-at-stage PROJECTING
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase2-1m-recovery --timeout-seconds 7200
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase2-full --timeout-seconds 10800
```

Aborte se a conta não for a esperada. Se a fase 1 selecionou 2.000 ou 10.000, substitua somente o sufixo dos presets `phase1-*`/`phase2-*` em todo o rollout. O update mantém hot materialization desligada. A execução interrompida deve falhar sem candidato ativo; a seguinte, com o mesmo dump e identidade canônica, deve validar o marker e pular restore/MySQL. O último comando usa o dump real de 9.253.953 registros (1.033.402.337 bytes, SHA-256 fixado acima); não o copie para o repositório nem o redistribua.

Critérios de aceite:

- 9.253.953 registros em menos de duas horas;
- para cada dataset, `sum(partition.row_count) == dataset.accepted_row_count`; no conjunto, `sum(dataset.source_row_count) == total_source_rows == recordsRead`, `sum(dataset.accepted_row_count) == total_accepted_rows == recordsRead - recordsRejected` e `sum(dataset.rejected_row_count) == total_rejected_rows == recordsRejected`; `coverage` é validado como metadado estrutural completo, não como uma contagem;
- todas as partições `AVAILABLE`, checksums válidos e quatro famílias de projeção presentes;
- zero fatos quentes gravados pelo import do painel;
- uma falha após commit marker retoma sem restaurar MySQL;
- candidato fica `READY` e só muda o ativo após a ação explícita existente;
- tempos por etapa, throughput e tamanho/quantidade de Parquet registrados na especificação.

Se a meta falhar, não aumente concorrência às cegas: use p95 de consulta, encode, upload, Athena e projeção para localizar o novo gargalo.

**5. Ensaie rollback**

Depois de drenar a importação, desligue `IMPORT_CANONICAL_FIRST_ENABLED` pelo preset anterior e prove que somente a próxima importação usa `legacy-v1`; a importação v2 em voo continua v2. Não apague arquivos ou manifests durante o ensaio:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase1-5000
```

**6. Registre e versione somente a evidência**

No checkout original, acrescente à especificação os tempos por etapa, throughput, quantidades/tamanhos de Parquet, evidência da retomada e resultado do rollback. O código usado no rollout já está no commit pré-rollout:

```bash
git add -- docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md
git diff --cached --name-only
git commit -m "docs(ingestion): record phase 2 canary evidence"
```

## Gate para iniciar a fase 3

- O commit marker é a única prova de conjunto canônico completo.
- Um retry depois do marker não restaura MySQL.
- Projeções leem S3 `AVAILABLE`, nunca hot facts.
- Imports do painel gravam zero fatos brutos no DynamoDB.
- Incremental e backfill administrativo continuam passando.
- O dump completo conclui abaixo de duas horas ou existe benchmark que identifica precisamente o gargalo residual.
- Rollback por flag foi ensaiado sem migrar runs em voo.
