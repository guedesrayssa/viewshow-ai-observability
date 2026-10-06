# MR 90 Observability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MR 90 safe to merge by repairing the ingestion Grafana dashboard, the standalone EC2 bootstrap, and the evidence trail, then validating the result locally and in the AWS Learner Lab.

**Architecture:** Keep CloudWatch as the authoritative ingestion data source and preserve both deployment paths. The Terraform path continues rendering templates with `templatefile` and gzip-compressed user data; the standalone path renders the same ingestion dashboard values, embeds it, and sends the complete bootstrap as gzip binary user data. Deterministic Node tests validate dashboard semantics and shell bootstrap behavior before any AWS action.

**Tech Stack:** Terraform 1.16.4, AWS provider 5.x, Grafana 13 dashboard JSON, CloudWatch metric math, POSIX shell/Bash, Node.js 22 `node:test`, AWS CLI v2, Amazon Linux 2023 cloud-init.

## Global Constraints

- Prefix every shell command with `rtk` per `/home/messiasolivindo/.codex/RTK.md`.
- Cap Terraform test parallelism at `-parallelism=2`; do not run memory-heavy suites concurrently.
- Use Node.js `22.20.0` from `/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin`.
- Do not reuse any saved Terraform plan; the shared state changed after the original review.
- Do not apply AWS changes until `voclabs`, account `992648496097`, region `us-east-1`, state serial, and current observability instance are freshly verified.
- Reject any plan containing unrelated API, frontend, ingestion-task, data, or network changes.
- Never print or commit the Grafana password, tokens, signed URLs, Terraform state, or raw user data.
- Treat the two previously observed Terraform test failures as baseline candidates; do not silently classify them as regressions or fix them outside this MR's scope.

---

## File Map

- Create `apps/fullstack/tests/observability_dashboard.test.mjs`: render the Terraform dashboard template with fixtures and validate metric/query/selector semantics.
- Create `apps/fullstack/tests/observability_bootstrap.test.mjs`: execute the standalone renderer and validate shell output, gzip output, placeholders, and byte limits.
- Modify `apps/fullstack/observability/aws/view-show-ingestion.json.tftpl`: correct throughput/error math, labels, and the correlated operation selector.
- Modify `apps/fullstack/observability/aws/validate-user-data.sh`: render and embed the ingestion dashboard and emit validated gzip user data.
- Modify `apps/fullstack/observability/aws/deploy-learner-lab.sh`: send the gzip payload with `fileb://`.
- Modify `apps/fullstack/observability/README.md`: document the corrected standalone payload and dashboard behavior.
- Modify `artefatos/testes-carga-finais.md`: distinguish configured, locally validated, AWS-accepted, deployed, and measured states.
- Modify `assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md`: remove unsupported durable-evidence claims, then append fresh AWS evidence after validation.
- Modify `tasks/plan.md`: add the implementation/repair phase that the current scope omits.
- Modify `tasks/todo.md`: track dashboard, bootstrap, evidence, and AWS verification acceptance criteria.
- Create sanitized AWS evidence files under `assets/testes-carga/2026-10-04-ingestao/` only after the live rerun.

---

### Task 1: Repair dashboard metric semantics and selector correlation

**Files:**
- Create: `apps/fullstack/tests/observability_dashboard.test.mjs`
- Modify: `apps/fullstack/observability/aws/view-show-ingestion.json.tftpl:20-61`
- Modify: `apps/fullstack/observability/aws/view-show-ingestion.json.tftpl:128-131`

**Interfaces:**
- Consumes: Terraform placeholders declared by `local.dashboard_ingestion` in `apps/fullstack/observability-aws.tf`.
- Produces: valid Grafana JSON whose `operation` variable text is the ingestion command and whose value is the matching ECS task-definition family.

- [ ] **Step 1: Add a fixture renderer and failing semantic tests**

Create `apps/fullstack/tests/observability_dashboard.test.mjs` with:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const templatePath = path.join(
  testDirectory,
  "..",
  "observability",
  "aws",
  "view-show-ingestion.json.tftpl",
);

const fixture = Object.freeze({
  account_id: "123456789012",
  aws_region: "us-east-1",
  metrics_namespace: "view-show/Ingestion",
  cluster_name: "view-show-iac-cluster",
  backfill_task_family: "view-show-ingestion-backfill",
  sync_task_family: "view-show-ingestion-sync",
  incremental_export_task_family: "view-show-ingestion-incremental-export",
  incremental_ingest_task_family: "view-show-ingestion-incremental-ingest",
  analysis_queue: "view-show-ingestion-analysis",
  analysis_dlq: "view-show-ingestion-analysis-dlq",
  incremental_queue: "view-show-ingestion-incremental-batches.fifo",
  incremental_dlq: "view-show-ingestion-incremental-batches-dlq.fifo",
  backfill_log_group: "/ecs/view-show-ingestion-backfill",
  sync_log_group: "/ecs/view-show-ingestion-sync",
  incremental_export_log_group: "/ecs/view-show-ingestion-incremental-export",
  incremental_ingest_log_group: "/ecs/view-show-ingestion-incremental-ingest",
});

function renderDashboard() {
  const operationTextMarker = "__GRAFANA_OPERATION_TEXT__";
  let rendered = readFileSync(templatePath, "utf8").replaceAll(
    "$${operation:text}",
    operationTextMarker,
  );
  for (const [key, value] of Object.entries(fixture)) {
    rendered = rendered.replaceAll(`\${${key}}`, value);
  }
  rendered = rendered.replaceAll(operationTextMarker, "${operation:text}");
  return JSON.parse(rendered);
}

function panelByTitle(dashboard, title) {
  const panel = dashboard.panels.find((candidate) => candidate.title === title);
  assert.ok(panel, `missing panel: ${title}`);
  return panel;
}

test("throughput uses read and write terminal metrics with valid fixed-period math", () => {
  const panel = panelByTitle(renderDashboard(), "Throughput — registros/s");
  const rawMetrics = panel.targets.filter((target) => target.metricName);
  assert.deepEqual(
    rawMetrics.map((target) => target.metricName).sort(),
    ["RecordsRead", "RecordsWritten"],
  );
  assert.ok(panel.targets.some((target) => target.expression === "SUM(records_read)/300"));
  assert.ok(panel.targets.some((target) => target.expression === "SUM(records_written)/300"));
});

test("metric math never calls PERIOD on CloudWatch search results", () => {
  const expressions = renderDashboard().panels
    .flatMap((panel) => panel.targets ?? [])
    .map((target) => target.expression)
    .filter(Boolean);
  assert.ok(expressions.length > 0);
  assert.ok(expressions.every((expression) => !/\bPERIOD\s*\(/.test(expression)));
});

test("error rates use the same explicit 300 second period", () => {
  const panel = panelByTitle(renderDashboard(), "Erros por segundo");
  assert.ok(
    panel.targets.some(
      (target) => target.expression === "(SUM(failed_runs)+SUM(partial_runs))/300",
    ),
  );
  assert.ok(
    panel.targets.some((target) => target.expression === "SUM(rejected_records)/300"),
  );
});

test("one operation selector correlates command text and ECS task family", () => {
  const dashboard = renderDashboard();
  assert.deepEqual(dashboard.templating.list.map((variable) => variable.name), ["operation"]);
  assert.deepEqual(
    dashboard.templating.list[0].options.map(({ text, value }) => [text, value]),
    [
      ["backfill", fixture.backfill_task_family],
      ["sync", fixture.sync_task_family],
      ["export-incremental", fixture.incremental_export_task_family],
      ["ingest-incremental", fixture.incremental_ingest_task_family],
    ],
  );

  const throughput = panelByTitle(dashboard, "Throughput — registros/s");
  for (const target of throughput.targets.filter((candidate) => candidate.metricName)) {
    assert.deepEqual(target.dimensions.command, ["${operation:text}"]);
  }

  const cpu = panelByTitle(dashboard, "CPU da task — utilizada/reservada");
  for (const target of cpu.targets.filter((candidate) => candidate.metricName)) {
    assert.deepEqual(target.dimensions.TaskDefinitionFamily, ["$operation"]);
  }
});

test("panel ids and target refIds are unique", () => {
  const dashboard = renderDashboard();
  assert.equal(new Set(dashboard.panels.map((panel) => panel.id)).size, dashboard.panels.length);
  for (const panel of dashboard.panels) {
    const refIds = (panel.targets ?? []).map((target) => target.refId);
    assert.equal(new Set(refIds).size, refIds.length, `duplicate refId in ${panel.title}`);
    assert.equal(panel.datasource?.uid, "cloudwatch");
  }
});
```

- [ ] **Step 2: Run the focused test and verify the current branch fails**

Run:

```bash
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk node --test apps/fullstack/tests/observability_dashboard.test.mjs
```

Expected: FAIL because the current template uses `MySqlPageRows`, `PERIOD(...)`, and separate `command`/`task_family` variables.

- [ ] **Step 3: Replace throughput and error metric math**

In `view-show-ingestion.json.tftpl`, replace the throughput targets with these four targets:

```json
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"dimensions":{"command":["$${operation:text}"]},"hide":true,"id":"records_read","matchExact":false,"metricEditorMode":0,"metricQueryType":0,"metricName":"RecordsRead","namespace":"${metrics_namespace}","period":"300","queryMode":"Metrics","refId":"A","region":"${aws_region}","statistic":"Sum"},
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"dimensions":{"command":["$${operation:text}"]},"hide":true,"id":"records_written","matchExact":false,"metricEditorMode":0,"metricQueryType":0,"metricName":"RecordsWritten","namespace":"${metrics_namespace}","period":"300","queryMode":"Metrics","refId":"B","region":"${aws_region}","statistic":"Sum"},
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"expression":"SUM(records_read)/300","id":"read_rate","label":"lidos/s","metricQueryType":1,"queryMode":"Metrics","refId":"C","region":"${aws_region}"},
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"expression":"SUM(records_written)/300","id":"write_rate","label":"escritos/s","metricQueryType":1,"queryMode":"Metrics","refId":"D","region":"${aws_region}"}
```

Replace the two visible error expressions with:

```json
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"expression":"(SUM(failed_runs)+SUM(partial_runs))/300","id":"error_rate","label":"execuções com erro/s","metricQueryType":1,"queryMode":"Metrics","refId":"D","region":"${aws_region}"},
{"datasource":{"type":"cloudwatch","uid":"cloudwatch"},"expression":"SUM(rejected_records)/300","id":"rejection_rate","label":"registros rejeitados/s","metricQueryType":1,"queryMode":"Metrics","refId":"E","region":"${aws_region}"}
```

Replace every application-metric command dimension `"$command"` with `"$${operation:text}"`.

- [ ] **Step 4: Replace the two selectors with one key/value selector**

Replace `templating.list` with:

```json
"templating":{"list":[
  {
    "current":{"selected":true,"text":"backfill","value":"${backfill_task_family}"},
    "hide":0,
    "includeAll":false,
    "label":"Operação",
    "multi":false,
    "name":"operation",
    "options":[
      {"selected":true,"text":"backfill","value":"${backfill_task_family}"},
      {"selected":false,"text":"sync","value":"${sync_task_family}"},
      {"selected":false,"text":"export-incremental","value":"${incremental_export_task_family}"},
      {"selected":false,"text":"ingest-incremental","value":"${incremental_ingest_task_family}"}
    ],
    "query":"backfill : ${backfill_task_family},sync : ${sync_task_family},export-incremental : ${incremental_export_task_family},ingest-incremental : ${incremental_ingest_task_family}",
    "type":"custom"
  }
]}
```

Replace Container Insights task-family values `"$task_family"` with `"$operation"`.

- [ ] **Step 5: Correct misleading panel semantics**

In the latency panel, add `"label":"execução p95"` to the `RunDurationMs`
target, add `"label":"projeção máxima"` to the
`StageDurationMs{stage=PROJECTING}` target, and rename the title to
`Latência — execução p95 e projeção máxima`. Keep the CPU documentation at
average utilization because both raw CPU queries use `"statistic":"Average"`.
Do not claim that the projecting stage is a maximum `RunDurationMs`.

- [ ] **Step 6: Run the focused test and verify it passes**

Run the Step 2 command again.

Expected: `5` tests pass, `0` fail.

- [ ] **Step 7: Commit the dashboard repair**

```bash
rtk git add apps/fullstack/tests/observability_dashboard.test.mjs \
  apps/fullstack/observability/aws/view-show-ingestion.json.tftpl
rtk git commit -m "fix: repair ingestion dashboard queries"
```

---

### Task 2: Restore and compress the standalone bootstrap

**Files:**
- Create: `apps/fullstack/tests/observability_bootstrap.test.mjs`
- Modify: `apps/fullstack/observability/aws/validate-user-data.sh:25-87`
- Modify: `apps/fullstack/observability/aws/deploy-learner-lab.sh:41-47,68-81`

**Interfaces:**
- Consumes: `validate-user-data.sh OUTPUT_PATH` with `RENDER_AWS_ACCOUNT_ID`, `RENDER_AWS_REGION`, and `RENDER_GRAFANA_PASSWORD`.
- Produces: validated plain shell at `OUTPUT_PATH` and the exact EC2 payload at `OUTPUT_PATH.gz`.

- [ ] **Step 1: Add a failing bootstrap regression test**

Create `apps/fullstack/tests/observability_bootstrap.test.mjs` with:

```js
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(
  testDirectory,
  "..",
  "observability",
  "aws",
  "validate-user-data.sh",
);

test("standalone renderer embeds the ingestion dashboard in gzip EC2 user data", () => {
  const workDirectory = mkdtempSync(path.join(tmpdir(), "view-show-observability-test-"));
  try {
    const output = path.join(workDirectory, "user-data.sh");
    const result = spawnSync("sh", [script, output], {
      encoding: "utf8",
      env: {
        ...process.env,
        RENDER_AWS_ACCOUNT_ID: "123456789012",
        RENDER_AWS_REGION: "us-east-1",
        RENDER_GRAFANA_PASSWORD: "test-password-not-deployed",
      },
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const plain = readFileSync(output);
    const compressedPath = `${output}.gz`;
    const compressed = readFileSync(compressedPath);
    assert.ok(statSync(compressedPath).size <= 16_384);
    assert.deepEqual(gunzipSync(compressed), plain);

    const shell = plain.toString("utf8");
    assert.match(shell, /view-show-ingestion\.json/);
    assert.doesNotMatch(shell, /\$\{ingestion_dashboard_gzip\}/);
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the bootstrap test and verify it fails**

```bash
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk node --test apps/fullstack/tests/observability_bootstrap.test.mjs
```

Expected: FAIL with unresolved `${ingestion_dashboard_gzip}` or missing `user-data.sh.gz`.

- [ ] **Step 3: Render the standalone ingestion dashboard**

In `validate-user-data.sh`, after rendering `view-show-aws.json`, render `view-show-ingestion.json` using this mapping:

```sh
sed \
  -e "s|\${account_id}|$(escape_sed_replacement "${RENDER_AWS_ACCOUNT_ID}")|g" \
  -e "s|\${aws_region}|$(escape_sed_replacement "${RENDER_AWS_REGION}")|g" \
  -e 's|${metrics_namespace}|view-show/Ingestion|g' \
  -e 's|${cluster_name}|view-show-iac-cluster|g' \
  -e 's|${backfill_task_family}|view-show-ingestion-backfill|g' \
  -e 's|${sync_task_family}|view-show-ingestion-sync|g' \
  -e 's|${incremental_export_task_family}|view-show-ingestion-incremental-export|g' \
  -e 's|${incremental_ingest_task_family}|view-show-ingestion-incremental-ingest|g' \
  -e 's|${analysis_queue}|view-show-ingestion-analysis|g' \
  -e 's|${analysis_dlq}|view-show-ingestion-analysis-dlq|g' \
  -e 's|${incremental_queue}|view-show-ingestion-incremental-batches.fifo|g' \
  -e 's|${incremental_dlq}|view-show-ingestion-incremental-batches-dlq.fifo|g' \
  -e 's|${backfill_log_group}|/ecs/view-show-ingestion-backfill|g' \
  -e 's|${sync_log_group}|/ecs/view-show-ingestion-sync|g' \
  -e 's|${incremental_export_log_group}|/ecs/view-show-ingestion-incremental-export|g' \
  -e 's|${incremental_ingest_log_group}|/ecs/view-show-ingestion-incremental-ingest|g' \
  -e 's/$${/${/g' \
  "${SCRIPT_DIR}/view-show-ingestion.json.tftpl" \
  >"${RENDER_WORK_DIR}/view-show-ingestion.json"
```

Add:

```sh
INGESTION_DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-ingestion.json")
```

Add this replacement to the final `sed` invocation:

```sh
-e "s|\${ingestion_dashboard_gzip}|${INGESTION_DASHBOARD_GZIP}|g" \
```

- [ ] **Step 4: Validate the compressed payload rather than rejecting the expanded script**

Replace the current uncompressed byte check with:

```sh
gzip -9 -c "${OUTPUT_PATH}" >"${OUTPUT_PATH}.gz"

if [ "$(wc -c <"${OUTPUT_PATH}.gz")" -gt 16384 ]; then
  echo "User data comprimido excede o limite de 16 KiB da EC2." >&2
  exit 1
fi
```

Keep `sh -n` and unresolved-placeholder validation against the expanded shell before creating the gzip file.

- [ ] **Step 5: Send binary gzip user data from the deploy script**

In `deploy-learner-lab.sh`, replace:

```bash
--user-data "file://${WORK_DIR}/user-data.sh" \
```

with:

```bash
--user-data "fileb://${WORK_DIR}/user-data.sh.gz" \
```

- [ ] **Step 6: Run focused bootstrap validation**

```bash
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk node --test apps/fullstack/tests/observability_bootstrap.test.mjs
rtk bash apps/fullstack/observability/aws/deploy-learner-lab.sh --validate-only
```

Expected: Node test passes; the shell command prints `User data do deploy isolado renderizado e validado.` and exits `0`.

- [ ] **Step 7: Commit the standalone bootstrap repair**

```bash
rtk git add apps/fullstack/tests/observability_bootstrap.test.mjs \
  apps/fullstack/observability/aws/validate-user-data.sh \
  apps/fullstack/observability/aws/deploy-learner-lab.sh
rtk git commit -m "fix: restore standalone observability bootstrap"
```

---

### Task 3: Reconcile documentation and evidence claims

**Files:**
- Modify: `apps/fullstack/observability/README.md:104-140,215-229`
- Modify: `artefatos/testes-carga-finais.md:18-23,64-76,117-166,243-252`
- Modify: `assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md:1-59`
- Modify: `tasks/plan.md:1-177`
- Modify: `tasks/todo.md:1-120`

**Interfaces:**
- Consumes: the corrected dashboard and bootstrap behavior from Tasks 1-2.
- Produces: documentation that never upgrades configuration or an uncommitted browser observation into durable measured evidence.

- [ ] **Step 1: Update the operational README**

Document that the standalone renderer produces both `user-data.sh` for syntax inspection and `user-data.sh.gz` as the EC2 payload. State that `--validate-only` validates all four dashboards, unresolved placeholders, shell syntax, and the compressed 16 KiB limit.

Replace the statement that separate `Comando` and `Task ECS` filters keep data aligned with a statement that the single `Operação` selector maps command text to its corresponding task family.

- [ ] **Step 2: Correct the load-test artifact before the AWS rerun**

Change the state summary so it says:

```text
O dashboard está versionado e validado localmente. A nova validação AWS e a
captura durável permanecem pendentes após as correções do MR 90.
```

Describe throughput as two series, `RecordsRead/300` and `RecordsWritten/300`.
Remove claims that all panels were already validated. Preserve the historical
150k benchmark numbers, but keep them explicitly separate from the repaired
dashboard validation.

- [ ] **Step 3: Mark the old Grafana record as historical and incomplete**

At the top of `grafana-ingestion-validation.md`, add:

```markdown
> Registro histórico, não suficiente como aceite do MR 90: a captura citada não
> foi versionada e as consultas de throughput/erros não foram validadas nessa
> rodada. A validação substituta será registrada em um diretório datado novo.
```

Do not delete the historical instance ID or observations; label their limits.

- [ ] **Step 4: Extend the task plan and checklist**

Append this phase to `tasks/plan.md`, replacing the old claim that implementation
is entirely outside the document's scope:

```markdown
## Fase de implementação e aceite do MR 90

- [x] Corrigir throughput e erros/s com período CloudWatch fixo de 300 s.
- [x] Correlacionar comando e família ECS em um único seletor `operation`.
- [x] Restaurar o bootstrap isolado com user data gzip menor ou igual a 16 KiB.
- [x] Cobrir dashboard e bootstrap com regressões locais determinísticas.
- [ ] Validar todas as consultas com credenciais AWS Learner Lab renovadas.
- [ ] Aplicar somente o plano Terraform aprovado e registrar evidência durável.
```

Append this acceptance task to `tasks/todo.md`:

```markdown
## Tarefa 5: Implementar e validar o módulo Grafana da ingestão

**Critérios de aceite:**

- [x] Dashboard renderiza JSON válido e usa `RecordsRead`/`RecordsWritten`.
- [x] Nenhuma expressão aplica `PERIOD()` a resultado de `SEARCH`.
- [x] Um seletor correlaciona os quatro comandos às quatro famílias ECS.
- [x] Bootstrap isolado inclui o dashboard e respeita 16 KiB comprimidos.
- [ ] CloudWatch aceita as quatro expressões reparadas.
- [ ] Grafana provisionado está saudável e a captura sanitizada foi versionada.
```

Leave both AWS items unchecked until Tasks 5-7 produce their evidence.

- [ ] **Step 5: Check Markdown paths and contradictions**

```bash
rtk rg -n "implantado e validado|captura confirmou|ainda não há capturas|Comando.*Task ECS|fora de escopo" \
  artefatos/testes-carga-finais.md \
  assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md \
  tasks/plan.md tasks/todo.md apps/fullstack/observability/README.md
rtk git diff --check
```

Expected: no unsupported present-tense claim remains; any historic wording is explicitly labeled; `git diff --check` exits `0`.

- [ ] **Step 6: Commit the documentation reconciliation**

```bash
rtk git add apps/fullstack/observability/README.md \
  artefatos/testes-carga-finais.md \
  assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md \
  tasks/plan.md tasks/todo.md
rtk git commit -m "docs: align ingestion observability evidence"
```

---

### Task 4: Run the complete local verification gate

**Files:**
- Verify only; modify implementation files only when a failure is caused by Tasks 1-3.

**Interfaces:**
- Consumes: all repaired code and documentation.
- Produces: fresh command evidence separating repair results from pre-existing baseline failures.

- [ ] **Step 1: Check memory pressure**

```bash
rtk free -h
```

Expected: enough available memory to run one build or test process at a time. If available memory is below 4 GiB, stop other heavy processes before continuing.

- [ ] **Step 2: Run focused Node tests sequentially**

```bash
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk node --test apps/fullstack/tests/observability_dashboard.test.mjs
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk node --test apps/fullstack/tests/observability_bootstrap.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 3: Run Terraform static validation**

```bash
PATH=/tmp/codex-mr90-tools:$PATH rtk terraform -chdir=apps/fullstack fmt -check -recursive
PATH=/tmp/codex-mr90-tools:$PATH rtk terraform -chdir=apps/fullstack init -backend=false -input=false
PATH=/tmp/codex-mr90-tools:$PATH rtk terraform -chdir=apps/fullstack validate
```

Expected: all commands exit `0`.

- [ ] **Step 4: Run Terraform mock tests with bounded parallelism**

```bash
PATH=/tmp/codex-mr90-tools:$PATH \
  rtk terraform -chdir=apps/fullstack test -parallelism=2 -no-color
```

Expected repair-specific result: no observability test fails. If the same two known failures remain, verify that their implicated files are unchanged by this repair:

```bash
rtk git diff refs/mr/90/merge^1...HEAD -- \
  apps/fullstack/names.tf \
  apps/fullstack/ecs.tf \
  apps/fullstack/outputs.tf \
  apps/fullstack/tests/ingestion_defaults.tftest.hcl \
  apps/fullstack/tests/ingestion_production.tftest.hcl
```

Expected: empty diff for the implicated baseline files. Any new or changed failure blocks progress.

- [ ] **Step 5: Run the frontend production build with Node.js 22**

```bash
PATH=/home/messiasolivindo/.nvm/versions/node/v22.20.0/bin:$PATH \
  rtk npm run build
```

Working directory: `apps/frontend`.

Expected: Next.js build exits `0` and generates all static routes.

- [ ] **Step 6: Run final local hygiene checks**

```bash
rtk bash apps/fullstack/observability/aws/deploy-learner-lab.sh --validate-only
rtk git diff --check refs/mr/90/merge^1...HEAD
rtk git status --short --branch
```

Expected: bootstrap validation passes; no whitespace errors; only intentional committed changes exist.

- [ ] **Step 7: Commit any verification-only correction**

If a repair-specific failure required a code change, repeat its focused red/green test and commit only that correction:

```bash
rtk git add apps/fullstack/observability/aws/view-show-ingestion.json.tftpl \
  apps/fullstack/observability/aws/validate-user-data.sh \
  apps/fullstack/observability/aws/deploy-learner-lab.sh \
  apps/fullstack/tests/observability_dashboard.test.mjs \
  apps/fullstack/tests/observability_bootstrap.test.mjs
rtk git commit -m "test: close observability regression gap"
```

If no file changed, do not create an empty commit.

---

### Task 5: Validate the repaired queries against AWS without applying infrastructure

**Files:**
- Create after successful calls: `assets/testes-carga/2026-10-04-ingestao/cloudwatch-query-validation.json`
- Modify after successful calls: `tasks/todo.md`

**Interfaces:**
- Consumes: renewed Learner Lab credentials and the exact expressions from the repaired dashboard.
- Produces: sanitized raw CloudWatch acceptance evidence before Terraform apply.

- [ ] **Step 1: Verify current credentials and account**

```bash
rtk aws sts get-caller-identity --region us-east-1
rtk aws ec2 describe-vpcs --region us-east-1 --max-items 1
```

Expected: assumed role ARN matches `arn:aws:sts::992648496097:assumed-role/voclabs/...`; both commands exit `0`. `RequestExpired` stops this task without AWS mutations.

- [ ] **Step 2: Submit the repaired throughput expression to CloudWatch**

Run the exact dashboard expressions against the historical benchmark window:

```bash
rtk aws cloudwatch get-metric-data \
  --region us-east-1 \
  --start-time 2026-09-29T23:45:00Z \
  --end-time 2026-09-30T03:00:00Z \
  --scan-by TimestampAscending \
  --metric-data-queries "[{\"Id\":\"records_read\",\"Expression\":\"SEARCH('{view-show/Ingestion,command} MetricName=\\\"RecordsRead\\\" AND command=\\\"backfill\\\"', 'Sum', 300)\",\"ReturnData\":false},{\"Id\":\"records_written\",\"Expression\":\"SEARCH('{view-show/Ingestion,command} MetricName=\\\"RecordsWritten\\\" AND command=\\\"backfill\\\"', 'Sum', 300)\",\"ReturnData\":false},{\"Id\":\"read_rate\",\"Expression\":\"SUM(records_read)/300\",\"Label\":\"read_rate\",\"ReturnData\":true},{\"Id\":\"write_rate\",\"Expression\":\"SUM(records_written)/300\",\"Label\":\"write_rate\",\"ReturnData\":true}]" \
  --query 'MetricDataResults[].{Id:Id,StatusCode:StatusCode,Messages:Messages,PointCount:length(Values)}' \
  --output json
```

Expected: command exits `0`; no `Unsupported operand type(s) for PERIOD` error.

- [ ] **Step 3: Submit the repaired error expressions to CloudWatch**

Run:

```bash
rtk aws cloudwatch get-metric-data \
  --region us-east-1 \
  --start-time 2026-09-29T23:45:00Z \
  --end-time 2026-09-30T03:00:00Z \
  --scan-by TimestampAscending \
  --metric-data-queries "[{\"Id\":\"failed_runs\",\"Expression\":\"SEARCH('{view-show/Ingestion,command,status} MetricName=\\\"Runs\\\" AND command=\\\"backfill\\\" AND status=\\\"FAILED\\\"', 'Sum', 300)\",\"ReturnData\":false},{\"Id\":\"partial_runs\",\"Expression\":\"SEARCH('{view-show/Ingestion,command,status} MetricName=\\\"Runs\\\" AND command=\\\"backfill\\\" AND status=\\\"PARTIAL\\\"', 'Sum', 300)\",\"ReturnData\":false},{\"Id\":\"rejected_records\",\"Expression\":\"SEARCH('{view-show/Ingestion,command} MetricName=\\\"RecordsRejected\\\" AND command=\\\"backfill\\\"', 'Sum', 300)\",\"ReturnData\":false},{\"Id\":\"error_rate\",\"Expression\":\"(SUM(failed_runs)+SUM(partial_runs))/300\",\"Label\":\"error_rate\",\"ReturnData\":true},{\"Id\":\"rejection_rate\",\"Expression\":\"SUM(rejected_records)/300\",\"Label\":\"rejection_rate\",\"ReturnData\":true}]" \
  --query 'MetricDataResults[].{Id:Id,StatusCode:StatusCode,Messages:Messages,PointCount:length(Values)}' \
  --output json
```

Expected: command exits `0`. Empty values are acceptable for a sparse window; expression validation errors are not.

- [ ] **Step 4: Save sanitized query evidence**

Create a JSON document containing:

```json
{
  "accountId": "992648496097",
  "region": "us-east-1",
  "windowUtc": {
    "start": "2026-09-29T23:45:00Z",
    "end": "2026-09-30T03:00:00Z"
  },
  "queries": [
    {"name": "read_rate", "expression": "SUM(records_read)/300", "status": "Complete"},
    {"name": "write_rate", "expression": "SUM(records_written)/300", "status": "Complete"},
    {"name": "error_rate", "expression": "(SUM(failed_runs)+SUM(partial_runs))/300", "status": "Complete"},
    {"name": "rejection_rate", "expression": "SUM(rejected_records)/300", "status": "Complete"}
  ]
}
```

Create the file with `apply_patch`, populate statuses from the real AWS response, then validate it with:

```bash
rtk jq -e '
  .accountId == "992648496097" and
  .region == "us-east-1" and
  (.queries | length == 4) and
  ([.queries[].status] | all(. == "Complete"))
' assets/testes-carga/2026-10-04-ingestao/cloudwatch-query-validation.json
```

Do not fabricate `Complete`. Exclude request IDs, credentials, and unrelated account resources.

- [ ] **Step 5: Commit API acceptance evidence**

```bash
rtk git add assets/testes-carga/2026-10-04-ingestao/cloudwatch-query-validation.json \
  tasks/todo.md
rtk git commit -m "test: validate ingestion metric math in AWS"
```

---

### Task 6: Generate and review a fresh Terraform plan

**Files:**
- Read only: `/home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate`
- Generate ignored sensitive artifact: `apps/fullstack/.terraform-artifacts/mr90-observability.tfplan`

**Interfaces:**
- Consumes: the current state and repaired branch after Tasks 1-5.
- Produces: a new reviewed plan or a safe stop; never an automatic apply.

- [ ] **Step 1: Record state identity without exposing contents**

```bash
rtk jq '{terraform_version,serial,lineage}' \
  /home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate
rtk sha256sum \
  /home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate
```

Expected: valid state metadata and a checksum. Record them in the working notes, not in committed evidence.

- [ ] **Step 2: Inspect the current AWS observability instance**

```bash
rtk aws ec2 describe-instances --region us-east-1 \
  --filters Name=tag:Name,Values=view-show-observabilidade \
    Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].{Id:InstanceId,State:State.Name,LaunchTime:LaunchTime,ManagedBy:Tags[?Key==`ManagedBy`]|[0].Value}' \
  --output table
```

Expected: exactly one Terraform-managed instance or an explicit explanation before proceeding.

- [ ] **Step 3: Generate a fresh full plan against the current local state**

Run the exact Learner Lab variable set with observability enabled:

```bash
rtk mkdir -p apps/fullstack/.terraform-artifacts
AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 PATH=/tmp/codex-mr90-tools:$PATH \
  rtk terraform -chdir=apps/fullstack plan \
    -input=false \
    -parallelism=2 \
    -lock-timeout=30s \
    -state=/home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate \
    -var=deployment_namespace=view-show \
    -var=regiao=us-east-1 \
    -var=ambiente=learner-lab \
    -var=observabilidade_habilitada=true \
    -var=bedrock_habilitado=false \
    -var=bastion_key_name=vockey \
    -var=tipo_instancia_bastion=t3.micro \
    -var=cpu_task=256 \
    -var=memoria_task=512 \
    -var=quantidade_tasks=1 \
    -var=ecs_capacidade_minima=1 \
    -var=ecs_capacidade_maxima=4 \
    -var=ingestion_backfill_cpu=2048 \
    -var=ingestion_backfill_memoria=8192 \
    -var=ingestion_backfill_ephemeral_storage_gib=200 \
    -var=ingestion_sync_cpu=1024 \
    -var=ingestion_sync_memoria=2048 \
    -var=scheduler_ingestao_habilitado=false \
    -var=force_destroy_bucket_ingestao=true \
    -var=force_delete_ecr_ingestao=true \
    -out=.terraform-artifacts/mr90-observability.tfplan \
    -compact-warnings \
    -no-color
rtk chmod 600 apps/fullstack/.terraform-artifacts/mr90-observability.tfplan
```

Expected: plan generation succeeds. Do not apply it in this step.

- [ ] **Step 4: Reduce the plan to an address/action allowlist**

```bash
PATH=/tmp/codex-mr90-tools:$PATH \
  rtk terraform -chdir=apps/fullstack show -json \
    .terraform-artifacts/mr90-observability.tfplan |
  rtk jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions|join("/"))\t\(.address)"'
```

Allowed changes are restricted to the observability EC2 instance, its observability-specific security group/rules when required, and observability outputs/password lifecycle when required. Any API task, frontend deployment, ingestion task definition, scheduler, bucket, data, network, or path-only `terraform_data` change rejects the plan.

- [ ] **Step 5: Stop safely if the plan is broad**

If the plan contains any rejected address, do not use `-target` as a shortcut and do not apply from the review worktree. Remove only the stale plan file and defer apply until the repaired commit is present in the checkout that owns the current state.

```bash
rtk rm -- /home/messiasolivindo/Documentos/github/g05-md7/g05.worktrees/mr-90-review/apps/fullstack/.terraform-artifacts/mr90-observability.tfplan
```

Expected: infrastructure remains unchanged.

- [ ] **Step 6: Obtain explicit plan approval before apply**

Present the exact address/action list, expected EC2 replacement, cost impact, and state checksum to the user. Do not continue to Task 7 until the user approves this exact fresh plan.

---

### Task 7: Apply and validate the observability stack in AWS

**Files:**
- Modify: `artefatos/testes-carga-finais.md`
- Modify: `assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md`
- Create: `assets/testes-carga/2026-10-04-ingestao/grafana-dashboard-validation.json`
- Create: `assets/testes-carga/2026-10-04-ingestao/grafana-ingestion.png`
- Modify: `tasks/todo.md`

**Interfaces:**
- Consumes: the user-approved saved plan from Task 6.
- Produces: updated Terraform state, healthy observability services, and durable sanitized evidence.

- [ ] **Step 1: Reconfirm state checksum and plan freshness**

Re-run the Task 6 state metadata and checksum commands. If the checksum changed, discard the plan and return to Task 6.

- [ ] **Step 2: Apply only the approved saved plan**

Run:

```bash
AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 PATH=/tmp/codex-mr90-tools:$PATH \
  rtk terraform -chdir=apps/fullstack apply \
    -input=false \
    -parallelism=2 \
    -state=/home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate \
    -backup=/home/messiasolivindo/Documentos/github/g05-md7/g05/apps/fullstack/terraform.tfstate.mr90-backup \
    .terraform-artifacts/mr90-observability.tfplan
```

Never run an unsaved `terraform apply`.

Expected: apply exits `0` and updates the same state lineage.

- [ ] **Step 3: Wait for EC2, SSM, and cloud-init**

Use EC2 waiters and an SSM read-only command that runs:

```text
cloud-init status --wait
sudo docker compose -f /opt/view-show-observability/docker-compose.yml ps
curl --fail --silent http://127.0.0.1:3000/api/health
test -f /opt/view-show-observability/grafana/provisioning/dashboards/json/view-show-ingestion.json
sudo jq -e . /opt/view-show-observability/grafana/provisioning/dashboards/json/view-show-ingestion.json
```

Expected: cloud-init `done`, five containers running, Grafana database `ok`, dashboard file present, JSON valid.

- [ ] **Step 4: Validate Grafana dashboard and CloudWatch data source through SSM**

Source `/opt/view-show-observability/.env` only inside the remote shell, use the password for local authenticated calls, and return only sanitized fields:

- dashboard UID and title;
- data-source UID and health status;
- query HTTP status and result frame counts;
- no authorization headers or response containing secrets.

Expected: dashboard UID `view-show-ingestion`; CloudWatch data source healthy; all required query requests return HTTP `200` without expression errors.

- [ ] **Step 5: Capture visual evidence**

Open the SSM port-forwarding tunnel, select each of the four operation options, and capture a screenshot of the repaired dashboard using the historical benchmark window. The screenshot must show title, UTC window, `Operação`, units, and legends. Do not show credentials or unrelated dashboards.

- [ ] **Step 6: Write sanitized evidence and correct final claims**

Record actual instance ID, validation time, dashboard/data-source status, query status, and evidence paths. Update the load-test artifact from `pending` to `validated` only for checks actually performed. Preserve sparse/no-data results as such; do not turn successful query syntax into a performance claim.

- [ ] **Step 7: Commit AWS evidence and state-independent documentation**

```bash
rtk git add artefatos/testes-carga-finais.md \
  assets/testes-carga/2026-09-29-ingestao/grafana-ingestion-validation.md \
  assets/testes-carga/2026-10-04-ingestao/grafana-dashboard-validation.json \
  assets/testes-carga/2026-10-04-ingestao/grafana-ingestion.png \
  tasks/todo.md
rtk git commit -m "docs: record repaired Grafana validation"
```

Do not add Terraform state, plan files, `.env`, or password files.

---

### Task 8: Final review and MR branch handoff

**Files:**
- Review all files changed from `378bad39d102e5f33aabc136a1a868e37906c732` through `HEAD`.

**Interfaces:**
- Consumes: completed implementation and verification evidence.
- Produces: final merge verdict and, after user approval, an updated MR source branch.

- [ ] **Step 1: Run final fresh verification**

Repeat Task 4 focused tests, Terraform format/validate, bounded Terraform tests, frontend build, standalone validation, and `git diff --check`. Do not reuse earlier results.

- [ ] **Step 2: Request an adversarial review**

Review these dimensions independently:

- Grafana/CloudWatch query correctness;
- Terraform and shell bootstrap behavior;
- AWS change safety and state handling;
- security and secret exposure;
- documentation/evidence consistency;
- test coverage and regressions.

Fix every critical and important finding with a focused red/green test, then repeat final verification.

- [ ] **Step 3: Inspect the final commit range and worktree**

```bash
rtk git log --oneline refs/mr/90/merge^1..HEAD
rtk git diff --stat refs/mr/90/merge^1...HEAD
rtk git status --short --branch
```

Expected: intentional commits only; clean worktree.

- [ ] **Step 4: Present the final merge verdict**

Report:

- exact tests and counts;
- known baseline failures, if still present;
- AWS plan/apply scope;
- deployed service health;
- evidence paths;
- any remaining risk.

Only state `Ready to merge: Yes` if the design's merge criteria are all satisfied.

- [ ] **Step 5: Push the repaired source branch after user approval**

```bash
rtk git push origin HEAD:feat/observabilidade
```

Expected: GitLab updates MR 90 to the verified head. Do not merge the MR automatically unless the user separately requests the merge after reviewing the final verdict.
