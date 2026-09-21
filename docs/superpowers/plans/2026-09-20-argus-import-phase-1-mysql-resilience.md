# Importação ARGUS — fase 1: resiliência e desempenho do MySQL

> **Para quem executar — REQUIRED SUB-SKILL:** use `superpowers:executing-plans` para executar este plano tarefa a tarefa, `superpowers:test-driven-development` em cada mudança e `superpowers:verification-before-completion` antes de concluir. Execute este plano primeiro; as fases 2 e 3 dependem dele.

**Objetivo:** eliminar a falha MySQL 2013 observada, tornar a paginação retomável e provar por benchmark que as consultas deixam de degradar conforme o cursor avança.

**Arquitetura:** manter o worker monolítico atual, mas acrescentar uma política explícita de conexão/retry e um preflight do snapshot. O preflight cria somente os índices de cursor ausentes, atualiza estatísticas das tabelas alteradas e rejeita planos que ainda ordenem/varram a tabela inteira. O checkpoint só avança após a página ter sido reconciliada.

**Stack:** Python 3.12, PyMySQL, pytest, DynamoDB/S3 existentes, ECS/Fargate, Terraform e CloudWatch.

**Especificação:** `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

## Restrições globais

- Não execute este plano no worktree atualmente sujo. Primeiro consolide o trabalho de ingestão já existente em um commit próprio; depois use `superpowers:using-git-worktrees` para criar um worktree isolado a partir desse commit. Não faça stash automático nem absorva mudanças preexistentes nos commits abaixo.
- Cada bloco de comandos parte da raiz do repositório; ao continuar no mesmo shell, execute `cd "$(git rev-parse --show-toplevel)"` antes do próximo bloco.
- Não altere a semântica do leitor MySQL `live`; a política nova vale para snapshot e só é compartilhada quando um teste comprovar compatibilidade.
- Retry somente `pymysql.err.OperationalError` com códigos 2006 ou 2013. Erros de schema, SQL, autenticação e contrato falham imediatamente.
- Cada tentativa abre uma conexão nova; nenhuma conexão quebrada pode ser reutilizada.
- Nunca avance checkpoint antes de confirmar todos os efeitos da página.
- Toda mutação AWS usa apenas `--profile default --region us-east-1`. Valide que o caller identity é do Learner Lab e nunca use o profile `nora`.
- A implantação começa com a feature flag desligada e não inclui `terraform destroy`.
- O state Terraform do Learner Lab é local e existe somente no checkout original em `/home/messias/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate`. Implemente, teste e commite no worktree isolado, mas integre os commits no checkout original limpo antes de qualquer `update`. Nunca copie nem crie symlink do state para outro worktree.

Antes da tarefa 1, confirme a base e pare se houver qualquer saída no primeiro comando:

```bash
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git branch --show-current
git log -1 --oneline
```

Registre o hash exibido no relatório da execução. Todos os `git add --` deste plano pressupõem esse worktree limpo.

Prepare as dependências do worktree novo uma única vez. O host pode estar em Node 24, mas este repositório exige Node 22:

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
. "$NVM_DIR/nvm.sh"
nvm use 22
node -e 'if (Number(process.versions.node.split(".")[0]) !== 22) process.exit(1)'

command -v uv
uv venv --python 3.12 apps/backend/ingestion-data/.venv
uv pip install --python apps/backend/ingestion-data/.venv/bin/python -r apps/backend/ingestion-data/requirements-dev.txt
apps/backend/ingestion-data/.venv/bin/python -c 'import sys; raise SystemExit(sys.version_info[:2] != (3, 12))'
npm ci --prefix apps/backend/api
npm ci --prefix apps/frontend
```

---

### Tarefa 1: tornar a política MySQL uma configuração validada

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/bootstrap/config.py`
- Modificar: `apps/backend/ingestion-data/adapters/sources/mysql_reader.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Modificar: `apps/backend/ingestion-data/.env.example`
- Testar: `apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py`
- Testar: `apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py`

**1. Escreva os testes que falham**

Adicione casos que esperem estes defaults e rejeitem zero, negativos e valores não inteiros:

```python
assert settings.page_size == 500
assert settings.mysql_read_timeout_seconds == 300
assert settings.mysql_write_timeout_seconds == 300
assert settings.mysql_ddl_timeout_seconds == 1_800
assert settings.mysql_query_max_attempts == 4
assert settings.mysql_query_retry_base_ms == 250
assert settings.mysql_query_retry_max_ms == 4_000
assert settings.mysql_snapshot_prepare_enabled is False
```

Em `test_mysql_reader.py`, capture os argumentos de `pymysql.connect` e prove que os timeouts de leitura/escrita chegam ao driver.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/bootstrap/test_config.py tests/unit/adapters/test_mysql_reader.py -q
```

Esperado: falhas pelos novos atributos inexistentes; o teste de `PAGE_SIZE=500` continua verde e protege o default legado.

**3. Implemente o contrato mínimo**

Amplie `Settings` e `MySqlConnectionSettings` com campos validados. Preserve os defaults do reader compartilhado para não alterar live/incremental por acidente; o container de snapshot passa a política mais longa explicitamente:

```python
read_timeout_seconds: int = 30
write_timeout_seconds: int = 30
ddl_timeout_seconds: int = 1_800
query_max_attempts: int = 1
query_retry_base_ms: int = 250
query_retry_max_ms: int = 4_000
```

Leia as variáveis `MYSQL_READ_TIMEOUT_SECONDS`, `MYSQL_WRITE_TIMEOUT_SECONDS`, `MYSQL_DDL_TIMEOUT_SECONDS`, `MYSQL_QUERY_MAX_ATTEMPTS`, `MYSQL_QUERY_RETRY_BASE_MS`, `MYSQL_QUERY_RETRY_MAX_MS` e `MYSQL_SNAPSHOT_PREPARE_ENABLED`. Exija `retry_base_ms <= retry_max_ms`, tentativas em `1..8`, timeouts de query em `1..3600` e DDL em `1..7200`. Passe os valores resilientes somente no `container.mysql(False)` e use read/write em `_connect()`; o preparer da tarefa 3 usa o timeout DDL.

Não mude silenciosamente os settings do `live` nesta tarefa. Mantenha `PAGE_SIZE` com default de código 500; o valor 5.000 entra como configuração do import worker e só é promovido depois do canário.

**4. Confirme o GREEN e a compatibilidade incremental**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/unit/bootstrap/test_config.py tests/unit/adapters/test_mysql_reader.py tests/integration/test_incremental_mysql_parquet.py -q
)
```

Esperado: todos passam.

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/bootstrap/config.py apps/backend/ingestion-data/adapters/sources/mysql_reader.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/.env.example apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py
git diff --cached --name-only
git commit -m "feat(ingestion): configure snapshot mysql resilience"
```

---

### Tarefa 2: repetir uma operação de leitura perdida sem duplicar nem avançar cursor

**Arquivos:**

- Criar: `apps/backend/ingestion-data/adapters/sources/mysql_retry.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/adapters/test_mysql_retry.py`
- Modificar: `apps/backend/ingestion-data/tests/resilience/test_checkpoint_resume.py`
- Testar: `apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py`

**1. Escreva os testes que falham**

Cubra quatro comportamentos:

1. a primeira conexão lança `OperationalError(2013, "lost connection")`, a segunda devolve a mesma página e a API retorna uma única página;
2. códigos 2006/2013 são repetidos até `query_max_attempts`;
3. código 1045 e qualquer erro de contrato não são repetidos;
4. todas as conexões, inclusive a que falha, são fechadas exatamente uma vez.

Modele um decorator de porta e injete espera/aleatoriedade para testar o backoff sem dormir:

```python
reader = RetryingMySqlSourceReader(
    inner,
    MySqlRetryPolicy(max_attempts=4, base_delay_ms=250, max_delay_ms=4_000),
    sleep=delays.append,
    random_value=lambda: 0.5,
)
```

Para base 250 ms, teto 4 s e jitter 0,5, espere atrasos de `0.125`, `0.250` e `0.500` segundos antes da quarta tentativa.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/adapters/test_mysql_reader.py tests/unit/adapters/test_mysql_retry.py tests/resilience/test_checkpoint_resume.py -q
```

Esperado: o primeiro 2013 escapa imediatamente e as novas injeções não existem.

**3. Implemente a exceção e o loop de retry**

Crie tipos explícitos no novo módulo:

```python
class MySqlQueryRetriesExhausted(RuntimeError):
    def __init__(self, *, mysql_code: int, attempts: int, timed_out: bool) -> None:
        self.mysql_code = mysql_code
        self.attempts = attempts
        self.timed_out = timed_out
        super().__init__("MySQL query retries exhausted")

@dataclass(frozen=True, slots=True)
class MySqlRetryPolicy:
    max_attempts: int
    base_delay_ms: int
    max_delay_ms: int

@dataclass(frozen=True, slots=True)
class MySqlRetryEvent:
    operation: Literal["schema", "coverage", "page"]
    dataset: str | None
    mysql_code: int
    attempt: int
    delay_seconds: float
```

`RetryingMySqlSourceReader` implementa `SourceReader`, envolve `validate_schema()`, `measure_coverage()` e `read_page()` e recebe:

```python
sleep: Callable[[float], None] = time.sleep
random_value: Callable[[], float] = random.random
on_retry: Callable[[MySqlRetryEvent], None] | None = None
```

Faça cada tentativa repetir o método inteiro do reader. Como o `MySqlSourceReader` já abre/fecha uma conexão por consulta, isso garante conexão nova sem duplicar lógica interna. Calcule full jitter com:

```python
ceiling_ms = min(retry_max_ms, retry_base_ms * (2 ** (attempt - 1)))
delay_seconds = (ceiling_ms * random_value()) / 1_000
```

Se a última tentativa falhar, levante `MySqlQueryRetriesExhausted` encadeada ao erro original; classifique código 2006 como `timed_out=False` e 2013 como `timed_out=True`. Trate `on_retry` como best effort. Não inclua host, SQL, parâmetros ou cursor na mensagem pública. O teste de resiliência deve provar que uma leitura falha não chama `CheckpointRepository.advance()` e que o retry usa o cursor durável anterior.

**4. Confirme o GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/adapters/test_mysql_reader.py tests/unit/adapters/test_mysql_retry.py tests/resilience/test_checkpoint_resume.py -q
```

Esperado: todos passam e o teste confirma uma nova conexão por tentativa.

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/adapters/sources/mysql_retry.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/adapters/test_mysql_retry.py apps/backend/ingestion-data/tests/resilience/test_checkpoint_resume.py apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py
git diff --cached --name-only
git commit -m "feat(ingestion): retry lost mysql pages safely"
```

---

### Tarefa 3: preparar índices de cursor e provar o plano de consulta

**Arquivos:**

- Criar: `apps/backend/ingestion-data/adapters/sources/mysql_snapshot_preparer.py`
- Modificar: `apps/backend/ingestion-data/adapters/sources/mysql_reader.py`
- Modificar: `apps/backend/ingestion-data/ports/contracts.py`
- Modificar: `apps/backend/ingestion-data/ports/__init__.py`
- Modificar: `apps/backend/ingestion-data/application/backfill.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Criar: `apps/backend/ingestion-data/tests/unit/adapters/test_mysql_snapshot_preparer.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/application/test_backfill.py`
- Criar: `apps/backend/ingestion-data/tests/integration/test_mysql_snapshot_preparer.py`

**1. Escreva o contrato e os testes que falham**

Defina na porta estes valores imutáveis:

```python
@dataclass(frozen=True, slots=True)
class QueryPlanEvidence:
    dataset: str
    index_name: str
    cursor_columns: tuple[str, ...]
    created: bool
    access_type: str
    estimated_rows: int

class SnapshotPreparer(ABC):
    @abstractmethod
    def prepare(
        self,
        descriptors: tuple[DatasetDescriptor, ...],
    ) -> tuple[QueryPlanEvidence, ...]:
        raise NotImplementedError
```

Os testes unitários devem provar:

- um índice existente conta somente se seus primeiros campos forem exatamente `cursor_key` na mesma ordem;
- `signal_bucket(bts, source, entity, metric)`, `finding_status_log(ts, finding_id)` e `live_event(start_ts, tid)` recebem índice;
- o nome reservado é exatamente `ix_ingestion_cursor`; se ele existir com colunas divergentes, a execução falha sem removê-lo;
- identificadores vêm exclusivamente do `DatasetRegistry` e são escapados por `quote_identifier`;
- `ANALYZE TABLE` ocorre apenas nas tabelas em que um índice foi criado;
- uma segunda execução não cria nem analisa novamente;
- `EXPLAIN FORMAT=JSON` que não usa o prefixo esperado levanta `QueryPlanInvalid(dataset)`.

O teste de integração deve criar uma tabela com a ordem de PK incompatível, inserir linhas, executar `prepare()` duas vezes e confirmar via `INFORMATION_SCHEMA.STATISTICS` um único índice compatível.

**2. Confirme o RED**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/unit/adapters/test_mysql_snapshot_preparer.py tests/unit/adapters/test_mysql_reader.py tests/integration/test_mysql_snapshot_preparer.py tests/unit/application/test_backfill.py -q
)
```

Esperado: importações e porta ainda não existem.

**3. Implemente o adaptador mínimo**

Use uma conexão autocommit separada da leitura e `MYSQL_DDL_TIMEOUT_SECONDS`. Consulte `INFORMATION_SCHEMA.STATISTICS`, agrupando `INDEX_NAME` por `SEQ_IN_INDEX`. Crie apenas o índice faltante e reconsulte o schema antes de repetir um DDL cuja resposta foi perdida:

```sql
ALTER TABLE `<tabela>`
ADD INDEX `ix_ingestion_cursor` (`<cursor-1>`, `<cursor-2>`),
ALGORITHM=INPLACE,
LOCK=NONE
```

Estenda `build_page_query` com `forced_index: str | None = None`. No snapshot, use `PRIMARY` quando `cursor_key == natural_key` e `ix_ingestion_cursor` somente nas três tabelas divergentes; live/incremental permanecem sem hint. Mesmo que já exista outro índice compatível, crie e use o nome reservado `ix_ingestion_cursor`; isso torna o hint estável e evita depender de nomes externos. Se o nome reservado existir com colunas divergentes, falhe sem removê-lo.

Depois de `ANALYZE TABLE`, execute `EXPLAIN FORMAT=JSON` sobre a consulta real da primeira página e, havendo dados, de uma página retomada. Para a página inicial, aceite `const|eq_ref|ref|range|index` apenas quando `key` for o índice esperado e `used_key_parts` começar pelo cursor completo. Para a página retomada, exija `const|eq_ref|ref|range`, o mesmo `key`, o cursor completo em `used_key_parts` e ausência de `Using filesort`; `access_type=index` na retomada é full index scan e deve levantar `QueryPlanInvalid`. Não exija estimativa específica de linhas.

**4. Ligue o preflight ao backfill**

Adicione `snapshot_preparer: SnapshotPreparer | None` ao `Backfill`. Depois de `restore()`, transicione para `VALIDATING` e execute o preparer antes de `_validate_source()`, somente se `MYSQL_SNAPSHOT_PREPARE_ENABLED=true`. Passe `tuple(registry)` na ordem contratual, registre início/fim/duração e mantenha essa operação dentro de `VALIDATING` nesta fase para não quebrar estados persistidos.

**5. Confirme o GREEN**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/unit/adapters/test_mysql_snapshot_preparer.py tests/unit/adapters/test_mysql_reader.py tests/integration/test_mysql_snapshot_preparer.py tests/unit/application/test_backfill.py tests/resilience/test_idempotent_backfill.py -q
)
```

Esperado: todos passam; o retry de um run não recria índices.

**6. Commit**

```bash
git add -- apps/backend/ingestion-data/adapters/sources/mysql_snapshot_preparer.py apps/backend/ingestion-data/adapters/sources/mysql_reader.py apps/backend/ingestion-data/ports/contracts.py apps/backend/ingestion-data/ports/__init__.py apps/backend/ingestion-data/application/backfill.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/adapters/test_mysql_snapshot_preparer.py apps/backend/ingestion-data/tests/unit/adapters/test_mysql_reader.py apps/backend/ingestion-data/tests/unit/application/test_backfill.py apps/backend/ingestion-data/tests/integration/test_mysql_snapshot_preparer.py
git diff --cached --name-only
git commit -m "feat(ingestion): prepare snapshot cursor indexes"
```

---

### Tarefa 4: preservar uma causa pública acionável

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/application/import_dump.py`
- Modificar: `apps/backend/ingestion-data/domain/import_job.py`
- Modificar: `apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py`
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
- Modificar: `apps/frontend/components/imports/import-status-card.test.tsx`

**1. Escreva os testes que falham**

Prove o mapeamento, sem texto interno:

| Exceção | código público | retryable |
|---|---|---:|
| `MySqlQueryRetriesExhausted(timed_out=False)` | `MYSQL_CONNECTION_LOST` | `true` |
| `MySqlQueryRetriesExhausted(timed_out=True)` | `MYSQL_QUERY_TIMEOUT` | `true` |
| `QueryPlanInvalid` | `QUERY_PLAN_INVALID` | `false` |

No contrato TypeScript, adicione os três literais à enumeração fechada. No frontend, espere mensagens em português que expliquem reconexão, timeout ou plano inválido sem expor SQL/cursor.

Amplie o erro seguro de forma aditiva com `stage: string | null`, `retryable: boolean`, `attempt: number` e `maxAttempts: number | null`; preserve `requestId` como correlation ID público. Registros antigos sem esses campos normalizam para `null`, `false`, `1` e `null`, respectivamente.

**2. Confirme o RED**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py -q
cd ../api
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts tests/import-domain.test.ts
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx
```

**3. Implemente classificação explícita**

Substitua o catch-all que reduz falhas conhecidas a `INTERNAL_ERROR` por uma função pura `classify_import_failure(error) -> ImportFailure`. Mantenha `BaseException` somente para garantir persistência antes de repropagar sinais de processo; classifique apenas subclasses conhecidas de `Exception`.

Garanta que o payload público contenha `code`, `stage`, `retryable`, `attempt`, `maxAttempts` e o `requestId` já existente, sem `str(error)` não confiável. O log privado pode registrar `mysqlCode` e `attempts`, mas não senha, SQL completo, parâmetros ou chave S3.

**4. Atualize e valide os contratos**

Não existe gerador de OpenAPI neste repositório: `build:contracts` apenas executa o TypeScript. Edite `contracts/src/index.ts` e `contracts/openapi/public.openapi.json` na mesma mudança; `tests/contracts.test.ts` é o gate de paridade entre ambos.

```bash
cd apps/backend/api
npm run build:contracts
npm test -- tests/contracts.test.ts tests/import-python-fixture.test.ts tests/import-domain.test.ts
cd ../ingestion-data
.venv/bin/python -m pytest tests/unit/application/test_import_dump.py tests/unit/domain/test_import_job.py tests/unit/adapters/test_import_jobs.py -q
cd ../../frontend
npm test -- lib/imports/types.test.ts components/imports/import-presentation.test.ts components/imports/import-status-card.test.tsx
```

Esperado: todas as suítes passam e o JSON OpenAPI editado contém os três códigos validados pela suíte de paridade.

**5. Commit**

```bash
git add -- apps/backend/ingestion-data/application/import_dump.py apps/backend/ingestion-data/domain/import_job.py apps/backend/ingestion-data/adapters/dynamodb/import_jobs.py apps/backend/ingestion-data/tests/unit/application/test_import_dump.py apps/backend/ingestion-data/tests/unit/domain/test_import_job.py apps/backend/ingestion-data/tests/unit/adapters/test_import_jobs.py apps/backend/ingestion-data/tests/fixtures/import_job_typescript.json apps/backend/api/contracts/src/index.ts apps/backend/api/contracts/openapi/public.openapi.json apps/backend/api/src/modules/imports/domain/import.ts apps/backend/api/tests/contracts.test.ts apps/backend/api/tests/import-python-fixture.test.ts apps/backend/api/tests/import-domain.test.ts apps/frontend/lib/imports/types.ts apps/frontend/lib/imports/types.test.ts apps/frontend/components/imports/import-presentation.ts apps/frontend/components/imports/import-presentation.test.ts apps/frontend/components/imports/import-status-card.test.tsx
git diff --cached --name-only
git commit -m "feat(imports): expose safe mysql failure causes"
```

---

### Tarefa 5: medir páginas, retries e preflight com a dimensão correta

**Arquivos:**

- Modificar: `apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py`
- Modificar: `apps/backend/ingestion-data/adapters/telemetry/observed_ports.py`
- Modificar: `apps/backend/ingestion-data/bootstrap/container.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_telemetry.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/adapters/test_observed_ports.py`
- Modificar: `apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py`

**1. Escreva os testes que falham**

Adicione à allowlist:

```text
MySqlPageDurationMs          Milliseconds
MySqlPageRows                Count
MySqlRetries                 Count
MySqlCursorIndexDurationMs   Milliseconds
MySqlPreflightDurationMs     Milliseconds
MySqlPreflightFailures       Count
```

Dimensões de baixa cardinalidade: `command`, `source_mode`, `dataset`. Nunca use import ID, host, cursor, SQL ou mensagem como dimensão.

**2. Corrija a rotulagem do import**

Use a assinatura `def _backfill_handler(settings: Settings, dependencies: Mapping[str, object], *, telemetry_command: Literal["backfill", "import-dump"] = "backfill") -> CommandHandler` e passe `import-dump` a partir de `_import_dump_handler()`. Use esse valor em todos os wrappers existentes e novos.

`ObservedSourceReader.read_page()` mede duração end-to-end, inclusive backoff, e linhas. O callback do decorator emite retries. `ObservedSnapshotQueryPreparer` mede indexação/preflight. Telemetria é best effort.

**3. Confirme RED/GREEN**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest tests/unit/adapters/test_telemetry.py tests/unit/adapters/test_observed_ports.py tests/unit/bootstrap/test_config.py -q
```

**4. Commit**

```bash
git add -- apps/backend/ingestion-data/adapters/telemetry/cloudwatch_metrics.py apps/backend/ingestion-data/adapters/telemetry/observed_ports.py apps/backend/ingestion-data/bootstrap/container.py apps/backend/ingestion-data/tests/unit/adapters/test_telemetry.py apps/backend/ingestion-data/tests/unit/adapters/test_observed_ports.py apps/backend/ingestion-data/tests/unit/bootstrap/test_config.py
git diff --cached --name-only
git commit -m "feat(ingestion): observe mysql pagination and preflight"
```

---

### Tarefa 6: configurar o worker descartável e proteger a infraestrutura por teste

**Arquivos:**

- Modificar: `apps/fullstack/ingestion-ecs.tf`
- Modificar: `apps/fullstack/ingestion-imports.tf`
- Modificar: `apps/fullstack/ingestion-variables.tf`
- Modificar: `apps/fullstack/ingestion-observability.tf`
- Modificar: `apps/fullstack/tests/ingestion_defaults.tftest.hcl`
- Modificar: `apps/fullstack/tests/ingestion_production.tftest.hcl`
- Modificar: `apps/backend/api/tests/ci/fullstack-iac-policy.test.js`
- Modificar: `apps/fullstack/README.md`
- Modificar: `apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Criar: `scripts/ci/validate-terraform-learner-update-plan.mjs`
- Criar: `scripts/tests/validate-terraform-learner-update-plan.test.mjs`

**1. Escreva os testes de política que falham**

Faça a suíte exigir no import worker:

```text
PAGE_SIZE=${var.ingestion_snapshot_page_size}  # default 500; override 5000 no primeiro canário
MYSQL_CONNECT_TIMEOUT_SECONDS=10
MYSQL_READ_TIMEOUT_SECONDS=300
MYSQL_WRITE_TIMEOUT_SECONDS=300
MYSQL_DDL_TIMEOUT_SECONDS=1800
MYSQL_QUERY_MAX_ATTEMPTS=4
MYSQL_QUERY_RETRY_BASE_MS=250
MYSQL_QUERY_RETRY_MAX_MS=4000
MYSQL_SNAPSHOT_PREPARE_ENABLED=false
```

Exija também no sidecar MySQL de 8 GiB:

```text
--innodb-buffer-pool-size=3221225472
--innodb-redo-log-capacity=1073741824
--innodb-flush-log-at-trx-commit=2
--skip-log-bin
--sync-binlog=0
--max-allowed-packet=1073741824
--net-read-timeout=600
--net-write-timeout=600
--wait-timeout=600
--performance-schema=OFF
```

Não adicione `--innodb-doublewrite=0` nem desabilite redo logging. Fixe a imagem MySQL por digest e preserve 200 GiB de storage efêmero.

Antes de qualquer mudança remota, escreva testes Node para um caminho de atualização explícito. O comando `deploy` atual continua create-only e nunca pode atualizar a stack existente. O novo contrato é:

```text
node scripts/aws-learner-lab.mjs update baseline
node scripts/aws-learner-lab.mjs update phase1-2000
node scripts/aws-learner-lab.mjs update phase1-5000
node scripts/aws-learner-lab.mjs update phase1-10000
```

Os quatro presets são valores hardcoded, não flags Terraform arbitrárias. `baseline` fixa prepare=false/page-size=500; os três presets `phase1-*` fixam prepare=true e o page size do nome. O wrapper exige `AWS_PROFILE=default`, região `us-east-1`, caller `assumed-role/voclabs`, credencial ativa, workspace `default`, nenhuma variável `TF_VAR_*`/tfvars automática e confirmação exata `UPDATE g05-s3 <account-id> <preset>`. Rejeite `AWS_DEFAULT_PROFILE` diferente de `default`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` no ambiente e caminhos customizados `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`.

`check`, `plan-update` e `update` só podem operar no checkout original `/home/messias/Documentos/github/g05-md7/g05`. Antes de inicializar Terraform, use `lstat` para exigir que `apps/fullstack/terraform.tfstate` seja arquivo regular, não symlink e pertencente ao usuário atual; normalize seu modo para `0600`, leia o JSON sem imprimi-lo e exija `lineage` não vazio e `serial` inteiro positivo. Leia `terraform state pull` em memória e confirme o mesmo lineage e serial não regressivo. O output `ingestion_runbook.imports.expected_bucket_owner` deve ser exatamente o `Account` retornado por STS. Antes do apply, copie o state para `.terraform-artifacts/state-backups/terraform.tfstate.<UTC>` com modo `0600`; nunca grave state, plan JSON ou segredo em `.artifacts` nem nos logs. Depois do apply, valide novamente lineage/serial e os outputs. Qualquer divergência aborta fechado.

Antes do plan, leia o output `ingestion_runbook`, resolva a tabela operacional e faça `GetItem` consistente da chave exata `{"pk":"CONTROL#IMPORT","sk":"ACTIVE"}`. Se o item existir, aborte mostrando apenas o `importId` público: atualizar task definitions durante uma importação ativa não faz parte deste plano.

O wrapper salva o plan, usa `terraform show -json` e passa o JSON mais o preset a `validate-terraform-learner-update-plan.mjs`; o apply recebe exatamente o arquivo de plan já validado, nunca recalcula um plano. O validator compara todas as variáveis base mais as duas variáveis do preset; rejeita `delete` isolado, mudança de provider, `previous_address` e qualquer alteração fora da allowlist. Nesta fase, a allowlist contém somente os artefatos stateless que o código desta fase pode republicar: `terraform_data.ingestion_image[0]`, `terraform_data.imagem`, `terraform_data.build_painel`, `terraform_data.painel`; task definitions `api`, `ingestion_backfill`, `ingestion_import`, `ingestion_sync`, `ingestion_incremental_export` e `ingestion_incremental_ingest`; `aws_ecs_service.api`; schedules `aws_scheduler_schedule.ingestion_sync`, `aws_scheduler_schedule.ingestion_incremental_export` e `aws_scheduler_schedule.ingestion_incremental_ingest`; o dashboard de ingestão; e alarmes `aws_cloudwatch_metric_alarm.ingestion_mysql_retries`, `aws_cloudwatch_metric_alarm.ingestion_mysql_preflight_failures` e `aws_cloudwatch_metric_alarm.ingestion_mysql_page_duration`. Uma substituição `delete/create` ou `create/delete` só é aceita para `terraform_data.*` e task definitions; buckets, tabelas, Glue, Cognito, rede, ECR e Amplify app/branch falham fechado. Cubra cada regra com fixtures mínimas no novo teste do validator e verifique depois do apply os digests das task definitions, schedules e flags esperados pelo preset.

**2. Confirme o RED**

```bash
cd apps/backend/api
npm run test:ci-policy
terraform -chdir=../../fullstack init -backend=false -input=false
terraform -chdir=../../fullstack test
```

**3. Implemente os locals/variáveis**

Mantenha a flag desligada e `ingestion_snapshot_page_size=500` nos defaults Terraform. Documente que o Learner Lab testa 2.000, 5.000 e 10.000 e promove o melhor valor; 5.000 é o candidato inicial, não um palpite aplicado a todos os ambientes. Preserve secrets fora de variáveis Terraform e fora do state.

Adicione ao runbook as métricas, o significado dos códigos públicos e o rollback por flag. Registre que alterar buffer/redo exige nova task definition e não recupera uma task já falha.

Implemente também o subcomando `update` e o validator exatamente como testado acima. `runLearnerLab()` recebe `preset` separadamente de `step`; a entrada CLI usa `process.argv[3]`. Não aceite argumentos extras. Preserve o comportamento dos comandos existentes e faça `deploy` continuar passando exclusivamente pelo gate create-only.

**4. Valide Terraform e política**

```bash
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack validate
terraform -chdir=apps/fullstack test
cd apps/backend/api
npm run test:ci-policy
cd ../../..
node --test scripts/tests/aws-learner-lab.test.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
```

Esperado: zero mudanças de formatação e todos os testes passam.

**5. Commit**

```bash
git add -- apps/fullstack/ingestion-ecs.tf apps/fullstack/ingestion-imports.tf apps/fullstack/ingestion-variables.tf apps/fullstack/ingestion-observability.tf apps/fullstack/tests/ingestion_defaults.tftest.hcl apps/fullstack/tests/ingestion_production.tftest.hcl apps/fullstack/README.md apps/fullstack/observability/docs/runbooks/ingestion-run-slow.md apps/backend/api/tests/ci/fullstack-iac-policy.test.js scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs scripts/ci/validate-terraform-learner-update-plan.mjs scripts/tests/validate-terraform-learner-update-plan.test.mjs
git diff --cached --name-only
git commit -m "infra(ingestion): tune disposable mysql snapshot worker"
```

---

### Tarefa 7: criar benchmark reproduzível e aceitar a fase 1

**Arquivos:**

- Criar: `apps/backend/ingestion-data/scripts/build_benchmark_snapshot.py`
- Criar: `apps/backend/ingestion-data/scripts/benchmark_snapshot_reader.py`
- Criar: `apps/backend/ingestion-data/tests/unit/test_build_benchmark_snapshot.py`
- Criar: `apps/backend/ingestion-data/tests/performance/test_snapshot_reader_benchmark.py`
- Modificar: `apps/backend/ingestion-data/README.md`
- Modificar: `.gitignore`
- Modificar: `scripts/aws-learner-lab.mjs`
- Modificar: `scripts/tests/aws-learner-lab.test.mjs`
- Modificar: `docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md`

**1. Escreva o teste do harness**

`build_benchmark_snapshot.py` recebe `--rows`, `--snapshot-extracted-on`, `--variant`, `--output` e `--manifest`; `--variant` é um slug opcional com default `baseline`, incorporado aos valores sintéticos para permitir canários posteriores com checksum/dataset version novos sem adulterar o dump real. Ele reutiliza o schema/fixture oficial, preserva ao menos uma linha nas 23 tabelas e acrescenta linhas determinísticas em `signal_bucket` até o total pedido. Gere INSERTs em blocos máximos de 1.000 e escreva o gzip em streaming; não materialize 1 milhão de linhas em memória. Para determinismo byte a byte, construa `gzip.GzipFile` com `mtime=0` e nome interno vazio. O manifest registra variant, SHA-256 comprimido, bytes, contagem total, contagem por tabela e a data de extração recebida. O teste cobre 1.003 linhas, restaura o artefato no MySQL de teste, confirma contagens/data, prova determinismo para a mesma variant e checksum diferente para variant diferente.

O harness recebe `--snapshot`, `--rows`, `--page-size`, `--disconnect-after-page` opcional e `--output-json`. Ele restaura o dump numa base vazia, executa preflight/paginação com o reader real e gera JSON com:

```json
{
  "rows": 100000,
  "pageSize": 5000,
  "durationSeconds": 0.0,
  "rowsPerSecond": 0.0,
  "queryP50Ms": 0.0,
  "queryP95Ms": 0.0,
  "queryP99Ms": 0.0,
  "firstQuartileP99Ms": 0.0,
  "lastQuartileP99Ms": 0.0,
  "retries": 0,
  "duplicates": 0,
  "missing": 0
}
```

O teste automático usa uma amostra pequena e valida schema, contagens e determinismo; não fixa latência de CI. `--disconnect-after-page 10` faz o fake de conexão levantar exatamente `OperationalError(2013, ...)` uma vez, sem introduzir uma variável de fault injection no worker de produção.

Estenda também o wrapper com argumentos explícitos e retrocompatíveis:

```text
node scripts/aws-learner-lab.mjs seed --snapshot <arquivo.sql.gz> --extracted-on YYYY-MM-DD --label <slug> --timeout-seconds <n>
```

Sem opções, `seed` continua usando `reduced-argus.sql.gz` e o timeout legado. Com opções, exija os quatro valores, arquivo regular legível terminado em `.sql.gz`, data ISO válida, label em `[a-z0-9-]{1,40}` e timeout em `60..43200`; rejeite symlink, argumentos desconhecidos e arquivo inexistente antes de chamar AWS. Use o label nos arquivos de evidência, passe a data ao `upload_snapshot.py` e preserve `--no-activate` no `run_task.py`. Substitua `aws ecs wait tasks-stopped` por polling de `DescribeTasks` a cada 15 segundos até o deadline monotônico; timeout local não marca o import como falho nem interrompe a task, apenas devolve o ARN para retomada por `evidence`. Adicione testes com relógio/sleep injetados que inspecionem os argumentos exatos, conclusão longa e timeout.

Adicione `/.artifacts/` ao `.gitignore`; dumps e evidências de benchmark não podem aparecer no staging de Git. O nome lógico do dump aceito pela API é sempre `argus_dump.sql.gz`, portanto cada tamanho usa seu próprio diretório e nunca um nome como `argus-100k.sql.gz`.

**2. Confirme o RED, implemente e confirme o GREEN**

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest tests/unit/test_build_benchmark_snapshot.py tests/performance/test_snapshot_reader_benchmark.py -q
)
node --test scripts/tests/aws-learner-lab.test.mjs
```

**3. Execute a verificação local completa**

```bash
cd apps/backend/ingestion-data
.venv/bin/python -m pytest -m "not mysql" -q
.venv/bin/python -m ruff check .
.venv/bin/python -m mypy bootstrap
cd ../../..
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml config --quiet
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python -m pytest -m mysql -q
)
```

Esperado: todos passam.

**4. Commit o harness antes de qualquer rollout**

O builder, o benchmark e o wrapper usados abaixo precisam existir no checkout que contém o state. Ainda no worktree isolado e limpo, versione primeiro todo o código necessário ao rollout:

```bash
git add -- .gitignore apps/backend/ingestion-data/scripts/build_benchmark_snapshot.py apps/backend/ingestion-data/scripts/benchmark_snapshot_reader.py apps/backend/ingestion-data/tests/unit/test_build_benchmark_snapshot.py apps/backend/ingestion-data/tests/performance/test_snapshot_reader_benchmark.py apps/backend/ingestion-data/README.md scripts/aws-learner-lab.mjs scripts/tests/aws-learner-lab.test.mjs
git diff --cached --name-only
git commit -m "test(ingestion): benchmark resilient mysql pagination"
```

**5. Faça o canário no Learner Lab**

Gere as duas amostras e seus manifests:

```bash
mkdir -p .artifacts/argus-benchmarks/100k .artifacts/argus-benchmarks/1m
cd apps/backend/ingestion-data
.venv/bin/python scripts/build_benchmark_snapshot.py --rows 100000 --snapshot-extracted-on 2026-09-01 --variant baseline --output ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/100k/manifest.json
.venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant baseline --output ../../../.artifacts/argus-benchmarks/1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/1m/manifest.json
```

Meça localmente os três page sizes em execuções limpas comparáveis e faça a desconexão determinística em uma quarta execução separada:

```bash
(
  cd apps/backend/ingestion-data
  trap 'docker compose -f docker-compose.test.yml down --volumes' EXIT
  docker compose -f docker-compose.test.yml up -d --wait mysql
  .venv/bin/python scripts/benchmark_snapshot_reader.py --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --rows 100000 --page-size 2000 --output-json ../../../.artifacts/argus-benchmarks/local-100k-p2000-clean.json
  .venv/bin/python scripts/benchmark_snapshot_reader.py --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --rows 100000 --page-size 5000 --output-json ../../../.artifacts/argus-benchmarks/local-100k-p5000-clean.json
  .venv/bin/python scripts/benchmark_snapshot_reader.py --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --rows 100000 --page-size 10000 --output-json ../../../.artifacts/argus-benchmarks/local-100k-p10000-clean.json
  .venv/bin/python scripts/benchmark_snapshot_reader.py --snapshot ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --rows 100000 --page-size 5000 --disconnect-after-page 10 --output-json ../../../.artifacts/argus-benchmarks/local-100k-p5000-retry.json
)
```

Nos três runs limpos, exija `missing=0`, `duplicates=0`, `retries=0` e `lastQuartileP99Ms <= 1,25 * firstQuartileP99Ms`. Entre os elegíveis, escolha o maior throughput; diferença de até 2% é empate e favorece o menor page size. O quarto run deve registrar exatamente um retry e ainda terminar sem ausência/duplicação, mas não participa da escolha de throughput.

Depois de concluir e commitar o trabalho no worktree, use `superpowers:finishing-a-development-branch` para integrar esses commits no checkout original. A partir deste ponto, todos os comandos AWS rodam exclusivamente no checkout original que contém o state local; se ele não estiver limpo, pare para consolidar o trabalho do usuário. Não copie o state para o worktree:

```bash
cd /home/messias/Documentos/github/g05-md7/g05
test "$(pwd -P)" = /home/messias/Documentos/github/g05-md7/g05
git status --short
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test -f apps/fullstack/terraform.tfstate
test ! -L apps/fullstack/terraform.tfstate
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs check
aws sts get-caller-identity --profile default --region us-east-1
```

Como `.artifacts` é ignorado e não acompanha os commits entre worktrees, regenere as amostras determinísticas no checkout original (repita o bootstrap do início do plano se a `.venv` não existir) e compare os hashes/manifests com os registrados no benchmark local:

```bash
mkdir -p .artifacts/argus-benchmarks/100k .artifacts/argus-benchmarks/1m
(
  cd apps/backend/ingestion-data
  test -x .venv/bin/python
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 100000 --snapshot-extracted-on 2026-09-01 --variant baseline --output ../../../.artifacts/argus-benchmarks/100k/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/100k/manifest.json
  .venv/bin/python scripts/build_benchmark_snapshot.py --rows 1000000 --snapshot-extracted-on 2026-09-01 --variant baseline --output ../../../.artifacts/argus-benchmarks/1m/argus_dump.sql.gz --manifest ../../../.artifacts/argus-benchmarks/1m/manifest.json
)
```

Só então faça o update e os canários administrativos:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update phase1-5000
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs seed --snapshot .artifacts/argus-benchmarks/100k/argus_dump.sql.gz --extracted-on 2026-09-01 --label phase1-100k --timeout-seconds 21600
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs seed --snapshot .artifacts/argus-benchmarks/1m/argus_dump.sql.gz --extracted-on 2026-09-01 --label phase1-1m --timeout-seconds 21600
```

Substitua apenas o nome do preset no primeiro comando se o benchmark local escolher 2.000 ou 10.000; não passe `-var` manual. `seed` exercita diretamente o backfill administrativo/worker e não comprova upload, autenticação ou importação pelo painel; esses fluxos entram nos canários `import-canary` das fases 2 e 3. Aborte se a identidade não for a conta esperada do Learner Lab. Critérios:

- zero registros ausentes/duplicados;
- p99 das páginas não cresce continuamente com o cursor;
- a falha 2013 local injetada retoma a mesma página;
- nenhum candidato é ativado durante o canário;
- o throughput e os tempos reais são anexados à seção de benchmark da especificação.

Não rode o dump completo ainda: a meta abaixo de duas horas é critério da fase 2, quando a escrita quente sair do caminho crítico.

Ensaie o rollback depois de coletar evidência (o comando mostra e valida o plan antes de pedir confirmação):

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 node scripts/aws-learner-lab.mjs update baseline
```

**6. Registre e versione somente a evidência**

Depois do canário e do ensaio de rollback, acrescente à especificação os hashes dos manifests, page size escolhido, throughput, p95/p99, retry injetado e tempos do Learner Lab. Esse commit é feito no checkout original, depois da integração; não misture novamente os arquivos de implementação já versionados:

```bash
git add -- docs/superpowers/specs/2026-09-20-argus-import-performance-resilience-design.md
git diff --cached --name-only
git commit -m "docs(ingestion): record phase 1 benchmark evidence"
```

## Gate para iniciar a fase 2

- Configuração, retry e preflight cobertos por testes.
- O retry 2006/2013 não duplica nem pula páginas.
- Os três índices problemáticos são criados e reutilizados.
- O EXPLAIN não usa filesort para a paginação por cursor.
- O canário de 1 milhão de linhas registra throughput e p95/p99.
- Rollback por `MYSQL_SNAPSHOT_PREPARE_ENABLED=false` foi ensaiado.
