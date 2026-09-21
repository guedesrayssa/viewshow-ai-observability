# Importação ARGUS — fase 3: workflow durável, retomada e progresso explicável

> **Para quem executar — REQUIRED SUB-SKILL:** conclua as fases 1 e 2 antes deste arquivo. Use `superpowers:executing-plans` tarefa a tarefa, `superpowers:test-driven-development` em cada mudança, consulte a documentação Next.js local exigida por `apps/frontend/AGENTS.md` antes de editar o frontend e use `superpowers:verification-before-completion` no gate final.

**Objetivo:** orquestrar a importação em tasks idempotentes, permitir nova tentativa sem novo upload e mostrar com precisão se o worker está vivo, avançando, repetindo uma operação ou realmente falhou.

**Arquitetura:** uma Step Functions Standard inicia três tasks Fargate: `prepare-archive` (única com sidecar MySQL), `build-projections` e `verify-publish-candidate`. O conjunto canônico da fase 2 é a fronteira durável entre tasks. Receipts no DynamoDB tornam cada etapa repetível; a API persiste tentativa/modo de orquestração antes de iniciar o workflow. O fluxo ECS legado permanece atrás de flag durante a drenagem.

**Stack:** TypeScript/Express, AWS SDK v3, Python 3.12, ECS/Fargate, Step Functions Standard, DynamoDB, S3, CloudWatch, React/Next.js, Vitest/Testing Library, pytest e Terraform.

**Especificação:** `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

## Restrições globais

- Execute no worktree isolado e limpo que concluiu a fase 2. Pare se `git status --short` produzir qualquer saída; não faça stash automático nem misture mudanças preexistentes.
- A primeira task mantém MySQL e spool no mesmo Fargate task. Nenhuma task posterior depende do disco efêmero dela.
- Cada bloco de comandos parte da raiz do repositório; ao continuar no mesmo shell, execute `cd "$(git rev-parse --show-toplevel)"` antes do próximo bloco.
- Payload do workflow contém apenas identificadores pequenos; registros, manifests e resultados ficam em S3/DynamoDB.
- Não use `RedriveExecution` como contrato de retry. Uma nova tentativa cria novo nome/ARN e reutiliza receipts concluídos.
- O estado público continua compatível: falha transitória é `FAILED` com `retryable=true`; não introduza um estado público novo sem nova aprovação de produto.
- `/restart` continua significando reinício do multipart upload. Processamento usa `POST /imports/{importId}/retry`.
- `heartbeatAt` significa “worker vivo”; `lastProgressAt` significa “trabalho avançou”. Nunca derive falha somente no browser.
- O modo de orquestração é fixado por importação; uma mudança de flag afeta apenas importações novas.
- Antes de editar frontend, leia os arquivos relevantes em `apps/frontend/node_modules/next/dist/docs/` conforme `apps/frontend/AGENTS.md`.
- Toda mutação AWS usa apenas `--profile default --region us-east-1`; nunca use `nora`.
- O state Terraform permanece somente no checkout original `/home/messias/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate`. Implemente, teste e commite no worktree; integre os commits no checkout original limpo antes do rollout e execute todo `check`/`plan-update`/`update` dali. Nunca copie nem faça symlink do state.

Antes da tarefa 1:

```bash
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git log -1 --oneline
```

---

### Tarefa 1: tornar o frontend tolerante ao contrato aditivo

**Arquivos:**

- Modificar: `apps/frontend/lib/imports/types.ts`
- Modificar: `apps/frontend/lib/imports/types.test.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.test.ts`
- Modificar: `apps/frontend/components/imports/import-status-card.tsx`
- Modificar: `apps/frontend/components/imports/import-status-card.test.tsx`

**1. Leia a documentação local obrigatória**

Partindo de `apps/frontend`, leia exatamente estes arquivos empacotados e registre os quatro no commit body:

```text
node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md
node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md
node_modules/next/dist/docs/01-app/02-guides/testing/vitest.md
node_modules/next/dist/docs/03-architecture/accessibility.md
```

**2. Escreva os testes que falham**

Amplie o tipo local de progresso, inicialmente opcional:

```ts
type ImportProgress = {
  // Preserve sem renomear stage, substage, contadores, datasets e timestamps atuais.
  lastProgressAt: string | null;
  throughputPerSecond: number | null;
  estimatedSecondsRemaining: number | null;
  attempt: number | null;
  maxAttempts: number | null;
  retryReason: string | null;
};
```

`substage`, `currentPartition` e o grupo `units*` já existem desde a fase 2 e permanecem inalterados. Fixtures antigos sem os campos novos desta fase devem normalizá-los para `null`, sem erro. Fixtures novos devem rejeitar NaN, negativos, timestamp inválido e grupo de tentativa parcial (`attempt` sem `maxAttempts`).

O card deve continuar igual para o contrato antigo. Para o novo, inicialmente apenas preserve os dados; não exponha UI ainda.

**3. Confirme o RED, implemente o parser e confirme o GREEN**

```bash
cd apps/frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx
npm run typecheck
```

**4. Commit**

```bash
git add -- apps/frontend/lib/imports/types.ts apps/frontend/lib/imports/types.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts apps/frontend/components/imports/import-status-card.tsx apps/frontend/components/imports/import-status-card.test.tsx
git diff --cached --name-only
git commit -m "refactor(imports): accept additive progress details" -m "Next.js docs consulted: server-and-client-components.md; use-client.md; testing/vitest.md; architecture/accessibility.md."
```

---

### Tarefa 2: fechar o contrato de progresso entre Python, API e frontend

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/domain/run.py`
- Modificar: `apps/backend/ingestion-data/domain/import_job.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/import_progress.py`
- Modificar: `apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_run.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_import_job.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py`
- Modificar: `apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json`
- Modificar: `apps/backend/api/contracts/src/index.ts`
- Modificar: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modificar: `apps/backend/api/tests/contracts.test.ts`
- Modificar: `apps/backend/api/tests/import-python-fixture.test.ts`

**1. Escreva testes cruzados que falham**

Amplie `RunActivity` com os campos da tarefa 1. Defina os grupos opcionais como “todos ou nenhum”:

```python
attempt: int | None
max_attempts: int | None
retry_reason: str | None

# Preserve os campos substage/current_partition/units_* introduzidos na fase 2.
```

Invariantes:

- contadores e unidades não negativos;
- `attempt` em `1..max_attempts`;
- `units_completed <= units_total`;
- throughput finito e positivo, ETA inteiro não negativo;
- `last_progress_at <= heartbeat_at`;
- `currentPartition`, `retryReason` e `unitLabel` passam pela sanitização/limite já usados para texto público.

Atualize o fixture Python consumido pelo TypeScript e faça o teste provar round-trip sem perda.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_run.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_progress.py tests/unit/adapters/test_import_jobs.py -q
cd ../api
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts
```

**3. Implemente de forma aditiva**

Campos ausentes no DynamoDB continuam válidos. `ImportProgressRunRepository.report_activity()` atualiza `heartbeatAt` em toda emissão, mas só altera `lastProgressAt` se estágio, registros, bytes ou unidades avançarem. Um heartbeat idêntico não conta como progresso.

Não existe gerador de OpenAPI: edite `contracts/src/index.ts` e `contracts/openapi/public.openapi.json` na mesma mudança. `build:contracts` compila TypeScript e `tests/contracts.test.ts` valida a paridade.

**4. Confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_run.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_progress.py tests/unit/adapters/test_import_jobs.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts
```

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/domain/run.py apps/backend/ingestion-data/domain/import_job.py apps/backend/ingestion-data/adapters/telemetry/import_progress.py apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py apps/backend/ingestion-data/tests/unit/domain/test_run.py apps/backend/ingestion-data/tests/unit/domain/test_import_job.py apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json apps/backend/api/contracts/src/index.ts apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/import-python-fixture.test.ts
git diff --cached --name-only
git commit -m "feat(imports): publish durable detailed progress"
```

---

### Tarefa 3: calcular avanço, throughput e ETA sem confundir heartbeat

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/import_progress.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py`

**1. Escreva os testes que falham**

Injete relógio monotônico no `_RunActivityTracker`. Cubra:

- primeiro sample: throughput/ETA nulos;
- segundo sample após pelo menos 5 segundos: taxa calculada;
- EWMA `rate = 0.2 * instantaneous + 0.8 * previous`;
- contador inalterado atualiza heartbeat, mas não `lastProgressAt` nem taxa;
- mudança de etapa reinicia a amostra e conta como uma unidade de avanço;
- ETA somente quando total conhecido, restante positivo e taxa > 0;
- restore/validação mostram `unitsCompleted/unitsTotal`, não percentual de registros inventado;
- retry mostra tentativa e motivo seguro, e limpa os campos depois do sucesso.

**2. Confirme o RED, implemente e confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_backfill.py tests/unit/adapters/test_import_progress.py -q
```

Use relógio monotônico apenas para diferenças e UTC apenas para timestamps persistidos. Arredonde throughput para duas casas e ETA para inteiro; não emita infinito. Não persista uma atualização a cada registro: mantenha o intervalo/coalescência atual de telemetria e force emissão em mudança de etapa, retry e conclusão de unidade.

**3. Commit**

```bash
git add -- apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/adapters/telemetry/import_progress.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/unit/adapters/test_import_progress.py
git diff --cached --name-only
git commit -m "feat(ingestion): distinguish heartbeat from work progress"
```

---

### Tarefa 4: criar receipts idempotentes para as três etapas

**Arquivos:**

- Criar: `apps/backend/ingestion-data/domain/import_workflow.py`
- Modificar: `apps/backend/ingestion-data/ports/contracts.py`
- Modificar: `apps/backend/ingestion-data/ports/__init__.py`
- Criar: `apps/backend/ingestion-data/adapters/dynamodb/import_step_receipts.py`
- Criar: `apps/backend/ingestion-data/adapters/archive/s3_import_step_artifacts.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/domain/test_import_workflow.py`
- Criar: `apps/backend/ingestion-data/tests/unit/adapters/test_import_step_receipts.py`
- Criar: `apps/backend/ingestion-data/tests/unit/adapters/test_s3_import_step_artifacts.py`
- Modificar: `apps/backend/ingestion-data/tests/contracts/test_port_contracts.py`

**1. Escreva o contrato e testes que falham**

```python
class ImportWorkflowStage(StrEnum):
    PREPARE_ARCHIVE = "PREPARE_ARCHIVE"
    BUILD_PROJECTIONS = "BUILD_PROJECTIONS"
    VERIFY_PUBLISH_CANDIDATE = "VERIFY_PUBLISH_CANDIDATE"

@dataclass(frozen=True, slots=True)
class StepReceipt:
    import_id: str
    workflow_version: str
    stage: ImportWorkflowStage
    input_fingerprint: str
    status: Literal["RUNNING", "SUCCEEDED", "FAILED"]
    owner_token: str
    lease_expires_at: datetime
    execution_attempt: int
    stage_attempt: int
    completed_by_execution_attempt: int | None
    completed_by_stage_attempt: int | None
    output_reference: str | None
    error_code: str | None
    retryable: bool | None
```

Chaves:

```text
pk = IMPORT_WORKFLOW#<importId>
sk = STEP#v1#<stage>
```

Não inclua `executionAttempt` nem `stageAttempt` na chave; tentativas posteriores precisam reutilizar sucesso anterior.

Testes obrigatórios: claim ausente, replay de `SUCCEEDED`, renovação pelo mesmo owner, reclaim após lease expirado, fence contra owner antigo, reclaim de `FAILED` retryable com `stageAttempt` maior dentro do mesmo `executionAttempt`, reclaim numa nova execução, rejeição de attempt igual/menor por outro owner, fingerprint divergente terminal, complete após perda de ACK e falha que preserva output já confirmado. Se um claim encontrar receipt `SUCCEEDED` com fingerprint incompatível, um CAS troca o status para `FAILED`, `retryable=false` e código terminal, preservando `output_reference`; só então o worker sai diferente de zero. Assim `taskFailure` nunca pode ser mascarado por um `SUCCEEDED` antigo quando a ASL reler o item. Um receipt `RUNNING` vivo nunca é roubado; um `FAILED` terminal nunca é reclamado.

Crie também `ImportStepArtifactStore`. Ele persiste JSON canônico content-addressed em `workflow/imports/<importId>/<workflowVersion>/<stage>/<inputFingerprint>.json`, com `If-None-Match: *`, checksum e `ExpectedBucketOwner`. O artefato de `PREPARE_ARCHIVE` referencia o marker canônico; o de `BUILD_PROJECTIONS` contém dataset version, marker key/digest, quatro famílias, revisões/digests e contagens; o de `VERIFY_PUBLISH_CANDIDATE` referencia o candidato publicado. O receipt só recebe a key e o digest desse artefato. Replay com bytes diferentes para a mesma key é terminal.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_import_workflow.py tests/unit/adapters/test_import_step_receipts.py tests/unit/adapters/test_s3_import_step_artifacts.py tests/contracts/test_port_contracts.py -q
```

**3. Implemente com CAS**

Use `UpdateItem`/`TransactWriteItems` condicionais, nunca `Scan`. `output_reference` é uma key interna validada, não URL. TTL não pode expirar um receipt antes da retenção máxima da importação. `claim()` recebe explicitamente `execution_attempt`, `stage_attempt` e `owner_token`; nenhum deles é inferido do relógio. Persista `lease_expires_at` em UTC RFC3339 terminado em `Z`, com segundos inteiros, para que Choice/Wait da Step Functions comparem o mesmo instante sem truncamento ambíguo.

**4. Confirme o GREEN e commit**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_import_workflow.py tests/unit/adapters/test_import_step_receipts.py tests/unit/adapters/test_s3_import_step_artifacts.py tests/contracts/test_port_contracts.py -q
cd ../../..
git add -- apps/backend/ingestion-data/domain/import_workflow.py apps/backend/ingestion-data/ports/contracts.py apps/backend/ingestion-data/ports/__init__.py apps/backend/ingestion-data/adapters/dynamodb/import_step_receipts.py apps/backend/ingestion-data/adapters/archive/s3_import_step_artifacts.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/domain/test_import_workflow.py apps/backend/ingestion-data/tests/unit/adapters/test_import_step_receipts.py apps/backend/ingestion-data/tests/unit/adapters/test_s3_import_step_artifacts.py apps/backend/ingestion-data/tests/contracts/test_port_contracts.py
git diff --cached --name-only
git commit -m "feat(ingestion): persist idempotent import step receipts"
```

---

### Tarefa 5: extrair três comandos que só se comunicam por estado durável

**Arquivos:**

- Criar: `apps/backend/ingestion-data/application/import_steps.py`
- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/application/import_dump.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/cli.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/config.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/application/test_import_steps.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_import_dump.py`
- Modificar: `apps/backend/ingestion-data/tests/integration/test_cli.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py`

**1. Escreva os testes que falham**

Comandos allowlisted:

```text
prepare-archive --import-id "$IMPORT_ID" --execution-attempt "$EXECUTION_ATTEMPT" --stage-attempt "$STAGE_ATTEMPT"
build-projections --import-id "$IMPORT_ID" --execution-attempt "$EXECUTION_ATTEMPT" --stage-attempt "$STAGE_ATTEMPT"
verify-publish-candidate --import-id "$IMPORT_ID" --execution-attempt "$EXECUTION_ATTEMPT" --stage-attempt "$STAGE_ATTEMPT"
```

`WORKFLOW_OWNER_TOKEN` vem do override de ambiente da state machine e é validado como identificador opaco; não aceite owner informado pelo usuário/API.

Não aceite bucket, chave S3, ARN ou dataset version arbitrários no CLI; resolva tudo pelo import e pelos manifests duráveis.

Responsabilidades:

- `prepare-archive`: valida/promove dump, restaura MySQL, executa preflight, extrai, publica partições e confirma `CanonicalSet`;
- `build-projections`: exige `CanonicalSet` confirmado, lê S3, persiste as quatro famílias e grava o artefato durável `BUILD_PROJECTIONS` antes de completar o receipt;
- `verify-publish-candidate`: carrega e valida marker + artefato de projeções pelos output references dos receipts, reconcilia source/canonical/projeções, grava candidate manifest e leva o import a `READY`, sem ativá-lo.

Cada comando: claim receipt com execution/stage attempt, retorna imediatamente em sucesso compatível, renova lease, completa receipt só após efeito durável e persiste falha segura no receipt antes de sair diferente de zero. Em Step Functions, uma falha retryable atualiza progresso/tentativa, mas não torna o `RunState`/import terminal antes de o orquestrador esgotar `stageAttempt`; no executor sequencial legado, o mesmo erro continua terminalizando como hoje.

Teste crítico: rode cada comando com um diretório temporário diferente. As etapas 2/3 devem concluir mesmo que o diretório da etapa 1 tenha sido apagado.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_import_steps.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/integration/test_cli.py tests/resilience/test_idempotent_backfill.py -q
```

**3. Faça a extração sem duplicar regra**

Transforme o `Backfill` atual em composição das mesmas operações usadas pelos steps; o caminho legado `import-dump` continua chamando as três sequencialmente. Não mantenha duas implementações de reconciliação/candidato.

Use `workflow_version="v1"` no fingerprint junto com source SHA, contrato físico/canônico e pipeline version. Um novo deploy incompatível deve criar `v2`, nunca reinterpretar receipt v1.

**4. Confirme o GREEN e commit**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_import_steps.py tests/unit/application/test_backfill.py tests/unit/application/test_import_dump.py tests/integration/test_cli.py tests/resilience/test_idempotent_backfill.py -q
cd ../../..
git add -- apps/backend/ingestion-data/application/import_steps.py apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/application/import_dump.py apps/backend/ingestion-data/bootstrap/cli.py apps/backend/ingestion-data/bootstrap/config.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/application/test_import_steps.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/unit/application/test_import_dump.py apps/backend/ingestion-data/tests/integration/test_cli.py apps/backend/ingestion-data/tests/resilience/test_idempotent_backfill.py
git diff --cached --name-only
git commit -m "refactor(ingestion): split import into durable steps"
```

---

### Tarefa 6: persistir orquestração e iniciar Step Functions pela API

**Arquivos:**

- Criar: `apps/backend/api/src/modules/imports/ports/import-orchestrator.ts`
- Criar: `apps/backend/api/src/modules/imports/adapters/step-functions-import-orchestrator.ts`
- Modificar: `apps/backend/api/src/modules/imports/domain/import.ts`
- Modificar: `apps/backend/api/src/modules/imports/ports/import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/application/import-reconciler.ts`
- Modificar: `apps/backend/api/src/modules/imports/application/import-use-cases.ts`
- Modificar: `apps/backend/api/src/modules/imports/adapters/ecs-import-worker-launcher.ts`
- Modificar: `apps/backend/api/src/modules/imports/index.ts`
- Modificar: `apps/backend/api/src/config.ts`
- Modificar: `apps/backend/api/package.json`
- Modificar: `apps/backend/api/package-lock.json`
- Criar: `apps/backend/api/tests/import-orchestrator.test.ts`
- Modificar: `apps/backend/api/tests/import-domain.test.ts`
- Modificar: `apps/backend/api/tests/import-repository.test.ts`
- Modificar: `apps/backend/api/tests/import-reconciler.test.ts`
- Modificar: `apps/backend/api/tests/import-use-cases.test.ts`
- Modificar: `apps/backend/api/tests/import-worker-launcher.test.ts`

**1. Escreva os testes que falham**

Interface:

```ts
type ImportExecutionStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "ABORTED";

interface ImportOrchestrator {
  start(input: {
    importId: string;
    executionAttempt: number;
    executionName: string;
    processingRunId: string;
    workflowVersion: "v1";
  }): Promise<{ executionArn: string; startedAt: string }>;
  describe(executionArn: string): Promise<{
    status: ImportExecutionStatus;
    startedAt: string;
    stoppedAt?: string;
  }>;
}
```

Não adicione estes campos ao item `IMPORT#...`, porque o decoder Python é fechado. Persista um item separado:

```ts
pk = IMPORT_WORKFLOW#<importId>
sk = EXECUTION
orchestrationMode = LEGACY_ECS | STEP_FUNCTIONS_V1
executionAttempt = 1..N
processingRunId = run_<importId>-a<N>
executionName = <importId>-a<N>
executionArn = opcional
executionStatus = QUEUED | RUNNING | SUCCEEDED | FAILED | TIMED_OUT | ABORTED
executionStartedAt / executionStoppedAt = opcionais
version = inteiro de CAS
```

Na criação da importação, grave esse item com `executionAttempt=1`, `processingRunId=run_<importId>-a1`, nome correspondente e modo derivado da flag; ausência em registros antigos significa legacy attempt 1 e é migrada por CAS antes de lançar. O reconciliador nunca incrementa tentativa: ele só inicia uma tentativa `QUEUED` já reservada e anexa ARN/status. Teste criação, migração legacy, attach do ARN, recuperação de ACK perdido, corrida de reconciliadores, workflow `SUCCEEDED` sem import `READY` e falhas/timed out/aborted que só escrevem fallback genérico se o worker ainda não persistiu causa específica. No fallback ECS, passe `clientToken=<importId>-a<N>` e `RUN_ID=run_<importId>-a<N>` para nunca adotar a task/run terminal anterior.

**2. Confirme o RED**

```bash
cd apps/backend/api
npm test -- tests/import-orchestrator.test.ts tests/import-domain.test.ts tests/import-repository.test.ts tests/import-reconciler.test.ts tests/import-use-cases.test.ts tests/import-worker-launcher.test.ts
```

**3. Implemente o adaptador**

Adicione a dependência e preserve o lockfile:

```bash
cd apps/backend/api
npm install --save-exact @aws-sdk/client-sfn@3.1128.0
```

Configure:

```text
IMPORT_STEP_FUNCTIONS_ENABLED=false|true
IMPORT_STATE_MACHINE_ARN é ausente quando false e recebe exatamente o output Terraform quando true
```

Nome: `<importId>-a<executionAttempt>`, validado no domínio. O ARN de execution é derivável do ARN da state machine e do nome: após ACK perdido, faça `DescribeExecution` nesse ARN antes de repetir `StartExecution`; se a execução já terminou, adote seu resultado em vez de tratar `ExecutionAlreadyExists` como nova falha. Não exponha ARN/nome na resposta pública. O modo já foi gravado na criação; alterar a flag não migra item existente. Preserve o launcher ECS até drenar registros legacy.

**4. Confirme o GREEN e commit**

```bash
cd apps/backend/api
npm test -- tests/import-orchestrator.test.ts tests/import-domain.test.ts tests/import-repository.test.ts tests/import-reconciler.test.ts tests/import-use-cases.test.ts tests/import-worker-launcher.test.ts
npm run typecheck
cd ../../..
git add -- apps/backend/api/package.json apps/backend/api/package-lock.json apps/backend/api/src/config.ts apps/backend/api/src/modules/imports/ports/import-orchestrator.ts apps/backend/api/src/modules/imports/adapters/step-functions-import-orchestrator.ts apps/backend/api/src/modules/imports/domain/import.ts apps/backend/api/src/modules/imports/ports/import-repository.ts apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts apps/backend/api/src/modules/imports/application/import-reconciler.ts apps/backend/api/src/modules/imports/application/import-use-cases.ts apps/backend/api/src/modules/imports/adapters/ecs-import-worker-launcher.ts apps/backend/api/src/modules/imports/index.ts apps/backend/api/tests/import-orchestrator.test.ts apps/backend/api/tests/import-domain.test.ts apps/backend/api/tests/import-repository.test.ts apps/backend/api/tests/import-reconciler.test.ts apps/backend/api/tests/import-use-cases.test.ts apps/backend/api/tests/import-worker-launcher.test.ts
git diff --cached --name-only
git commit -m "feat(imports): orchestrate processing with step functions"
```

---

### Tarefa 7: adicionar retry idempotente do processamento

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/domain/import_job.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/domain/test_import_job.py`
- Modificar: `apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json`
- Modificar: `apps/backend/api/contracts/src/index.ts`
- Modificar: `apps/backend/api/contracts/openapi/public.openapi.json`
- Modificar: `apps/backend/api/src/http/public-routes.ts`
- Modificar: `apps/backend/api/src/app.ts`
- Modificar: `apps/backend/api/src/modules/imports/ports/import-control.ts`
- Modificar: `apps/backend/api/src/modules/imports/ports/import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts`
- Modificar: `apps/backend/api/src/modules/imports/application/import-use-cases.ts`
- Modificar: `apps/backend/api/tests/contracts.test.ts`
- Modificar: `apps/backend/api/tests/import-use-cases.test.ts`
- Modificar: `apps/backend/api/tests/import-repository.test.ts`
- Modificar: `apps/backend/api/tests/import-flow.integration.test.ts`
- Modificar: `apps/backend/api/tests/import-python-fixture.test.ts`
- Modificar: `apps/frontend/lib/imports/types.ts`
- Modificar: `apps/frontend/lib/imports/types.test.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.test.ts`

**1. Escreva os testes que falham**

Contrato:

```http
POST /api/v1/imports/{importId}/retry
Idempotency-Key: import-processing-retry-550e8400-e29b-41d4-a716-446655440000
Body: {}
Response: 202 ImportSnapshot
```

Regras:

- exige autenticação, mas nesta fase qualquer usuário autenticado pode solicitar retry;
- somente `FAILED` com `error.retryable=true` e artefato físico ainda existente;
- mantém `importId`, checksum, physical version e dataset version;
- incrementa `executionAttempt` uma vez no item `IMPORT_WORKFLOW#.../EXECUTION`, cria `processingRunId=run_<importId>-a<N>` e `executionName=<importId>-a<N>`;
- na mesma transação, reabre para `UPLOADED`, limpa somente erro/progresso/task ARN/estado da execução anterior, põe `executionStatus=QUEUED` e adquire o lock global; o reconciliador apenas inicia a tentativa reservada;
- mesma idempotency key retorna o mesmo snapshot;
- duas chaves concorrentes produzem no máximo uma nova tentativa;
- outro import ativo retorna conflito sem consumir os artefatos;
- falha terminal não oferece retry;
- `/restart` de upload permanece inalterado.

Adicione `ORCHESTRATION_FAILED` e `WORKER_TIMEOUT` às enumerações Python/TypeScript/OpenAPI/frontend como retryable e preserve os códigos anteriores. Use `WORKER_TIMEOUT` quando a task/lease expira e `ORCHESTRATION_FAILED` quando a execução falha sem causa específica ou termina `SUCCEEDED` sem o import alcançar `READY`. Edite o contrato TypeScript e o JSON OpenAPI juntos; não há gerador.

Use marker `IMPORT_PROCESSING_RETRY#<HMAC(importId,idempotencyKey)>`; nunca grave a chave bruta.

**2. Confirme o RED, implemente e confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/domain/test_import_job.py -q
cd ../api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-use-cases.test.ts tests/import-repository.test.ts tests/import-flow.integration.test.ts tests/import-python-fixture.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts
```

**3. Commit**

```bash
git add -- apps/backend/ingestion-data/domain/import_job.py apps/backend/ingestion-data/tests/unit/domain/test_import_job.py apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json apps/backend/api/contracts/src/index.ts apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/src/http/public-routes.ts apps/backend/api/src/app.ts apps/backend/api/src/modules/imports/ports/import-control.ts apps/backend/api/src/modules/imports/ports/import-repository.ts apps/backend/api/src/modules/imports/adapters/dynamodb-import-repository.ts apps/backend/api/src/modules/imports/application/import-use-cases.ts apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/import-use-cases.test.ts apps/backend/api/tests/import-repository.test.ts apps/backend/api/tests/import-flow.integration.test.ts apps/backend/api/tests/import-python-fixture.test.ts apps/frontend/lib/imports/types.ts apps/frontend/lib/imports/types.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts
git diff --cached --name-only
git commit -m "feat(imports): retry failed processing without reupload"
```

---

### Tarefa 8: criar a state machine, task definitions e IAM mínimo

**Arquivos:**

- Criar: `apps/fullstack/ingestion-import.asl.json.tftpl`
- Criar: `apps/fullstack/ingestion-import-orchestration.tf`
- Modificar: `apps/fullstack/ingestion-ecs.tf`
- Modificar: `apps/fullstack/ingestion-imports.tf`
- Modificar: `apps/fullstack/ecs.tf`
- Modificar: `apps/fullstack/ingestion-variables.tf`
- Modificar: `apps/fullstack/ingestion-observability.tf`
- Modificar: `apps/fullstack/outputs.tf`
- Modificar: `apps/fullstack/tests/ingestion_defaults.tftest.hcl`
- Modificar: `apps/fullstack/tests/ingestion_production.tftest.hcl`
- Modificar: `apps/backend/api/tests/ci/fullstack-iac-policy.test.js`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Modificar: `scripts/ci/validate-terraform-learner-update-plan.mjs`
- Modificar: `scripts/tests/validate-terraform-learner-update-plan.test.mjs`

**1. Escreva os testes IaC/policy que falham**

Fluxo lógico de cada uma das três etapas:

```text
InitStageAttempt(1)
  -> RunEcsStage
  -> GetReceipt(consistent)
  -> ChoiceReceipt
       SUCCEEDED -------------------------------> próxima etapa
       RUNNING com lease vivo -> WaitUntilLease -> GetReceipt
       RUNNING expirado ------------------------> IncrementStageAttempt
       FAILED retryable ------------------------> IncrementStageAttempt
       receipt ausente após falha --------------> IncrementStageAttempt
       FAILED terminal / tentativa 4 ----------> Fail
  -> Wait15|Wait30|Wait60 -> RunEcsStage

PrepareArchive -> BuildProjections -> VerifyPublishCandidate -> Succeed
```

Cada `RunEcsStage` usa `arn:aws:states:::ecs:runTask.sync`, `ResultPath: null` e recebe somente `importId`, `executionAttempt`, `stageAttempt`, `workflowVersion` e owner token derivado por `States.Format` de `$$.Execution.Id`, etapa e tentativa. Cada `GetReceipt` usa `arn:aws:states:::dynamodb:getItem`, `ConsistentRead=true` e a chave exata do receipt; não use Scan nem Lambda intermediária. O lease inicial é 120 segundos e o worker renova a cada 30 segundos.

Defaults parametrizados:

| etapa | timeout |
|---|---:|
| workflow | 129.600 s |
| prepare-archive | 21.600 s |
| build-projections | 3.600 s |
| verify-publish-candidate | 900 s |

O único `Retry` nativo do estado ECS usa `ErrorEquals=["AmazonECS.Unknown"]`, `IntervalSeconds=15`, `BackoffRate=2`, `MaxAttempts=2`, `MaxDelaySeconds=300`, `JitterStrategy=FULL`; a integração otimizada usa esse erro quando `RunTask` devolve `Failures` antes de iniciar o container. `States.TaskFailed`, `States.Timeout` e `States.ALL` não entram no Retry: todos vão por `Catch` para `GetReceipt`. O retry da aplicação é decidido pelo receipt como no grafo, com no máximo quatro `stageAttempt` e waits exatos de 15, 30 e 60 segundos. O teto global de 36 horas comporta quatro timeouts completos das três etapas mais retries/leases; é um limite de segurança, não substitui o alarme/SLO de duas horas. Ao esgotar, `Fail` deixa o reconciliador escrever `WORKER_TIMEOUT`/`ORCHESTRATION_FAILED` somente se não houver causa específica e liberar o lock pela transação existente.

Implemente o template ASL completo abaixo; os placeholders são preenchidos somente por templatefile, e o teste decodifica o JSON renderizado e compara estados, transições e recursos. Não substitua o fluxo por pseudocódigo nem adicione retry genérico:

~~~~json
{
  "Comment": "ARGUS import workflow v1",
  "StartAt": "ValidateInput",
  "TimeoutSeconds": 129600,
  "States": {
    "ValidateInput": {
      "Type": "Choice",
      "Choices": [{
        "And": [
          {"Variable": "$.importId", "IsPresent": true},
          {"Variable": "$.importId", "IsString": true},
          {"Variable": "$.executionAttempt", "IsPresent": true},
          {"Variable": "$.executionAttempt", "NumericGreaterThanEquals": 1},
          {"Variable": "$.processingRunId", "IsPresent": true},
          {"Variable": "$.processingRunId", "IsString": true},
          {"Variable": "$.workflowVersion", "IsPresent": true},
          {"Variable": "$.workflowVersion", "StringEquals": "v1"}
        ],
        "Next": "InitPrepareAttempt"
      }],
      "Default": "InvalidWorkflowInput"
    },
    "InvalidWorkflowInput": {"Type": "Fail", "Error": "InvalidWorkflowInput", "Cause": "Expected the validated v1 workflow input."},
    "InitPrepareAttempt": {
      "Type": "Pass",
      "Parameters": {
        "importId.$": "$.importId",
        "executionAttempt.$": "$.executionAttempt",
        "processingRunId.$": "$.processingRunId",
        "workflowVersion.$": "$.workflowVersion",
        "stageAttempt": 1
      },
      "Next": "RunPrepareArchive"
    },
    "RunPrepareArchive": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 21600,
      "ResultPath": null,
      "Parameters": {
        "Cluster": "${cluster_arn}",
        "TaskDefinition": "${prepare_task_definition_arn}",
        "LaunchType": "FARGATE",
        "NetworkConfiguration": {
          "AwsvpcConfiguration": {
            "Subnets": ${subnet_ids_json},
            "SecurityGroups": ${security_group_ids_json},
            "AssignPublicIp": "DISABLED"
          }
        },
        "Overrides": {
          "ContainerOverrides": [{
            "Name": "${ingestion_container_name}",
            "Command.$": "States.Array('prepare-archive','--import-id',$.importId,'--execution-attempt',States.Format('{}',$.executionAttempt),'--stage-attempt',States.Format('{}',$.stageAttempt))",
            "Environment": [
              {"Name": "PROCESSING_RUN_ID", "Value.$": "$.processingRunId"},
              {"Name": "WORKFLOW_VERSION", "Value.$": "$.workflowVersion"},
              {"Name": "WORKFLOW_OWNER_TOKEN", "Value.$": "States.Format('{}#PREPARE_ARCHIVE#{}', $$.Execution.Id, $.stageAttempt)"}
            ]
          }]
        }
      },
      "Retry": [{
        "ErrorEquals": ["AmazonECS.Unknown"],
        "IntervalSeconds": 15,
        "BackoffRate": 2,
        "MaxAttempts": 2,
        "MaxDelaySeconds": 300,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.taskFailure", "Next": "GetPrepareReceipt"}],
      "Next": "GetPrepareReceipt"
    },
    "GetPrepareReceipt": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:getItem",
      "ResultPath": "$.receipt",
      "Parameters": {
        "TableName": "${operational_table_name}",
        "ConsistentRead": true,
        "Key": {
          "pk": {"S.$": "States.Format('IMPORT_WORKFLOW#{}', $.importId)"},
          "sk": {"S": "STEP#v1#PREPARE_ARCHIVE"}
        }
      },
      "Retry": [{
        "ErrorEquals": ["DynamoDB.ProvisionedThroughputExceededException", "DynamoDB.ThrottlingException", "DynamoDB.RequestLimitExceeded", "DynamoDB.InternalServerError", "States.Timeout"],
        "IntervalSeconds": 2,
        "BackoffRate": 2,
        "MaxAttempts": 6,
        "MaxDelaySeconds": 30,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "PrepareFailed"}],
      "Next": "ChoosePrepareReceipt"
    },
    "ChoosePrepareReceipt": {
      "Type": "Choice",
      "Choices": [
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "SUCCEEDED"}
          ],
          "Next": "InitProjectionAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampGreaterThanPath": "$$.State.EnteredTime"}
          ],
          "Next": "WaitPrepareLease"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampLessThanEqualsPath": "$$.State.EnteredTime"}
          ],
          "Next": "RetryPrepareAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "FAILED"},
            {"Variable": "$.receipt.Item.retryable.BOOL", "IsPresent": true},
            {"Variable": "$.receipt.Item.retryable.BOOL", "BooleanEquals": true}
          ],
          "Next": "RetryPrepareAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item", "IsPresent": false},
            {"Variable": "$.taskFailure", "IsPresent": true}
          ],
          "Next": "RetryPrepareAttempt"
        }
      ],
      "Default": "PrepareFailed"
    },
    "WaitPrepareLease": {"Type": "Wait", "TimestampPath": "$.receipt.Item.leaseExpiresAt.S", "Next": "GetPrepareReceipt"},
    "RetryPrepareAttempt": {
      "Type": "Choice",
      "Choices": [
        {"Variable": "$.stageAttempt", "NumericEquals": 1, "Next": "SetPrepareAttempt2"},
        {"Variable": "$.stageAttempt", "NumericEquals": 2, "Next": "SetPrepareAttempt3"},
        {"Variable": "$.stageAttempt", "NumericEquals": 3, "Next": "SetPrepareAttempt4"}
      ],
      "Default": "PrepareFailed"
    },
    "SetPrepareAttempt2": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 2}, "Next": "WaitPrepare15"},
    "SetPrepareAttempt3": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 3}, "Next": "WaitPrepare30"},
    "SetPrepareAttempt4": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 4}, "Next": "WaitPrepare60"},
    "WaitPrepare15": {"Type": "Wait", "Seconds": 15, "Next": "RunPrepareArchive"},
    "WaitPrepare30": {"Type": "Wait", "Seconds": 30, "Next": "RunPrepareArchive"},
    "WaitPrepare60": {"Type": "Wait", "Seconds": 60, "Next": "RunPrepareArchive"},
    "PrepareFailed": {"Type": "Fail", "Error": "PrepareArchiveFailed", "Cause": "Inspect the durable receipt for the safe public cause."},

    "InitProjectionAttempt": {
      "Type": "Pass",
      "Parameters": {
        "importId.$": "$.importId",
        "executionAttempt.$": "$.executionAttempt",
        "processingRunId.$": "$.processingRunId",
        "workflowVersion.$": "$.workflowVersion",
        "stageAttempt": 1
      },
      "Next": "RunBuildProjections"
    },
    "RunBuildProjections": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 3600,
      "ResultPath": null,
      "Parameters": {
        "Cluster": "${cluster_arn}",
        "TaskDefinition": "${projection_task_definition_arn}",
        "LaunchType": "FARGATE",
        "NetworkConfiguration": {
          "AwsvpcConfiguration": {
            "Subnets": ${subnet_ids_json},
            "SecurityGroups": ${security_group_ids_json},
            "AssignPublicIp": "DISABLED"
          }
        },
        "Overrides": {
          "ContainerOverrides": [{
            "Name": "${ingestion_container_name}",
            "Command.$": "States.Array('build-projections','--import-id',$.importId,'--execution-attempt',States.Format('{}',$.executionAttempt),'--stage-attempt',States.Format('{}',$.stageAttempt))",
            "Environment": [
              {"Name": "PROCESSING_RUN_ID", "Value.$": "$.processingRunId"},
              {"Name": "WORKFLOW_VERSION", "Value.$": "$.workflowVersion"},
              {"Name": "WORKFLOW_OWNER_TOKEN", "Value.$": "States.Format('{}#BUILD_PROJECTIONS#{}', $$.Execution.Id, $.stageAttempt)"}
            ]
          }]
        }
      },
      "Retry": [{
        "ErrorEquals": ["AmazonECS.Unknown"],
        "IntervalSeconds": 15,
        "BackoffRate": 2,
        "MaxAttempts": 2,
        "MaxDelaySeconds": 300,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.taskFailure", "Next": "GetProjectionReceipt"}],
      "Next": "GetProjectionReceipt"
    },
    "GetProjectionReceipt": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:getItem",
      "ResultPath": "$.receipt",
      "Parameters": {
        "TableName": "${operational_table_name}",
        "ConsistentRead": true,
        "Key": {
          "pk": {"S.$": "States.Format('IMPORT_WORKFLOW#{}', $.importId)"},
          "sk": {"S": "STEP#v1#BUILD_PROJECTIONS"}
        }
      },
      "Retry": [{
        "ErrorEquals": ["DynamoDB.ProvisionedThroughputExceededException", "DynamoDB.ThrottlingException", "DynamoDB.RequestLimitExceeded", "DynamoDB.InternalServerError", "States.Timeout"],
        "IntervalSeconds": 2,
        "BackoffRate": 2,
        "MaxAttempts": 6,
        "MaxDelaySeconds": 30,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "ProjectionFailed"}],
      "Next": "ChooseProjectionReceipt"
    },
    "ChooseProjectionReceipt": {
      "Type": "Choice",
      "Choices": [
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "SUCCEEDED"}
          ],
          "Next": "InitVerifyAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampGreaterThanPath": "$$.State.EnteredTime"}
          ],
          "Next": "WaitProjectionLease"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampLessThanEqualsPath": "$$.State.EnteredTime"}
          ],
          "Next": "RetryProjectionAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "FAILED"},
            {"Variable": "$.receipt.Item.retryable.BOOL", "IsPresent": true},
            {"Variable": "$.receipt.Item.retryable.BOOL", "BooleanEquals": true}
          ],
          "Next": "RetryProjectionAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item", "IsPresent": false},
            {"Variable": "$.taskFailure", "IsPresent": true}
          ],
          "Next": "RetryProjectionAttempt"
        }
      ],
      "Default": "ProjectionFailed"
    },
    "WaitProjectionLease": {"Type": "Wait", "TimestampPath": "$.receipt.Item.leaseExpiresAt.S", "Next": "GetProjectionReceipt"},
    "RetryProjectionAttempt": {
      "Type": "Choice",
      "Choices": [
        {"Variable": "$.stageAttempt", "NumericEquals": 1, "Next": "SetProjectionAttempt2"},
        {"Variable": "$.stageAttempt", "NumericEquals": 2, "Next": "SetProjectionAttempt3"},
        {"Variable": "$.stageAttempt", "NumericEquals": 3, "Next": "SetProjectionAttempt4"}
      ],
      "Default": "ProjectionFailed"
    },
    "SetProjectionAttempt2": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 2}, "Next": "WaitProjection15"},
    "SetProjectionAttempt3": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 3}, "Next": "WaitProjection30"},
    "SetProjectionAttempt4": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 4}, "Next": "WaitProjection60"},
    "WaitProjection15": {"Type": "Wait", "Seconds": 15, "Next": "RunBuildProjections"},
    "WaitProjection30": {"Type": "Wait", "Seconds": 30, "Next": "RunBuildProjections"},
    "WaitProjection60": {"Type": "Wait", "Seconds": 60, "Next": "RunBuildProjections"},
    "ProjectionFailed": {"Type": "Fail", "Error": "BuildProjectionsFailed", "Cause": "Inspect the durable receipt for the safe public cause."},

    "InitVerifyAttempt": {
      "Type": "Pass",
      "Parameters": {
        "importId.$": "$.importId",
        "executionAttempt.$": "$.executionAttempt",
        "processingRunId.$": "$.processingRunId",
        "workflowVersion.$": "$.workflowVersion",
        "stageAttempt": 1
      },
      "Next": "RunVerifyCandidate"
    },
    "RunVerifyCandidate": {
      "Type": "Task",
      "Resource": "arn:aws:states:::ecs:runTask.sync",
      "TimeoutSeconds": 900,
      "ResultPath": null,
      "Parameters": {
        "Cluster": "${cluster_arn}",
        "TaskDefinition": "${verify_task_definition_arn}",
        "LaunchType": "FARGATE",
        "NetworkConfiguration": {
          "AwsvpcConfiguration": {
            "Subnets": ${subnet_ids_json},
            "SecurityGroups": ${security_group_ids_json},
            "AssignPublicIp": "DISABLED"
          }
        },
        "Overrides": {
          "ContainerOverrides": [{
            "Name": "${ingestion_container_name}",
            "Command.$": "States.Array('verify-publish-candidate','--import-id',$.importId,'--execution-attempt',States.Format('{}',$.executionAttempt),'--stage-attempt',States.Format('{}',$.stageAttempt))",
            "Environment": [
              {"Name": "PROCESSING_RUN_ID", "Value.$": "$.processingRunId"},
              {"Name": "WORKFLOW_VERSION", "Value.$": "$.workflowVersion"},
              {"Name": "WORKFLOW_OWNER_TOKEN", "Value.$": "States.Format('{}#VERIFY_PUBLISH_CANDIDATE#{}', $$.Execution.Id, $.stageAttempt)"}
            ]
          }]
        }
      },
      "Retry": [{
        "ErrorEquals": ["AmazonECS.Unknown"],
        "IntervalSeconds": 15,
        "BackoffRate": 2,
        "MaxAttempts": 2,
        "MaxDelaySeconds": 300,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "ResultPath": "$.taskFailure", "Next": "GetVerifyReceipt"}],
      "Next": "GetVerifyReceipt"
    },
    "GetVerifyReceipt": {
      "Type": "Task",
      "Resource": "arn:aws:states:::dynamodb:getItem",
      "ResultPath": "$.receipt",
      "Parameters": {
        "TableName": "${operational_table_name}",
        "ConsistentRead": true,
        "Key": {
          "pk": {"S.$": "States.Format('IMPORT_WORKFLOW#{}', $.importId)"},
          "sk": {"S": "STEP#v1#VERIFY_PUBLISH_CANDIDATE"}
        }
      },
      "Retry": [{
        "ErrorEquals": ["DynamoDB.ProvisionedThroughputExceededException", "DynamoDB.ThrottlingException", "DynamoDB.RequestLimitExceeded", "DynamoDB.InternalServerError", "States.Timeout"],
        "IntervalSeconds": 2,
        "BackoffRate": 2,
        "MaxAttempts": 6,
        "MaxDelaySeconds": 30,
        "JitterStrategy": "FULL"
      }],
      "Catch": [{"ErrorEquals": ["States.ALL"], "Next": "VerifyFailed"}],
      "Next": "ChooseVerifyReceipt"
    },
    "ChooseVerifyReceipt": {
      "Type": "Choice",
      "Choices": [
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "SUCCEEDED"}
          ],
          "Next": "WorkflowSucceeded"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampGreaterThanPath": "$$.State.EnteredTime"}
          ],
          "Next": "WaitVerifyLease"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "RUNNING"},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.leaseExpiresAt.S", "TimestampLessThanEqualsPath": "$$.State.EnteredTime"}
          ],
          "Next": "RetryVerifyAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item.status.S", "IsPresent": true},
            {"Variable": "$.receipt.Item.status.S", "StringEquals": "FAILED"},
            {"Variable": "$.receipt.Item.retryable.BOOL", "IsPresent": true},
            {"Variable": "$.receipt.Item.retryable.BOOL", "BooleanEquals": true}
          ],
          "Next": "RetryVerifyAttempt"
        },
        {
          "And": [
            {"Variable": "$.receipt.Item", "IsPresent": false},
            {"Variable": "$.taskFailure", "IsPresent": true}
          ],
          "Next": "RetryVerifyAttempt"
        }
      ],
      "Default": "VerifyFailed"
    },
    "WaitVerifyLease": {"Type": "Wait", "TimestampPath": "$.receipt.Item.leaseExpiresAt.S", "Next": "GetVerifyReceipt"},
    "RetryVerifyAttempt": {
      "Type": "Choice",
      "Choices": [
        {"Variable": "$.stageAttempt", "NumericEquals": 1, "Next": "SetVerifyAttempt2"},
        {"Variable": "$.stageAttempt", "NumericEquals": 2, "Next": "SetVerifyAttempt3"},
        {"Variable": "$.stageAttempt", "NumericEquals": 3, "Next": "SetVerifyAttempt4"}
      ],
      "Default": "VerifyFailed"
    },
    "SetVerifyAttempt2": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 2}, "Next": "WaitVerify15"},
    "SetVerifyAttempt3": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 3}, "Next": "WaitVerify30"},
    "SetVerifyAttempt4": {"Type": "Pass", "Parameters": {"importId.$": "$.importId", "executionAttempt.$": "$.executionAttempt", "processingRunId.$": "$.processingRunId", "workflowVersion.$": "$.workflowVersion", "stageAttempt": 4}, "Next": "WaitVerify60"},
    "WaitVerify15": {"Type": "Wait", "Seconds": 15, "Next": "RunVerifyCandidate"},
    "WaitVerify30": {"Type": "Wait", "Seconds": 30, "Next": "RunVerifyCandidate"},
    "WaitVerify60": {"Type": "Wait", "Seconds": 60, "Next": "RunVerifyCandidate"},
    "VerifyFailed": {"Type": "Fail", "Error": "VerifyCandidateFailed", "Cause": "Inspect the durable receipt for the safe public cause."},
    "WorkflowSucceeded": {"Type": "Succeed"}
  }
}
~~~~

No caller da API, construa o input inicial com exatamente `importId`, `executionAttempt`, `processingRunId` e `workflowVersion=v1`, e prove isso por teste de contrato. `ValidateInput` exige presença, tipo e versão desses campos; como Choice não rejeita genericamente propriedades desconhecidas, cada `Init*Attempt` reconstrói o payload permitido e descarta qualquer campo extra, além de remover `receipt`/`taskFailure` da etapa anterior. Valide também que todo caminho terminal está alcançável. `Wait*Lease` usa o timestamp ISO do receipt antes de incrementar a tentativa, evitando roubar lease vivo.

**2. Modele tasks separadas**

- `prepare-archive`: 2 vCPU, 8 GiB, imagem de ingestão + sidecar MySQL e 200 GiB efêmeros;
- `build-projections`: 2 vCPU, 4 GiB, mesma imagem sem MySQL e 20 GiB efêmeros;
- `verify-publish-candidate`: 0,5 vCPU, 1 GiB, mesma imagem sem MySQL e 20 GiB efêmeros.

Não use Map/Distributed Map na v1. A concorrência interna de até quatro datasets/partições continua no `prepare-archive` e só aumenta depois de benchmark.

**3. Restrinja IAM**

API: `states:StartExecution` no state machine exato e `states:DescribeExecution` nos execution ARNs esperados. Mantenha `ecs:RunTask`/`iam:PassRole` apenas enquanto legacy existir.

Role Step Functions: `ecs:RunTask` nas task definitions exatas; `ecs:StopTask`/`ecs:DescribeTasks` em `*` somente porque a integração `.sync` exige e só consegue parar tasks que ela própria iniciou; EventBridge somente em `StepFunctionsGetEventsForECSTaskRule`; `dynamodb:GetItem` somente na tabela operacional; `iam:PassRole` somente nas roles das tasks. Para o log delivery gerenciado, inclua explicitamente `logs:CreateLogDelivery`, `logs:GetLogDelivery`, `logs:UpdateLogDelivery`, `logs:DeleteLogDelivery`, `logs:ListLogDeliveries`, `logs:PutResourcePolicy`, `logs:DescribeResourcePolicies`, `logs:DescribeLogGroups`, `logs:CreateLogStream` e `logs:PutLogEvents` com `Resource = "*"`, conforme a limitação dessas APIs; os testes de policy rejeitam qualquer outra ação ampla. Em produção, role própria; no Learner Lab, reutilize `LabRole` apenas no branch explícito `ambiente=learner-lab`, porque a policy do laboratório não permite criar/passar uma role própria.

Liste explicitamente `events:PutTargets`, `events:PutRule` e `events:DescribeRule` para a rule gerenciada `StepFunctionsGetEventsForECSTaskRule`. Em produção, mantenha roles de task separadas: prepare pode ler o dump/secret e publicar o conjunto canônico; projections pode apenas ler o marker/Parquet e escrever projeções/artefato/receipt; verify pode ler evidências e escrever candidato/receipt, sem secret MySQL nem escrita de fatos. Nenhuma role recebe `s3:*` ou `dynamodb:*`. No Learner Lab, onde `LabRole` é obrigatória, os testes ainda validam que os containers 2/3 não recebem secret ARN nem configuração MySQL.

**4. Logging e feature flag**

Crie log group `/aws/vendedlogs/states/${var.deployment_namespace}-import`, com criptografia gerenciada pelo serviço e retenção de 14 dias no Learner Lab/30 em produção. Desabilite inclusão do execution input/output completo. Separe `ingestion_import_orchestration_resources_enabled` (cria recursos) de `import_step_functions_enabled` (flag enviada à API); ambos começam `false`. O preset infra cria a state machine com a flag da API ainda desligada.

Estenda o wrapper com `plan-update <preset>` (somente init/plan/show/validator, nunca apply) e com presets `phase3-infra-2000|5000|10000`, `phase3-canary-2000|5000|10000`. O primeiro grupo cria state machine/tasks/logs mantendo runtime legacy; o segundo liga Step Functions apenas para imports novos. A allowlist adiciona exatamente `aws_ecs_task_definition.ingestion_import_prepare`, `aws_ecs_task_definition.ingestion_import_projections`, `aws_ecs_task_definition.ingestion_import_verify`, `aws_sfn_state_machine.ingestion_import`, `aws_cloudwatch_log_group.ingestion_import_workflow`, os seis alarmes nomeados na tarefa 10 e, no branch de produção, `aws_iam_role.ingestion_import_workflow[0]`, `aws_iam_role.ingestion_import_projection[0]`, `aws_iam_role.ingestion_import_verify[0]`, `aws_iam_role_policy.ingestion_import_workflow[0]`, `aws_iam_role_policy.ingestion_import_projection[0]`, `aws_iam_role_policy.ingestion_import_verify[0]` e `aws_iam_role_policy.api_import_orchestration[0]`; no Learner Lab esses endereços IAM precisam estar ausentes porque `LabRole` é reutilizada. A confirmação de `update` continua contendo account ID; `plan-update` não pede confirmação nem muta AWS. Continue rejeitando deletes, moves, mudança de provider ou qualquer recurso de rede/stateful.

**5. Valide**

```bash
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack validate
terraform -chdir=apps/fullstack test
npm --prefix apps/backend/api run test:ci-policy
node --test scripts/tests/aws-learner-lab.test.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
```

**6. Commit**

```bash
git add -- apps/fullstack/ingestion-import.asl.json.tftpl apps/fullstack/ingestion-import-orchestration.tf apps/fullstack/ingestion-ecs.tf apps/fullstack/ingestion-imports.tf apps/fullstack/ecs.tf apps/fullstack/ingestion-variables.tf apps/fullstack/ingestion-observability.tf apps/fullstack/outputs.tf apps/fullstack/tests/ingestion_defaults.tftest.hcl apps/fullstack/tests/ingestion_production.tftest.hcl apps/backend/api/tests/ci/fullstack-iac-policy.test.js scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs scripts/ci/validate-terraform-learner-update-plan.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
git diff --cached --name-only
git commit -m "infra(imports): add durable step functions workflow"
```

---

### Tarefa 9: apresentar progresso, estagnação e retry na interface

**Arquivos:**

- Modificar: `apps/frontend/lib/data/endpoints.ts`
- Modificar: `apps/frontend/lib/imports/client.ts`
- Modificar: `apps/frontend/lib/imports/client.test.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.ts`
- Modificar: `apps/frontend/components/imports/import-presentation.test.ts`
- Modificar: `apps/frontend/components/imports/import-status-card.tsx`
- Modificar: `apps/frontend/components/imports/import-status-card.test.tsx`
- Modificar: `apps/frontend/components/imports/import-upload-provider.tsx`
- Modificar: `apps/frontend/components/imports/import-upload-provider.test.tsx`
- Modificar: `apps/frontend/app/(painel)/dados/importacoes/imports-view.tsx`
- Modificar: `apps/frontend/app/(painel)/dados/importacoes/imports-view.integration.test.tsx`

**1. Leia a documentação Next.js local relevante**

Leia estes arquivos locais, além dos quatro da tarefa 1, e registre-os no commit body:

```text
node_modules/next/dist/docs/01-app/02-guides/forms.md
node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md
node_modules/next/dist/docs/01-app/01-getting-started/06-fetching-data.md
```

**2. Escreva os testes de comportamento que falham**

O card deve mostrar:

- etapa e subetapa em linguagem humana;
- dataset e partição atuais quando presentes;
- `lidos / total`, percentual e barra determinada somente quando total existe;
- barra indeterminada + `unidades concluídas / total` para restore/indexação/archive;
- taxa `registros/s` e ETA somente quando não nulos;
- “Worker ativo; última atividade …” com heartbeat recente;
- “Sem avanço há …” quando `lastProgressAt` excede 2 minutos, mesmo com heartbeat vivo;
- “Tentativa 2 de 4; reconectando ao MySQL” durante retry;
- `aria-live="polite"` que não anuncia cada heartbeat;
- estado `FAILED` retryable com botão “Tentar processamento novamente”;
- falha terminal sem botão;
- upload em falha continua oferecendo “Reiniciar upload”, sem confundir ações.

**3. Implemente client/provider**

Adicione endpoint `retry(importId)`, ação de idempotência separada `processing-retry`, estado pendente e reutilização da mesma chave enquanto a resposta for incerta. Ao receber 202, retome polling; em `FAILED` estável, pause polling até ação do usuário.

**4. Confirme o GREEN**

```bash
cd apps/frontend
npm test -- lib/imports/client.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx components/imports/import-upload-provider.test.tsx 'app/(painel)/dados/importacoes/imports-view.integration.test.tsx'
npm run lint
npm run typecheck
npm run build
```

**5. Commit**

```bash
git add -- apps/frontend/lib/data/endpoints.ts apps/frontend/lib/imports/client.ts apps/frontend/lib/imports/client.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts apps/frontend/components/imports/import-status-card.tsx apps/frontend/components/imports/import-status-card.test.tsx apps/frontend/components/imports/import-upload-provider.tsx apps/frontend/components/imports/import-upload-provider.test.tsx apps/frontend/app/'(painel)'/dados/importacoes/imports-view.tsx apps/frontend/app/'(painel)'/dados/importacoes/imports-view.integration.test.tsx
git diff --cached --name-only
git commit -m "feat(imports): explain progress and retry processing" -m "Next.js docs consulted: forms.md; error-handling.md; fetching-data.md; server-and-client-components.md; use-client.md; testing/vitest.md; architecture/accessibility.md."
```

---

### Tarefa 10: observabilidade, fault injection, rollout e remoção posterior do legado

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/json_logging.py`
- Criar: `apps/backend/ingestion-data/tests/resilience/test_import_workflow_failures.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_telemetry.py`
- Modificar: `apps/fullstack/ingestion-observability.tf`
- Modificar: `apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md`
- Modificar: `apps/fullstack/README.md`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Modificar: `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

**1. Escreva fault injection e telemetria primeiro**

Injete morte de task antes/depois de cada receipt, ACK perdido de `StartExecution`, execução duplicada, heartbeat vivo sem avanço, timeout, falha de S3/Dynamo e checksum divergente. Prove:

- retry só repete a etapa sem receipt `SUCCEEDED`;
- fingerprint divergente nunca reutiliza saída;
- candidato não vira ativo;
- erro público mantém stage/attempt/retryable;
- `lastProgressAt` não avança por heartbeat;
- nova tentativa usa mesmo import/dataset e novo execution name.

Implemente e teste no wrapper `fault-stop-active <prepare-archive|build-projections|verify-publish-candidate> --repeat <1..4>`. Ele lê de forma consistente somente `CONTROL#IMPORT/ACTIVE`, resolve o item `IMPORT_WORKFLOW#<importId>/EXECUTION`, consulta o histórico da execution exata e extrai dali o task ARN da etapa/tentativa atual; não use `ListTasks` nem procure pelo cluster inteiro. Faça `DescribeTasks` no ARN exato e confira cluster, task definition, comando, `IMPORT_ID`, `EXECUTION_ATTEMPT` e `STAGE_ATTEMPT`. Cada stop exige TTY e confirmação `STOP <account-id> <import-id> <stage> <task-arn>`; `--repeat` espera um `stageAttempt` novo e nunca interrompe o mesmo ARN duas vezes. Teste conta/import/stage divergentes, task já parada, ausência de lock, ARN fora do histórico, repeat fora do limite e timeout sem stop.

**2. Adicione métricas/alarmes**

- `AWS/States`: `ExecutionsFailed`, `ExecutionsTimedOut`, `ExecutionsAborted`, `ExecutionThrottled`;
- custom: `ImportStepDurationMs`, `ImportStepRetries`, `ImportProcessingRetryRequests`, `ImportNoProgressAgeSeconds`;
- alarmes `aws_cloudwatch_metric_alarm.ingestion_workflow_failed`, `ingestion_workflow_timed_out`, `ingestion_workflow_aborted`, `ingestion_workflow_throttled`, `ingestion_no_progress` e `ingestion_slo_exceeded`; preserve os alarmes de storage 80%/90% da fase 2.

As métricas nativas `AWS/States` usam a dimensão `StateMachineArn` do workflow exato. Somente as métricas customizadas usam `Environment`, `Stage` e `Status`; alarmes que não dependem de uma dessas dimensões não devem inventar valor agregado. IDs ficam em logs estruturados. Logs incluem `importId`, `workflowVersion`, `executionAttempt`, `stage`, `stageAttempt`, `status`, duração e contagens; nunca input completo, credencial, dump, URL assinada ou conteúdo de registro.

**3. Execute todos os gates locais**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest -m "not mysql" -q
.venv/bin/python -m ruff check .
.venv/bin/python -m ruff format --check .
.venv/bin/python -m mypy --strict --explicit-package-bases bootstrap adapters application contracts domain ports scripts
cd ../../..
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest -m mysql -q
)
npm --prefix apps/backend/api run build:contracts
npm --prefix apps/backend/api run verify
npm --prefix apps/backend/api run test:ci-policy
npm --prefix apps/frontend test
npm --prefix apps/frontend run lint
npm --prefix apps/frontend run typecheck
npm --prefix apps/frontend run build
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack validate
terraform -chdir=apps/fullstack test
node --test scripts/tests/aws-learner-lab.test.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
```

**4. Commit todo o código necessário ao rollout**

Ainda no worktree isolado, versione telemetria, fault injection, wrapper, runbook e IaC antes de tentar integrá-los no checkout original. A especificação fica para um commit posterior de evidências.

```bash
git add -- apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py apps/backend/ingestion-data/adapters/telemetry/json_logging.py apps/backend/ingestion-data/tests/resilience/test_import_workflow_failures.py apps/backend/ingestion-data/tests/unit/adapters/test_telemetry.py apps/fullstack/ingestion-observability.tf apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md apps/fullstack/README.md scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs
git diff --cached --name-only
git commit -m "test(imports): verify durable workflow recovery"
```

**5. Integre no checkout com state e valide o plano sem aplicar**

Use `superpowers:finishing-a-development-branch` para integrar todos os commits da fase 3 no checkout original. Se houver qualquer mudança local ali, pare; não faça stash, não copie state e não improvise outro backend.

```bash
cd /home/messias/Documentos/github/g05-md7/g05
test "$(pwd -P)" = /home/messias/Documentos/github/g05-md7/g05
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test -f apps/fullstack/terraform.tfstate
test ! -L apps/fullstack/terraform.tfstate
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs check
aws sts get-caller-identity --profile default --region us-east-1
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs plan-update phase3-infra-5000
```

O wrapper deve conferir em memória lineage/serial do state, conta do output `ingestion_runbook`, ausência do lock `CONTROL#IMPORT/ACTIVE` e allowlist antes de declarar o plano seguro. O preset `phase3-infra-5000` pode criar somente as três task definitions, state machine, log group, alarmes e policies exatos da tarefa 8, além dos artefatos stateless já permitidos; a flag da API permanece desligada. Se o Learner Lab bloquear Step Functions ou `iam:PassRole`, não aplique, mantenha `phase2-5000` e registre a ação negada; não amplie IAM fora do permitido.

**6. Faça rollout progressivo**

Use o helper `fault-stop-active` já implementado, testado, commitado e integrado na etapa 1 desta tarefa.

Crie a infraestrutura ainda com runtime legacy e só depois ligue o canário:

```bash
test -f /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz
gzip -t /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz
printf '%s  %s\n' c1d86081679d66c392b63710bda4517b047f029c5403ad1502d731ab5ac126ea /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz | sha256sum --check --status
mkdir -p .artifacts/argus-benchmarks/phase3/smoke-100k .artifacts/argus-benchmarks/phase3/ui-1m .artifacts/argus-benchmarks/phase3/fault-prepare-1m .artifacts/argus-benchmarks/phase3/fault-projections-1m .artifacts/argus-benchmarks/phase3/fault-verify-1m .artifacts/argus-benchmarks/phase3/fault-public-retry-1m
(
  cd apps/backend/ingestion-data
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 100000 --snapshot-extracted-on 2026-09-01 --variant phase3-smoke --output ../../../.artifacts/argus-benchmarks/phase3/smoke-100k/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/smoke-100k/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant phase3-ui --output ../../../.artifacts/argus-benchmarks/phase3/ui-1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/ui-1m/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant phase3-fault-prepare --output ../../../.artifacts/argus-benchmarks/phase3/fault-prepare-1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/fault-prepare-1m/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant phase3-fault-projections --output ../../../.artifacts/argus-benchmarks/phase3/fault-projections-1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/fault-projections-1m/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant phase3-fault-verify --output ../../../.artifacts/argus-benchmarks/phase3/fault-verify-1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/fault-verify-1m/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant phase3-fault-public-retry --output ../../../.artifacts/argus-benchmarks/phase3/fault-public-retry-1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/phase3/fault-public-retry-1m/manifest.json
)
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase3-infra-5000
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs check
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase3-canary-5000
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/phase3/smoke-100k/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-smoke-100k --timeout-seconds 3600
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot /home/messias/Documentos/github/g05-md7/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-full --timeout-seconds 10800
```

Se a fase 1 escolheu 2.000 ou 10.000, troque somente o sufixo de ambos os presets. O wrapper pede a senha em TTY sem eco; nunca a coloque na linha de comando. Confirme que importações criadas antes do segundo update permanecem `LEGACY_ECS` e somente as novas ficam `STEP_FUNCTIONS_V1`.

O dump completo já passou pela fase 2; nesta fase sua execução deve reutilizar o marker e comprovar o caminho rápido pós-commit, não ser contabilizada como novo benchmark de restore/extract. Faça então o E2E visual com `browser:control-in-app-browser`, usando a sessão autenticada já aberta; se ela expirou, peça login ao usuário em vez de buscar ou persistir credenciais. Mostre `terraform -chdir=apps/fullstack output -raw painel_url`, abra `/dados/importacoes/` e faça uma importação pela interface com `.artifacts/argus-benchmarks/phase3/ui-1m/argus_dump.sql.gz`, cuja variant inédita garante um dataset version novo e torna upload/transições observáveis. Salve em `.artifacts/phase3-ui/` screenshots de: seleção/processamento local, multipart para S3, cada uma das três tasks, retry/backoff, conclusão `READY` e ativação ainda explícita. Recarregue a página e faça logout/login durante a execução para provar que o progresso vem do servidor.

Execute cada fault canary isoladamente em dois terminais no checkout original. O `import-canary` do terminal A inicia a importação, imprime o `importId` sanitizado e permanece acompanhando-a até estado terminal. Assim que A informar a criação, rode no terminal B o helper, que espera a etapa pedida ficar ativa antes de interromper o ARN exato. Não comece o cenário seguinte até A retornar `READY`, confirmar uma única candidata e verificar que `CONTROL#IMPORT/ACTIVE` foi liberado.

**Cenário 1 — prepare-archive**

Terminal A:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/phase3/fault-prepare-1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-fault-prepare-1m --timeout-seconds 7200
```

Terminal B:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs fault-stop-active prepare-archive --repeat 1
```

**Cenário 2 — build-projections**, somente depois do cenário 1 terminar:

Terminal A:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/phase3/fault-projections-1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-fault-projections-1m --timeout-seconds 7200
```

Terminal B:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs fault-stop-active build-projections --repeat 1
```

**Cenário 3 — verify-publish-candidate**, somente depois do cenário 2 terminar:

Terminal A:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/phase3/fault-verify-1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-fault-verify-1m --timeout-seconds 7200
```

Terminal B:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs fault-stop-active verify-publish-candidate --repeat 1
```

Cada um desses workflows deve recuperar internamente, incrementar apenas `stageAttempt` e reutilizar receipts `SUCCEEDED`.

**Cenário 4 — esgotamento e retry público**, somente depois do cenário 3 terminar:

Terminal A:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs import-canary --snapshot .artifacts/argus-benchmarks/phase3/fault-public-retry-1m/argus_dump.sql.gz --extracted-on 2026-09-01 --username olivindomessias@gmail.com --label phase3-fault-public-retry-1m --timeout-seconds 7200
```

Terminal B:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs fault-stop-active build-projections --repeat 4
```

Espere A terminar em `FAILED/retryable=true` e o lock ser liberado. Na interface, abra o `importId` exibido por A, clique em “Tentar processamento novamente” e acompanhe até `READY`; prove que o mesmo upload/dataset cria `executionAttempt=N+1`, pula receipts completos e chega a uma única candidata. Não rode outro canário enquanto esse retry não for terminal.

Aceite E2E: três etapas aparecem em ordem; refresh/login preserva progresso; ETA/taxa não mentem; falha transitória mostra causa, tentativa e próxima ação; retry pula receipts completos; uma única candidata fica `READY`; ativação continua explícita; nenhum segundo import atravessa o lock; workflow completo permanece dentro do SLO da fase 2. Compare os timestamps persistidos, não apenas o tempo do comando local, para aferir as duas horas.

**7. Ensaie rollback e drene legado**

Depois de drenar a importação ativa, faça rollback pelo preset anterior e confirme que a execução em voo continua no modo fixado enquanto uma nova importação usa ECS:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase3-infra-5000
```

Se outro page size foi selecionado, troque apenas o sufixo. O preset `phase3-infra-*` mantém state machine, task definitions, logs e alarmes, mas deixa `IMPORT_STEP_FUNCTIONS_ENABLED=false`; por isso não destrói a infraestrutura necessária às execuções históricas. Não apague executions, receipts, marker ou objetos. Só em um plano/PR posterior, depois de não haver registros legacy ativos, remova `ecs-import-worker-launcher.ts`, campos `taskArn`, permissões `ecs:RunTask`/`iam:PassRole` da API e task definition monolítica; essa remoção não pertence a este commit.

**8. Registre e versione somente a evidência**

No checkout original, registre na especificação os execution ARNs sanitizados, tentativas por etapa, timestamps persistidos, resultado dos quatro fault canaries, SLO e rollback. O código usado no rollout já está no commit pré-rollout:

```bash
git add -- docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md
git diff --cached --name-only
git commit -m "docs(imports): record durable workflow evidence"
```

## Gate de conclusão

- Frontend aceita registros legacy e novos.
- `heartbeatAt` e `lastProgressAt` possuem semânticas diferentes e testadas.
- Cada etapa possui receipt fenced e idempotente.
- Tasks 2/3 funcionam sem qualquer arquivo local da task 1.
- Retry do processamento preserva upload/dataset e incrementa somente a tentativa.
- Step Functions está atrás de flag e o modo fica fixo por import.
- IAM, logs e alarmes passaram pelos testes de política.
- Interrupções reais foram recuperadas sem duplicar, perder ou ativar dados parciais.
- Rollback para ECS legado foi ensaiado sem apagar dados.
