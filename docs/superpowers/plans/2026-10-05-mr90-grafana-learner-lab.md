# MR 90 Grafana Learner Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Atualizar o MR 90 sobre o MR 96 e tornar `node apps/scripts/aws-learner-lab.mjs grafana` capaz de provisionar a observabilidade ausente, validar o Grafana e entregar acesso sem exigir Ollama.

**Architecture:** O MR 96 entra primeiro em `develop`; o MR 90 é sincronizado por merge para preservar seu histórico e evitar force-push. O comando `grafana` reutiliza o plano protegido `prepare-observability`, adiciona um health check SSM sem segredos e abre o túnel existente somente depois de confirmar Grafana, CloudWatch e dashboards.

**Tech Stack:** Node.js 22 (`node:test`), Terraform 1.7–1.x, AWS CLI v2, AWS Systems Manager, Grafana HTTP API, Bash do bootstrap EC2.

## Global Constraints

- Executar suítes Node com `--test-concurrency=1`; não rodar suítes pesadas em paralelo.
- Trabalhar apenas na worktree `g05.worktrees/mr-90-update`; preservar os outros checkouts.
- Não fazer push direto em `develop`; o MR 96 deve ser integrado pelo GitLab.
- Não imprimir senha do Grafana em saída não interativa, erros ou evidências.
- Ollama ausente deve produzir `NOT_CONFIGURED` com exit code zero após o Grafana ficar saudável.
- Uma EC2 de observabilidade existente e não saudável não pode ser substituída automaticamente.
- Todo `apply` deve consumir o mesmo plano salvo que passou pelo gate e pela verificação de identidade.
- Preservar simultaneamente os dashboards Agentic e Ingestão no bootstrap comprimido.

---

### Task 1: Integrar o MR 96 em `develop` com gate atualizado

**Files:**
- Verify only: `apps/scripts/aws-learner-lab.mjs`
- Verify only: `apps/scripts/terraform/validate-analysis-worker-plan.mjs`
- Verify only: `apps/scripts/tests/aws-learner-lab.test.mjs`

**Interfaces:**
- Consumes: MR 96 head `561d720ce6e086a989e4868b2052a75a0fb7564c` e merge preview `44500476079acb6c9fee2590d594ef11366bb9c8`.
- Produces: `origin/develop` contendo o head do MR 96, disponível como base do MR 90.

- [ ] **Step 1: Atualizar e confirmar os refs do MR 96**

Run:

```bash
git fetch origin \
  refs/merge-requests/96/head:refs/remotes/origin/mr-96-head \
  refs/merge-requests/96/merge:refs/remotes/origin/mr-96-merge
git rev-parse refs/remotes/origin/mr-96-head
git show -s --format='%H %P %s' refs/remotes/origin/mr-96-merge
```

Expected: head `561d720ce6e086a989e4868b2052a75a0fb7564c`; merge preview com primeiro pai igual ao `origin/develop` corrente.

- [ ] **Step 2: Reexecutar os gates do MR 96**

Run na worktree `g05.worktrees/mr-96-update`:

```bash
node --test --test-concurrency=1 apps/scripts/tests/validate-analysis-worker-plan.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/aws-learner-lab.test.mjs
git diff --check refs/remotes/origin/mr-96-merge^1...HEAD
```

Expected: 18/18 e 186/186 testes aprovados; `git diff --check` sem saída.

- [ ] **Step 3: Integrar o MR 96 pelo GitLab**

Abrir `https://git.inteli.edu.br/graduacao/2026-2a/t15/g05/-/merge_requests/96`, confirmar pipeline verde e usar o botão de merge. Não executar `git push origin HEAD:develop`.

- [ ] **Step 4: Confirmar a integração remota**

Run:

```bash
git fetch origin develop
git merge-base --is-ancestor 561d720ce6e086a989e4868b2052a75a0fb7564c origin/develop
```

Expected: exit code `0`.

---

### Task 2: Sincronizar o MR 90 e preservar os dois dashboards

**Files:**
- Modify: `apps/fullstack/observability-aws.tf`
- Modify: `apps/fullstack/observability/aws/user-data.sh.tftpl`
- Modify: `apps/fullstack/observability/aws/validate-user-data.sh`
- Verify: `apps/fullstack/observability/aws/view-show-agentic-aws.json.tftpl`
- Verify: `apps/fullstack/observability/aws/view-show-ingestion.json.tftpl`
- Test: `apps/fullstack/tests/observability_bootstrap.test.mjs`
- Test: `apps/fullstack/tests/observability_dashboard.test.mjs`

**Interfaces:**
- Consumes: branch `review/mr-90-update` no commit de especificação e `origin/develop` contendo o MR 96.
- Produces: árvore integrada com `local.agentic_dashboard_aws`, `local.dashboard_ingestion`, `agentic_dashboard_gzip` e `ingestion_dashboard_gzip` no mesmo `user_data_base64`.

- [ ] **Step 1: Registrar o baseline do MR 90 antes do merge**

Run:

```bash
node --test --test-concurrency=1 \
  apps/fullstack/tests/observability_bootstrap.test.mjs \
  apps/fullstack/tests/observability_dashboard.test.mjs
bash apps/fullstack/observability/aws/deploy-learner-lab.sh --validate-only
```

Expected: 8/8 testes aprovados e `User data do deploy isolado renderizado e validado.`

- [ ] **Step 2: Mesclar o novo `develop` sem reescrever o histórico do MR 90**

Run:

```bash
git fetch origin develop
git merge --no-ff origin/develop -m "merge: sync MR 90 with MR 96 automation"
```

Expected: conflitos somente nos três arquivos conhecidos; se outro arquivo conflitar, abortar com `git merge --abort` e voltar à investigação.

- [ ] **Step 3: Resolver `observability-aws.tf` mantendo os dois templates**

O bloco `locals` deve conter os dois valores e a instância deve usar o payload comprimido:

```hcl
  agentic_dashboard_aws = var.observabilidade_habilitada ? templatefile(
    "${path.module}/observability/aws/view-show-agentic-aws.json.tftpl",
    {
      aws_account_id            = data.aws_caller_identity.atual.account_id
      aws_region                = var.regiao
      analysis_worker_log_group = "/ecs/${var.deployment_namespace}-analysis-worker"
    }
  ) : ""

  dashboard_ingestion = var.observabilidade_habilitada ? templatefile(
    "${path.module}/observability/aws/view-show-ingestion.json.tftpl",
    {
      account_id                     = data.aws_caller_identity.atual.account_id
      aws_region                     = var.regiao
      metrics_namespace              = local.ingestion_metrics_namespace
      cluster_name                   = aws_ecs_cluster.principal.name
      backfill_task_family           = aws_ecs_task_definition.ingestion_backfill.family
      sync_task_family               = aws_ecs_task_definition.ingestion_sync.family
      incremental_export_task_family = aws_ecs_task_definition.ingestion_incremental_export.family
      incremental_ingest_task_family = aws_ecs_task_definition.ingestion_incremental_ingest.family
      analysis_queue                 = aws_sqs_queue.analysis.name
      analysis_dlq                   = aws_sqs_queue.analysis_dlq.name
      incremental_queue              = aws_sqs_queue.incremental_batches.name
      incremental_dlq                = aws_sqs_queue.incremental_batches_dlq.name
      backfill_log_group             = aws_cloudwatch_log_group.ingestion_backfill.name
      sync_log_group                 = aws_cloudwatch_log_group.ingestion_sync.name
      incremental_export_log_group   = aws_cloudwatch_log_group.ingestion_incremental_export.name
      incremental_ingest_log_group   = aws_cloudwatch_log_group.ingestion_incremental_ingest.name
    }
  ) : ""
```

E os argumentos do template devem terminar assim:

```hcl
    api_dashboard_gzip       = base64gzip(file("${path.module}/observability/grafana/provisioning/dashboards/json/view-show-api.json"))
    agentic_dashboard_gzip   = base64gzip(local.agentic_dashboard_aws)
    ingestion_dashboard_gzip = base64gzip(local.dashboard_ingestion)
  }))
```

- [ ] **Step 4: Resolver o bootstrap e renderer mantendo os dois dashboards**

Em `user-data.sh.tftpl`, manter as duas gravações:

```bash
write_config "$${STACK_DIR}/grafana/provisioning/dashboards/json/view-show-agentic-aws.json" "${agentic_dashboard_gzip}"
write_config "$${STACK_DIR}/grafana/provisioning/dashboards/json/view-show-ingestion.json" "${ingestion_dashboard_gzip}"
```

Em `validate-user-data.sh`, renderizar, validar e compactar ambos, definindo:

```bash
INGESTION_DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-ingestion.json")
AGENTIC_DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-agentic-aws.json")
```

e substituindo os dois placeholders no `sed` final:

```bash
  -e "s|\${ingestion_dashboard_gzip}|${INGESTION_DASHBOARD_GZIP}|g" \
  -e "s|\${agentic_dashboard_gzip}|${AGENTIC_DASHBOARD_GZIP}|g" \
```

- [ ] **Step 5: Concluir o merge e verificar o resultado combinado**

Run:

```bash
git add apps/fullstack/observability-aws.tf \
  apps/fullstack/observability/aws/user-data.sh.tftpl \
  apps/fullstack/observability/aws/validate-user-data.sh
git commit --no-edit
node --test --test-concurrency=1 \
  apps/fullstack/tests/observability_bootstrap.test.mjs \
  apps/fullstack/tests/observability_dashboard.test.mjs
bash apps/fullstack/observability/aws/deploy-learner-lab.sh --validate-only
git diff --check origin/develop...HEAD
```

Expected: merge concluído, 8/8 testes aprovados, renderer aprovado e diff sem whitespace inválido.

---

### Task 3: Definir contratos puros de saúde e status do Grafana

**Files:**
- Modify: `apps/scripts/lib/grafana-access.mjs`
- Create: `apps/scripts/tests/grafana-access.test.mjs`

**Interfaces:**
- Consumes: outputs Terraform e resposta JSON de `aws ssm get-command-invocation`.
- Produces: `grafanaHealthShellCommand(): string`, `readGrafanaHealthInvocation(value): { grafana: "READY", cloudwatch: "READY", dashboards: string[] }` e `readOllamaConfiguration(value): "CONFIGURED" | "NOT_CONFIGURED"`.

- [ ] **Step 1: Escrever testes que falham para os contratos puros**

Adicionar testes com estes casos:

```js
test("Grafana health command checks containers, CloudWatch and both dashboards without printing the password", () => {
  const command = grafanaHealthShellCommand();
  assert.match(command, /grafana.*prometheus.*loki.*tempo.*alloy/s);
  assert.match(command, /api\/datasources\/uid\/cloudwatch\/health/);
  assert.match(command, /api\/dashboards\/uid\/view-show-ingestion/);
  assert.match(command, /api\/dashboards\/uid\/view-show-agentic-aws/);
  assert.doesNotMatch(command, /echo.*GRAFANA_ADMIN_PASSWORD/);
});

test("Grafana health invocation accepts only the exact success sentinel", () => {
  assert.deepEqual(readGrafanaHealthInvocation({
    Status: "Success",
    StandardOutputContent: "GRAFANA_READY CLOUDWATCH_READY DASHBOARDS=view-show-ingestion,view-show-agentic-aws\n",
    StandardErrorContent: "",
  }), {
    grafana: "READY",
    cloudwatch: "READY",
    dashboards: ["view-show-ingestion", "view-show-agentic-aws"],
  });
  assert.throws(() => readGrafanaHealthInvocation({ Status: "Failed" }), /health check failed/);
});

test("Ollama configuration status never claims connectivity", () => {
  assert.equal(readOllamaConfiguration(null), "NOT_CONFIGURED");
  assert.equal(readOllamaConfiguration({ modelId: "qwen2.5:7b" }), "CONFIGURED");
  assert.equal(readOllamaConfiguration({}), "NOT_CONFIGURED");
});
```

- [ ] **Step 2: Executar os testes e confirmar a falha RED**

Run:

```bash
node --test --test-concurrency=1 apps/scripts/tests/grafana-access.test.mjs
```

Expected: FAIL porque as três funções ainda não são exportadas.

- [ ] **Step 3: Implementar os contratos mínimos**

Adicionar em `grafana-access.mjs`:

```js
const HEALTH_SENTINEL = /^GRAFANA_READY CLOUDWATCH_READY DASHBOARDS=view-show-ingestion,view-show-agentic-aws$/m;

export function grafanaHealthShellCommand() {
  return [
    "set -euo pipefail",
    "stack=/opt/view-show-observability",
    "test -f \"$stack/.provisioned\"",
    "cd \"$stack\"",
    "set -a; . ./.env; set +a",
    "for service in grafana prometheus loki tempo alloy; do docker compose ps --status running --services | grep -Fx \"$service\" >/dev/null; done",
    "curl --fail --silent http://127.0.0.1:3000/api/health | grep -Eq '\"database\"[[:space:]]*:[[:space:]]*\"ok\"'",
    "curl --fail --silent -u \"admin:$GRAFANA_ADMIN_PASSWORD\" http://127.0.0.1:3000/api/datasources/uid/cloudwatch/health | grep -Eiq 'success|ok'",
    "curl --fail --silent -u \"admin:$GRAFANA_ADMIN_PASSWORD\" http://127.0.0.1:3000/api/dashboards/uid/view-show-ingestion | grep -Fq '\"uid\":\"view-show-ingestion\"'",
    "curl --fail --silent -u \"admin:$GRAFANA_ADMIN_PASSWORD\" http://127.0.0.1:3000/api/dashboards/uid/view-show-agentic-aws | grep -Fq '\"uid\":\"view-show-agentic-aws\"'",
    "printf '%s\\n' 'GRAFANA_READY CLOUDWATCH_READY DASHBOARDS=view-show-ingestion,view-show-agentic-aws'",
  ].join("\n");
}

export function readGrafanaHealthInvocation(value) {
  if (!isRecord(value) || value.Status !== "Success" || !HEALTH_SENTINEL.test(String(value.StandardOutputContent ?? ""))) {
    throw new Error("Grafana health check failed");
  }
  return {
    grafana: "READY",
    cloudwatch: "READY",
    dashboards: ["view-show-ingestion", "view-show-agentic-aws"],
  };
}

export function readOllamaConfiguration(value) {
  return isRecord(value) && typeof value.modelId === "string" && value.modelId.length > 0
    ? "CONFIGURED"
    : "NOT_CONFIGURED";
}
```

- [ ] **Step 4: Executar os testes GREEN e commit**

Run:

```bash
node --test --test-concurrency=1 apps/scripts/tests/grafana-access.test.mjs
git add apps/scripts/lib/grafana-access.mjs apps/scripts/tests/grafana-access.test.mjs
git commit -m "test(tooling): define Grafana health contracts"
```

Expected: 3/3 testes aprovados e commit criado.

---

### Task 4: Tornar `grafana` idempotente com TDD

**Files:**
- Modify: `apps/scripts/aws-learner-lab.mjs`
- Modify: `apps/scripts/tests/aws-learner-lab.test.mjs`
- Modify: `apps/scripts/terraform/validate-analysis-worker-plan.mjs` only if the integrated plan reveals a legitimate new observability-only resource.
- Test: `apps/scripts/tests/validate-analysis-worker-plan.test.mjs`

**Interfaces:**
- Consumes: `prepareObservabilityVariables()`, `applyAnalysisPlan()`, `readObservabilityWorkersEndpoint()`, `grafanaHealthShellCommand()`, `readGrafanaHealthInvocation()` e `readOllamaConfiguration()`.
- Produces: `ensureGrafana(context, identity): Promise<"CREATED" | "EXISTING">` e `waitForGrafanaHealth(context, instanceId): Promise<HealthSummary>`.

- [ ] **Step 1: Escrever testes RED para provisionamento e reutilização**

Adicionar ao teste do Learner Lab casos que comprovem:

```js
test("grafana provisions missing observability before opening the tunnel", async () => {
  const a = testEnvironment({ observabilityEndpoint: null, isTty: true });
  const result = await runLearnerLab({ ...a.options, step: "grafana" });
  assert.equal(result.status, 0, a.logs.join("\n"));
  const plans = a.calls.filter((call) => call.command === "terraform" && call.args.includes("plan"));
  assert.equal(plans.length, 1);
  assert.ok(plans[0].args.includes("-var=observabilidade_habilitada=true"));
  assert.ok(a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")));
  assert.ok(a.logs.includes("Infraestrutura: CREATED"));
});

test("grafana reuses healthy observability without planning", async () => {
  const a = testEnvironment({ isTty: true });
  const result = await runLearnerLab({ ...a.options, step: "grafana" });
  assert.equal(result.status, 0, a.logs.join("\n"));
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")), false);
  assert.ok(a.logs.includes("Infraestrutura: EXISTING"));
});
```

- [ ] **Step 2: Escrever testes RED para segurança e saída**

Adicionar casos para:

```js
test("grafana reports optional Ollama and prints password only in a TTY", async () => {
  const interactive = testEnvironment({ isTty: true, analysisManifest: null });
  assert.equal((await runLearnerLab({ ...interactive.options, step: "grafana" })).status, 0);
  assert.ok(interactive.logs.includes("Grafana password: TestGrafanaPassword123"));
  assert.ok(interactive.logs.includes("Ollama/LLM: NOT_CONFIGURED"));

  const automated = testEnvironment({ isTty: false, analysisManifest: null });
  assert.equal((await runLearnerLab({ ...automated.options, step: "grafana" })).status, 0);
  assert.equal(automated.logs.some((line) => line.includes("TestGrafanaPassword123")), false);
});

test("grafana never replaces an existing unhealthy instance", async () => {
  const a = testEnvironment({ grafanaHealthStatus: "Failed" });
  const result = await runLearnerLab({ ...a.options, step: "grafana" });
  assert.equal(result.status, 1);
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("plan")), false);
  assert.equal(a.calls.some((call) => call.command === "terraform" && call.args.includes("apply")), false);
});
```

- [ ] **Step 3: Executar somente os novos testes para confirmar RED**

Run:

```bash
node --test --test-concurrency=1 \
  --test-name-pattern='grafana (provisions|reuses|reports|never)' \
  apps/scripts/tests/aws-learner-lab.test.mjs
```

Expected: FAIL nos comportamentos ainda ausentes.

- [ ] **Step 4: Implementar preflight e ambiente protegido para `grafana`**

Adicionar `grafana` a `PROTECTED_COMMANDS` somente no modo sem `--senha`. No preflight, o modo normal exige Terraform 1.7+, Node 22 e AWS CLI v2; `--senha` exige apenas Terraform. Aplicar os mesmos controles de workspace, variáveis automáticas e credenciais usados por `analysis-prepare`.

Usar esta condição compartilhada:

```js
const mutatingGrafana = step === "grafana" && !grafanaConfiguration?.showPassword;
```

e incluí-la nos conjuntos `needsTerraform`, `needsNode`, `needsAws`, no ambiente protegido e em `assertNoAutomaticVariableFiles`. O gate do ambiente protegido deve usar exatamente:

```js
if (PROTECTED_COMMANDS.has(step) && !(step === "grafana" && grafanaConfiguration?.showPassword)) {
  assertProtectedUpdateEnvironment({ environment, root, lstat, realpath });
}
```

- [ ] **Step 5: Implementar health check SSM e provisionamento idempotente**

Adicionar as funções:

```js
async function waitForGrafanaHealth(context, instanceId) {
  const deadline = context.monotonic() + 360;
  while (context.monotonic() <= deadline) {
    const sent = context.execute("aws", awsArguments(context, [
      "ssm", "send-command",
      "--instance-ids", instanceId,
      "--document-name", "AWS-RunShellScript",
      "--parameters", JSON.stringify({ commands: [grafanaHealthShellCommand()] }),
      "--output", "json",
    ]), { cwd: context.root });
    if (sent.status === 0) {
      const commandId = parseJsonObject(sent.stdout, "ssm send-command").Command?.CommandId;
      if (typeof commandId === "string") {
        const waited = context.execute("aws", awsArguments(context, [
          "ssm", "wait", "command-executed", "--command-id", commandId,
          "--instance-id", instanceId,
        ]), { cwd: context.root });
        if (waited.status === 0) {
          const invocation = context.execute("aws", awsArguments(context, [
            "ssm", "get-command-invocation", "--command-id", commandId,
            "--instance-id", instanceId, "--output", "json",
          ]), { cwd: context.root });
          if (invocation.status === 0) {
            return readGrafanaHealthInvocation(parseJsonObject(invocation.stdout, "Grafana health invocation"));
          }
        }
      }
    }
    await context.sleep(10_000);
  }
  throw new Error("Grafana did not become healthy before the deadline");
}

async function ensureGrafana(context, identity) {
  initializeAndValidateExistingStack(context, identity);
  if (readObservabilityWorkersEndpoint(context) !== null) return "EXISTING";
  const applied = await applyAnalysisPlan(
    context,
    identity,
    "prepare-observability",
    null,
    prepareObservabilityVariables(),
    { confirmationPhrase: `PROVISION GRAFANA ${identity.account}` },
  );
  if (!applied) throw new Error("Grafana provisioning was cancelled");
  return "CREATED";
}

function readGrafanaInstanceId(context) {
  const result = context.execute(
    "terraform",
    ["-chdir=apps/fullstack", "output", "-raw", "observabilidade_instancia_id"],
    terraformOptions({ ...context, analysisWorker: null }, { cwd: context.root }),
  );
  if (result.status !== 0) throw new Error("terraform output observabilidade_instancia_id failed");
  return readObservabilityInstanceId(result.stdout);
}

function readOptionalOllamaConfiguration(context) {
  const target = path.join(
    context.root,
    "apps",
    "fullstack",
    ".terraform-artifacts",
    "analysis-worker.json",
  );
  if (!context.exists(target)) return "NOT_CONFIGURED";
  try {
    return readOllamaConfiguration(parseJsonObject(context.readFile(target, "utf8"), "analysis worker manifest"));
  } catch {
    return "NOT_CONFIGURED";
  }
}
```

Estender `applyAnalysisPlan` com o último argumento opcional e manter a frase atual para os fluxos de análise:

```js
const phrase = options.confirmationPhrase ?? `${mode.toUpperCase()} ANALYSIS ${identity.account}`;
```

- [ ] **Step 6: Entregar status, credenciais e túnel somente após saúde**

Transformar `openGrafana` para receber `infrastructure` e `health`. Antes do túnel:

```js
context.log(`Infraestrutura: ${infrastructure}`);
context.log(`Grafana: ${health.grafana}`);
context.log(`CloudWatch: ${health.cloudwatch}`);
context.log("Dashboard: view-show-ingestion");
context.log(`Grafana URL: ${access.url}`);
context.log(`Grafana user: ${access.user}`);
if (context.isTty) {
  context.log(`Grafana password: ${readGrafanaPassword(passwordResult.stdout)}`);
} else {
  context.log("Grafana password omitted outside an interactive terminal; use grafana --senha interactively.");
}
context.log(`Ollama/LLM: ${ollamaStatus}`);
```

Definir `ollamaStatus` exclusivamente com `readOptionalOllamaConfiguration(context)`; esse caminho nunca executa conectividade nem lê o endpoint do Ollama.

No dispatcher:

```js
if (step === "grafana") {
  if (context.grafanaConfiguration.showPassword) {
    printGrafanaPassword(context);
    return { status: 0 };
  }
  const infrastructure = await ensureGrafana(context, checked.identity);
  const instanceId = readGrafanaInstanceId(context);
  const health = await waitForGrafanaHealth(context, instanceId);
  openGrafana(context, { infrastructure, health });
  return { status: 0 };
}
```

- [ ] **Step 7: Executar os testes GREEN e o gate completo**

Run:

```bash
node --test --test-concurrency=1 apps/scripts/tests/grafana-access.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/validate-analysis-worker-plan.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/aws-learner-lab.test.mjs
```

Expected: todos os testes aprovados, incluindo os 18 testes existentes do gate e pelo menos os 186 testes anteriores do Learner Lab.

- [ ] **Step 8: Commit da implementação**

Run:

```bash
git add apps/scripts/aws-learner-lab.mjs \
  apps/scripts/tests/aws-learner-lab.test.mjs \
  apps/scripts/terraform/validate-analysis-worker-plan.mjs
git commit -m "feat(tooling): provision Grafana from Learner Lab CLI"
```

---

### Task 5: Atualizar documentação operacional

**Files:**
- Modify: `apps/fullstack/README.md`
- Modify: `apps/fullstack/observability/README.md`
- Modify: `apps/scripts/aws-learner-lab.mjs` help text

**Interfaces:**
- Consumes: comportamento final do comando `grafana`.
- Produces: instruções reproduzíveis sem depender de Ollama.

- [ ] **Step 1: Atualizar help e README**

O help deve descrever:

```text
grafana         Ensure private observability exists, validate it and open the SSM tunnel
grafana --senha Print the local Grafana password without provisioning or opening a tunnel
```

Os READMEs devem usar:

```bash
node apps/scripts/aws-learner-lab.mjs grafana
```

e explicar que a primeira execução pede confirmação e pode criar a EC2 privada, enquanto execuções seguintes apenas validam e abrem o túnel. Documentar `Ollama/LLM: NOT_CONFIGURED` como estado saudável para o escopo do Grafana.

- [ ] **Step 2: Verificar documentação e commit**

Run:

```bash
git diff --check
rg -n "grafana|NOT_CONFIGURED|localhost:3002" \
  apps/fullstack/README.md \
  apps/fullstack/observability/README.md \
  apps/scripts/aws-learner-lab.mjs
git add apps/fullstack/README.md apps/fullstack/observability/README.md apps/scripts/aws-learner-lab.mjs
git commit -m "docs: document automatic Grafana provisioning"
```

Expected: nenhuma referência contradiz o comportamento idempotente.

---

### Task 6: Verificação final, teste AWS e atualização do MR 90

**Files:**
- Verify: all files changed since `origin/develop`
- Evidence only if sanitized: `assets/testes-carga/2026-10-05-ingestao/`

**Interfaces:**
- Consumes: MR 90 integrado e comando `grafana` completo.
- Produces: branch `feat/observabilidade` atualizada, evidência sanitizada e ambiente Learner Lab acessível.

- [ ] **Step 1: Executar verificação local completa de forma sequencial**

Run:

```bash
free -h
node --test --test-concurrency=1 apps/scripts/tests/grafana-access.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/validate-analysis-worker-plan.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/aws-learner-lab.test.mjs
node --test --test-concurrency=1 \
  apps/fullstack/tests/observability_bootstrap.test.mjs \
  apps/fullstack/tests/observability_dashboard.test.mjs
bash apps/fullstack/observability/aws/deploy-learner-lab.sh --validate-only
terraform -chdir=apps/fullstack fmt -check -recursive
terraform -chdir=apps/fullstack init -backend=false -input=false
terraform -chdir=apps/fullstack validate
terraform -chdir=apps/fullstack test
git diff --check origin/develop...HEAD
```

Expected: todas as suítes aprovadas; se Terraform não estiver instalado no host, executar os quatro comandos Terraform no AWS CloudShell antes de prosseguir.

- [ ] **Step 2: Comparar com um baseline limpo de `origin/develop`**

Criar uma worktree temporária irmã, executar nela as suítes do Learner Lab e do gate com a mesma concorrência e comparar falhas. Remover a worktree após a comparação:

```bash
git worktree add --detach /home/messiasolivindo/Documentos/github/g05-md7/g05.worktrees/develop-baseline origin/develop
cd /home/messiasolivindo/Documentos/github/g05-md7/g05.worktrees/develop-baseline
node --test --test-concurrency=1 apps/scripts/tests/validate-analysis-worker-plan.test.mjs
node --test --test-concurrency=1 apps/scripts/tests/aws-learner-lab.test.mjs
cd /home/messiasolivindo/Documentos/github/g05-md7/g05.worktrees/mr-90-update
git worktree remove /home/messiasolivindo/Documentos/github/g05-md7/g05.worktrees/develop-baseline
```

Expected: o MR 90 não introduz regressões nas suítes herdadas do MR 96.

- [ ] **Step 3: Executar o teste funcional no Learner Lab**

Com credenciais temporárias válidas no profile `default`, executar em terminal interativo:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 \
  node apps/scripts/aws-learner-lab.mjs grafana
```

Confirmar com a frase exibida pelo CLI. Expected na primeira execução: `Infraestrutura: CREATED`; Grafana, CloudWatch e dashboard `READY`; URL `http://localhost:3002`; usuário `admin`; senha mostrada apenas no terminal; `Ollama/LLM: NOT_CONFIGURED` ou `CONFIGURED`; túnel aberto até `Ctrl+C`.

- [ ] **Step 4: Repetir para provar idempotência**

Run novamente:

```bash
AWS_PROFILE=default AWS_REGION=us-east-1 \
  node apps/scripts/aws-learner-lab.mjs grafana
```

Expected: `Infraestrutura: EXISTING`, nenhum `terraform plan` ou `apply`, mesmas validações de saúde e túnel funcional.

- [ ] **Step 5: Revisar diff e histórico antes do push**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/feat/observabilidade..HEAD
git diff --stat origin/develop...HEAD
git diff --check origin/develop...HEAD
```

Expected: worktree limpa, somente commits do reparo do MR 90, especificação, integração, CLI e documentação.

- [ ] **Step 6: Atualizar a branch do MR 90 sem force-push**

Run:

```bash
git push origin HEAD:feat/observabilidade
git fetch origin refs/merge-requests/90/head:refs/remotes/origin/mr-90-head
git rev-parse HEAD
git rev-parse refs/remotes/origin/mr-90-head
```

Expected: os dois hashes finais idênticos. Abrir `https://git.inteli.edu.br/graduacao/2026-2a/t15/g05/-/merge_requests/90` e confirmar pipeline e merge preview atualizados.
