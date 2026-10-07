import { test } from "node:test";
import assert from "node:assert/strict";
import { render, secretSelector, celLiteral } from "../render.mjs";
import { snapshotJob } from "../run-job.mjs";
import { config } from "./fixtures.mjs";
const rendered = await render(config, async () => "test-password");
const find = (kind, name) =>
  rendered.resources.find((r) => r.kind === kind && r.metadata.name === name);
test("analysis worker honors the zero-to-one replica gate", async () => {
  const gated = structuredClone(config);
  gated.analysis_enabled = true;
  for (const replicas of [0, 1]) {
    gated.analysis_replicas = replicas;
    const output = await render(gated, async () => "test-password");
    assert.equal(
      output.resources.find(
        (resource) =>
          resource.kind === "Deployment" &&
          resource.metadata.name === "analysis-worker",
      ).spec.replicas,
      replicas,
    );
  }
});
test("analysis replica gate rejects missing, fractional and out-of-range counts", async () => {
  for (const replicas of [undefined, -1, 2, 0.5, "1", null]) {
    await assert.rejects(
      render(
        { ...config, analysis_replicas: replicas },
        async () => "test-password",
      ),
      /Invalid analysis replica count/,
    );
  }
});
test("API-created import Jobs are constrained by a fail-closed admission policy", () => {
  const policy = find("ValidatingAdmissionPolicy", "view-show-import-jobs");
  const binding = find(
    "ValidatingAdmissionPolicyBinding",
    "view-show-import-jobs",
  );
  assert.ok(policy, "native import admission policy is required");
  assert.ok(binding, "native import admission binding is required");
  assert.equal(policy.metadata.namespace, undefined);
  assert.equal(binding.metadata.namespace, undefined);
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
  assert.equal(binding.spec.policyName, policy.metadata.name);
  assert.equal(
    binding.spec.matchResources.namespaceSelector.matchLabels[
      "kubernetes.io/metadata.name"
    ],
    "view-show-imports",
  );
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: ["batch"],
      apiVersions: ["v1"],
      operations: ["CREATE"],
      resources: ["jobs"],
      scope: "Namespaced",
    },
  ]);
  const contract = policy.spec.validations
    .map((validation) => validation.expression)
    .join("\n");
  for (const token of [
    "serviceAccountName",
    "ingestion-import",
    "mysql-snapshot",
    "import-dump",
    "emptyDir",
    "envFrom",
    "IMPORT_ID",
    "IMPORT_PIPELINE_VERSION",
    "secretKeyRef",
    "securityContext",
    "hostNetwork",
    "hostPID",
    "hostIPC",
    "shareProcessNamespace",
  ])
    assert.ok(contract.includes(token), `policy must constrain ${token}`);
  assert.match(
    policy.spec.matchConditions[0].expression,
    /system:serviceaccount:view-show:api/,
  );
});

test("API sync patches can only suspend or resume the exact CronJob", () => {
  const policy = find("ValidatingAdmissionPolicy", "view-show-sync-suspend");
  const binding = find(
    "ValidatingAdmissionPolicyBinding",
    "view-show-sync-suspend",
  );
  assert.ok(policy, "native sync admission policy is required");
  assert.ok(binding, "native sync admission binding is required");
  assert.equal(policy.metadata.namespace, undefined);
  assert.equal(binding.metadata.namespace, undefined);
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
  assert.equal(binding.spec.policyName, policy.metadata.name);
  assert.equal(
    binding.spec.matchResources.namespaceSelector.matchLabels[
      "kubernetes.io/metadata.name"
    ],
    "view-show",
  );
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: ["batch"],
      apiVersions: ["v1"],
      operations: ["UPDATE"],
      resources: ["cronjobs"],
      scope: "Namespaced",
    },
  ]);
  assert.equal(
    policy.spec.matchConditions[0].expression,
    'request.userInfo.username == "system:serviceaccount:view-show:api"',
  );
  const contract = policy.spec.validations
    .map((validation) => validation.expression)
    .join("\n");
  assert.ok(contract.includes('object.metadata.name == "ingestion-sync"'));
  assert.ok(contract.includes('object.metadata.namespace == "view-show"'));
  assert.ok(
    contract.includes("object.spec.jobTemplate == oldObject.spec.jobTemplate"),
  );
  for (const field of [
    "schedule",
    "timeZone",
    "startingDeadlineSeconds",
    "concurrencyPolicy",
    "successfulJobsHistoryLimit",
    "failedJobsHistoryLimit",
  ])
    assert.ok(
      contract.includes(`object.spec.${field}`) ||
        contract.includes(`object.spec.?${field}`),
      `sync admission must preserve ${field}`,
    );
  for (const field of [
    "labels",
    "annotations",
    "ownerReferences",
    "finalizers",
    "generateName",
  ])
    assert.ok(
      contract.includes(`object.metadata.?${field}`),
      `sync admission must preserve ${field}`,
    );
  assert.equal(
    contract.includes("object.spec.suspend == oldObject.spec.suspend"),
    false,
  );
});

test("import admission pins exact rendered environment, mounts, volumes and security contexts", () => {
  const policy = find("ValidatingAdmissionPolicy", "view-show-import-jobs");
  assert.ok(policy, "native import admission policy is required");
  const pod = find("CronJob", "ingestion-import").spec.jobTemplate.spec.template
    .spec;
  const contract = policy.spec.validations
    .map((validation) => validation.expression)
    .join("\n");
  for (const container of [pod.containers[0], pod.initContainers[0]]) {
    for (const field of [
      "image",
      "imagePullPolicy",
      "volumeMounts",
      "securityContext",
    ])
      assert.ok(
        contract.includes(celLiteral(container[field])),
        `policy must pin ${container.name}/${field}`,
      );
  }
  for (const [path, container] of [
    ["object.spec.template.spec.containers[0]", pod.containers[0]],
    ["object.spec.template.spec.initContainers[0]", pod.initContainers[0]],
  ])
    for (const [index, variable] of container.env.entries()) {
      const entry = `${path}.env[${index}]`;
      assert.ok(
        contract.includes(`${entry}.name == ${JSON.stringify(variable.name)}`),
      );
      assert.ok(
        contract.includes(
          `${entry}.?value.orValue("") == ${JSON.stringify(variable.value ?? "")}`,
        ),
      );
      assert.ok(
        contract.includes(
          variable.valueFrom
            ? `dyn(${entry}.valueFrom) == ${JSON.stringify(variable.valueFrom)}`
            : `!has(${entry}.valueFrom)`,
        ),
      );
    }
  assert.ok(contract.includes(celLiteral(pod.volumes)));
  assert.ok(contract.includes(celLiteral(pod.securityContext)));
  assert.ok(
    contract.includes(
      JSON.stringify(pod.initContainers[0].startupProbe.exec.command),
    ),
  );
  for (const field of ["periodSeconds", "timeoutSeconds", "failureThreshold"])
    assert.ok(
      contract.includes(
        `startupProbe.${field} == ${pod.initContainers[0].startupProbe[field]}`,
      ),
    );
  assert.match(contract, /startupProbe\.\?successThreshold\.orValue\(1\) == 1/);
  assert.match(
    contract,
    /startupProbe\.\?initialDelaySeconds\.orValue\(0\) == 0/,
  );
  for (const handler of ["httpGet", "tcpSocket", "grpc"])
    assert.ok(
      contract.includes(
        `!has(object.spec.template.spec.initContainers[0].startupProbe.${handler})`,
      ),
    );
  assert.ok(contract.includes(".?command.orValue([]).size() == 0"));
  assert.ok(contract.includes(".?envFrom.orValue([]).size() == 0"));
  assert.ok(
    contract.includes(
      `env[${pod.containers[0].env.length}].name == "IMPORT_ID"`,
    ),
  );
  assert.ok(
    contract.includes(
      `env[${pod.containers[0].env.length + 1}].name == "IMPORT_PIPELINE_VERSION"`,
    ),
  );
});

test("import admission normalizes empty static env values without weakening identities or Secret references", async () => {
  const input = structuredClone(config);
  for (const container of input.workloads["ingestion-import"].containers)
    container.env.push({ name: "ANALYSIS_FACT_CATALOG_LOCATION", value: "" });
  const output = await render(input, async () => "test-password");
  const contract = output.resources
    .find((resource) => resource.kind === "ValidatingAdmissionPolicy")
    .spec.validations.map((validation) => validation.expression)
    .join("\n");
  for (const path of [
    "object.spec.template.spec.containers[0]",
    "object.spec.template.spec.initContainers[0]",
  ]) {
    assert.ok(
      contract.includes(
        `${path}.env[1].name == "ANALYSIS_FACT_CATALOG_LOCATION"`,
      ),
    );
    assert.ok(
      contract.includes(`${path}.env[1].?value.orValue("") == ""`),
      "API omission of an empty value must remain valid",
    );
    assert.ok(contract.includes(`!has(${path}.env[1].valueFrom)`));
    assert.ok(contract.includes(`${path}.env[2].?value.orValue("") == ""`));
    assert.ok(
      contract.includes(`dyn(${path}.env[2].valueFrom) == {"secretKeyRef":`),
    );
  }
  assert.ok(
    contract.includes(
      "object.spec.template.spec.containers[0].env.size() == 6",
    ),
  );
  assert.ok(
    contract.includes(
      "object.spec.template.spec.initContainers[0].env.size() == 4",
    ),
  );
  assert.ok(
    contract.includes(
      'object.spec.template.spec.containers[0].env[4].name == "IMPORT_ID"',
    ),
  );
  assert.ok(
    contract.includes(
      'object.spec.template.spec.containers[0].env[5].name == "IMPORT_PIPELINE_VERSION"',
    ),
  );
  for (const [index, label] of [
    [4, "view-show/import-id"],
    [5, "view-show/pipeline"],
  ]) {
    const entry = `object.spec.template.spec.containers[0].env[${index}]`;
    assert.ok(
      contract.includes(
        `${entry}.?value.orValue("") == object.metadata.labels['${label}']`,
      ),
    );
    assert.ok(contract.includes(`!has(${entry}.valueFrom)`));
  }
  assert.equal(contract.includes(".env.filter("), false);
  assert.equal(contract.includes(".env.exists_one("), false);
});

test("import admission rejects reserved dynamic names in either static env list", async () => {
  for (const containerName of ["ingestion", "mysql-snapshot"])
    for (const name of ["IMPORT_ID", "IMPORT_PIPELINE_VERSION"]) {
      const input = structuredClone(config);
      input.workloads["ingestion-import"].containers
        .find((container) => container.name === containerName)
        .env.push({ name, value: "reserved" });
      await assert.rejects(
        render(input, async () => "test-password"),
        /Invalid import admission environment/,
      );
    }
});

test("import admission refuses a missing template or MySQL sidecar", async () => {
  for (const missing of ["template", "mysql"]) {
    const input = structuredClone(config);
    if (missing === "template") delete input.workloads["ingestion-import"];
    else
      input.workloads["ingestion-import"].containers = input.workloads[
        "ingestion-import"
      ].containers.filter((container) => container.name !== "mysql-snapshot");
    await assert.rejects(
      render(input, async () => "test-password"),
      /Invalid import admission configuration/,
    );
  }
});
test("snapshot workers await MySQL and can complete independently of sidecar", () => {
  const pod = find("CronJob", "ingestion-import").spec.jobTemplate.spec.template
    .spec;
  assert.equal(pod.initContainers[0].restartPolicy, "Always");
  assert.ok(pod.initContainers[0].startupProbe);
  assert.equal(pod.containers.length, 1);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.securityContext.fsGroup, 10001);
  assert.equal(
    find("CronJob", "ingestion-import").spec.jobTemplate.spec.backoffLimit,
    0,
  );
});
test("api has probes, resources, ALB binding and autoscaling", () => {
  const api = find("Deployment", "api").spec.template.spec.containers[0];
  assert.equal(api.readinessProbe.httpGet.path, "/health");
  assert.ok(api.startupProbe);
  assert.ok(api.livenessProbe);
  assert.equal(api.resources.requests.cpu, "500m");
  assert.equal(
    find("TargetGroupBinding", "api").spec.targetGroupARN,
    config.target_group_arn,
  );
  assert.equal(find("HorizontalPodAutoscaler", "api").spec.maxReplicas, 4);
});
test("schedules preserve frequencies, remain suspended, and forbid overlap", () => {
  for (const [name, schedule] of [
    ["ingestion-sync", "*/15 * * * *"],
    ["ingestion-incremental-export", "*/15 * * * *"],
    ["ingestion-incremental-ingest", "*/5 * * * *"],
  ]) {
    const cron = find("CronJob", name);
    assert.equal(cron.spec.schedule, schedule);
    assert.equal(cron.spec.suspend, true);
    assert.equal(cron.spec.concurrencyPolicy, "Forbid");
  }
});
test("API secret values never enter Pod plaintext env or ConfigMaps", () => {
  const api = find("Deployment", "api").spec.template.spec.containers[0];
  assert.deepEqual(api.env[0], {
    name: "AUTH_COOKIE_SECRET",
    valueFrom: { secretKeyRef: { name: "api-env", key: "AUTH_COOKIE_SECRET" } },
  });
  assert.equal(
    find("Secret", "api-env").stringData.AUTH_COOKIE_SECRET,
    "test-cookie-secret",
  );
});
test("import RBAC is isolated to import namespace without secret access", () => {
  const role = find("Role", "import-launcher");
  assert.equal(role.metadata.namespace, "view-show-imports");
  assert.ok(role.rules.every((r) => !r.resources.includes("secrets")));
  assert.equal(
    find("ServiceAccount", "ingestion-import").metadata.namespace,
    "view-show-imports",
  );
});
test("Secrets Manager selectors are checked", () => {
  assert.deepEqual(
    secretSelector(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:password::",
    ),
    {
      arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:live",
      key: "password",
    },
  );
  assert.throws(() => secretSelector("bad"));
});
test("manual backfill pins snapshot, has independent secret and never activates", () => {
  const snapshot = {
    bucket: "bucket",
    key: "dumps/a.sql.gz",
    versionId: "v1",
    sha256: "a".repeat(64),
    snapshotExtractedOn: "2026-09-30",
    size: 123,
  };
  const runbook = {
    namespace: "view-show",
    cluster_name: "cluster",
    storage: { bucket: "bucket" },
  };
  const first = snapshotJob(
    find("CronJob", "ingestion-backfill"),
    snapshot,
    runbook,
    "attempt-1",
  );
  const second = snapshotJob(
    find("CronJob", "ingestion-backfill"),
    snapshot,
    runbook,
    "attempt-1",
  );
  assert.equal(first.metadata.name, second.metadata.name);
  assert.notEqual(
    first.metadata.name,
    snapshotJob(
      find("CronJob", "ingestion-backfill"),
      snapshot,
      runbook,
      "attempt-2",
    ).metadata.name,
  );
  const pod = first.spec.template.spec;
  assert.equal(
    pod.containers[0].env.find((v) => v.name === "ACTIVATE_CANDIDATE").value,
    "false",
  );
  assert.equal(
    pod.containers[0].env.find((v) => v.name === "MYSQL_PASSWORD").valueFrom
      .secretKeyRef.name,
    `${first.metadata.name}-mysql`,
  );
  assert.throws(() =>
    snapshotJob(
      find("CronJob", "ingestion-backfill"),
      { ...snapshot, versionId: "null" },
      runbook,
      "attempt",
    ),
  );
});

test("missing live credentials are allowed only while the schedule is suspended", async () => {
  const input = structuredClone(config);
  input.workloads["ingestion-sync"].containers[0].secrets = [
    {
      name: "LIVE_MYSQL_PASSWORD",
      valueFrom:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:live:password::",
    },
  ];
  const output = await render(input, async ({ arn, optional }) => {
    if (arn.endsWith(":live")) {
      assert.equal(optional, true);
      return undefined;
    }
    return "snapshot-password";
  });
  assert.equal(
    output.resources.some(
      (r) => r.kind === "Secret" && r.metadata.name === "ingestion-sync-env",
    ),
    false,
  );
  const cron = output.resources.find(
    (r) => r.kind === "CronJob" && r.metadata.name === "ingestion-sync",
  );
  assert.equal(cron.spec.suspend, true);
  assert.equal(
    cron.spec.jobTemplate.spec.template.spec.containers[0].env[0].valueFrom
      .secretKeyRef.name,
    "ingestion-sync-env",
  );
  input.sync_enabled = true;
  await assert.rejects(
    render(input, async ({ arn }) =>
      arn.endsWith(":live") ? undefined : "snapshot-password",
    ),
    /Missing required secret/,
  );
});

test("Academy uses node credentials while retaining Kubernetes service accounts/RBAC", async () => {
  const lab = structuredClone(config);
  lab.iam_mode = "learner-lab-existing";
  lab.workload_roles = {};
  const output = await render(lab, async () => "test-password");
  for (const serviceAccount of output.resources.filter(
    (r) => r.kind === "ServiceAccount",
  ))
    assert.equal(
      serviceAccount.metadata.annotations?.["eks.amazonaws.com/role-arn"],
      undefined,
    );
  const api = output.resources.find(
    (r) => r.kind === "Deployment" && r.metadata.name === "api",
  );
  assert.equal(api.spec.template.spec.serviceAccountName, "api");
  const pod = output.resources.find(
    (r) => r.kind === "CronJob" && r.metadata.name === "ingestion-import",
  ).spec.jobTemplate.spec.template.spec;
  assert.equal(pod.containers[0].resources.requests.cpu, "500m");
  assert.equal(pod.initContainers[0].resources.requests.cpu, "500m");
  assert.equal(pod.containers[0].resources.limits.cpu, "1000m");
  assert.equal(
    api.spec.template.spec.containers[0].env.find(
      (v) => v.name === "AWS_EC2_METADATA_DISABLED",
    ).value,
    "false",
  );
  assert.equal(
    find("Deployment", "api").spec.template.spec.containers[0].env.find(
      (v) => v.name === "AWS_EC2_METADATA_DISABLED",
    ).value,
    "true",
  );
});
