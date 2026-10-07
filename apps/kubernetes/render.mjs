import { createHash } from "node:crypto";

const names = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const sensitiveNames = /SECRET|PASSWORD/;
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** CEL infers one map value type; heterogeneous JSON needs explicit dyn values. */
export function celLiteral(value) {
  if (Array.isArray(value)) return `[${value.map(celLiteral).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const types = new Set(
      entries.map(([, v]) =>
        Array.isArray(v) ? "list" : v === null ? "null" : typeof v,
      ),
    );
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${types.size > 1 ? `dyn(${celLiteral(v)})` : celLiteral(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function secretSelector(value) {
  const match =
    /^(arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:[^:]+)(?::([^:]+)::)?$/.exec(
      value,
    );
  if (!match) throw new Error("Invalid Secrets Manager selector.");
  return { arn: match[1], key: match[2] };
}
/** Returns native resources; resolveSecret is injected to permit offline verification. */
export async function render(config, resolveSecret) {
  const ns = config.namespace;
  const labIam = config.iam_mode === "learner-lab-existing";
  if (!names.test(ns) || !names.test(`${ns}-imports`))
    throw new Error("Invalid namespace.");
  if (!(
    config.api_min_replicas >= 1 &&
    config.api_min_replicas <= config.api_replicas &&
    config.api_replicas <= config.api_max_replicas
  ))
    throw new Error("Invalid replica range.");
  if (
    !Number.isInteger(config.analysis_replicas) ||
    config.analysis_replicas < 0 ||
    config.analysis_replicas > 1
  )
    throw new Error("Invalid analysis replica count.");
  const resources = [];
  const add = (apiVersion, kind, name, spec, namespace = ns) => {
    const resource = {
      apiVersion,
      kind,
      metadata: { name, ...(namespace === null ? {} : { namespace }) },
      ...spec,
    };
    resources.push(resource);
    return resource;
  };
  for (const namespace of [ns, `${ns}-imports`]) {
    resources.push({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: { "pod-security.kubernetes.io/enforce": "baseline" },
      },
    });
    add(
      "networking.k8s.io/v1",
      "NetworkPolicy",
      "deny-ingress",
      { spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] } },
      namespace,
    );
  }
  const schedules = {
    "ingestion-backfill": "0 0 1 1 *",
    "ingestion-import": "0 0 1 1 *",
    "ingestion-sync": "*/15 * * * *",
    "ingestion-incremental-export": "*/15 * * * *",
    "ingestion-incremental-ingest": "*/5 * * * *",
  };
  let renderedImportTemplate;
  for (const [name, workload] of Object.entries(config.workloads)) {
    if (name === "analysis-worker" && !config.analysis_enabled) continue;
    const namespace = name === "ingestion-import" ? `${ns}-imports` : ns;
    if (!labIam && !config.workload_roles[name])
      throw new Error(`Missing workload role: ${name}`);
    add(
      "v1",
      "ServiceAccount",
      name,
      {
        automountServiceAccountToken: name === "api",
        metadata: {
          name,
          namespace,
          ...(labIam
            ? {}
            : {
                annotations: {
                  "eks.amazonaws.com/role-arn": config.workload_roles[name],
                },
              }),
        },
      },
      namespace,
    );
    const secretData = {};
    const snapshot = workload.containers.some(
      (c) => c.name === "mysql-snapshot",
    );
    const memory = Number(workload.memory);
    const cpu = Math.ceil((Number(workload.cpu) * 1000) / 1024);
    if (!(memory >= 128 && cpu >= 100))
      throw new Error(`Invalid resources: ${name}`);
    const containers = [];
    const initContainers = [];
    for (const source of workload.containers) {
      const mysql = source.name === "mysql-snapshot";
      const env = source.env.map((variable) => {
        if (!sensitiveNames.test(variable.name)) return variable;
        secretData[variable.name] = variable.value;
        return {
          name: variable.name,
          valueFrom: {
            secretKeyRef: { name: `${name}-env`, key: variable.name },
          },
        };
      });
      for (const selector of source.secrets) {
        const optional =
          (name === "ingestion-sync" && !config.sync_enabled) ||
          (name === "ingestion-incremental-export" &&
            !config.incremental_enabled);
        const value = await resolveSecret({
          ...secretSelector(selector.valueFrom),
          optional,
        });
        if (value === undefined && !optional)
          throw new Error(`Missing required secret for ${name}`);
        if (value !== undefined) secretData[selector.name] = value;
        if (value !== undefined && (typeof value !== "string" || !value))
          throw new Error(`Missing secret field for ${name}/${selector.name}`);
        env.push({
          name: selector.name,
          valueFrom: {
            secretKeyRef: { name: `${name}-env`, key: selector.name },
          },
        });
      }
      const container = {
        name: name === "api" ? "api" : source.name,
        image: source.image,
        imagePullPolicy: "IfNotPresent",
        ...(source.args.length ? { args: source.args } : {}),
        env: [
          ...env,
          {
            name: "AWS_EC2_METADATA_DISABLED",
            value: labIam ? "false" : "true",
          },
        ],
        securityContext: mysql
          ? {
              allowPrivilegeEscalation: false,
              runAsUser: 0,
              capabilities: {
                drop: ["ALL"],
                add: ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"],
              },
            }
          : {
              runAsNonRoot: true,
              runAsUser:
                name === "api" || name === "analysis-worker" ? 1000 : 10001,
              readOnlyRootFilesystem: true,
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
        resources: {
          requests: {
            cpu: `${snapshot ? Math.ceil(cpu / (labIam ? 4 : 2)) : cpu}m`,
            memory: `${snapshot ? Math.floor(memory / 2) : memory}Mi`,
            "ephemeral-storage": snapshot ? (mysql ? "128Gi" : "64Gi") : "1Gi",
          },
          limits: {
            cpu: `${snapshot ? Math.ceil(cpu / 2) : cpu}m`,
            memory: `${snapshot ? Math.floor(memory / 2) : memory}Mi`,
            "ephemeral-storage": snapshot
              ? mysql
                ? "130Gi"
                : "66Gi"
              : name.startsWith("ingestion")
                ? "20Gi"
                : "2Gi",
          },
        },
        volumeMounts: [
          { name: "tmp", mountPath: "/tmp" },
          ...(mysql
            ? [
                { name: "mysql-data", mountPath: "/var/lib/mysql" },
                { name: "mysql-run", mountPath: "/var/run/mysqld" },
              ]
            : []),
        ],
      };
      if (mysql) {
        container.restartPolicy = "Always";
        container.startupProbe = {
          exec: {
            command: [
              "sh",
              "-c",
              'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping --silent --protocol=TCP -h 127.0.0.1 -uroot',
            ],
          },
          periodSeconds: 5,
          timeoutSeconds: 3,
          failureThreshold: 60,
        };
        initContainers.push(container);
      } else {
        if (name === "api") {
          container.ports = [{ name: "http", containerPort: 3000 }];
          container.startupProbe = {
            httpGet: { path: "/health", port: "http" },
            periodSeconds: 3,
            failureThreshold: 30,
          };
          container.readinessProbe = {
            httpGet: { path: "/health", port: "http" },
            periodSeconds: 5,
            timeoutSeconds: 3,
          };
          container.livenessProbe = {
            httpGet: { path: "/health", port: "http" },
            periodSeconds: 15,
            timeoutSeconds: 3,
          };
        }
        containers.push(container);
      }
    }
    if (Object.keys(secretData).length)
      add(
        "v1",
        "Secret",
        `${name}-env`,
        { type: "Opaque", stringData: secretData },
        namespace,
      );
    const labels = { "app.kubernetes.io/name": name };
    const template = {
      metadata: {
        labels,
        annotations: {
          "view-show/config-hash": hash({ workload, secretData }),
        },
      },
      spec: {
        serviceAccountName: name,
        automountServiceAccountToken: name === "api",
        restartPolicy: name.startsWith("ingestion") ? "Never" : "Always",
        terminationGracePeriodSeconds: name === "analysis-worker" ? 120 : 60,
        securityContext: {
          fsGroup: 10001,
          fsGroupChangePolicy: "OnRootMismatch",
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers,
        ...(initContainers.length ? { initContainers } : {}),
        volumes: [
          {
            name: "tmp",
            emptyDir: {
              sizeLimit: snapshot
                ? "64Gi"
                : name.startsWith("ingestion")
                  ? "16Gi"
                  : "1Gi",
            },
          },
          ...(snapshot
            ? [
                { name: "mysql-data", emptyDir: { sizeLimit: "128Gi" } },
                { name: "mysql-run", emptyDir: {} },
              ]
            : []),
        ],
      },
    };
    if (name === "ingestion-import")
      renderedImportTemplate = structuredClone(template);
    if (name.startsWith("ingestion")) {
      const suspend =
        name === "ingestion-sync"
          ? !config.sync_enabled
          : name.includes("incremental")
            ? !config.incremental_enabled
            : true;
      add(
        "batch/v1",
        "CronJob",
        name,
        {
          spec: {
            schedule: schedules[name],
            timeZone: "Etc/UTC",
            suspend,
            concurrencyPolicy: "Forbid",
            startingDeadlineSeconds: 300,
            successfulJobsHistoryLimit: 2,
            failedJobsHistoryLimit: 5,
            jobTemplate: {
              spec: {
                backoffLimit: 0,
                activeDeadlineSeconds: snapshot ? 86400 : 3600,
                ttlSecondsAfterFinished: 604800,
                template,
              },
            },
          },
        },
        namespace,
      );
    } else {
      template.spec.topologySpreadConstraints = [
        {
          maxSkew: 1,
          topologyKey: "kubernetes.io/hostname",
          whenUnsatisfiable: "ScheduleAnyway",
          labelSelector: { matchLabels: labels },
        },
      ];
      add(
        "apps/v1",
        "Deployment",
        name,
        {
          spec: {
            replicas:
              name === "api" ? config.api_replicas : config.analysis_replicas,
            selector: { matchLabels: labels },
            strategy: {
              type: "RollingUpdate",
              rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
            },
            template,
          },
        },
        namespace,
      );
    }
  }
  const importWorker = renderedImportTemplate?.spec.containers.find(
    (container) => container.name === "ingestion",
  );
  const importMysql = renderedImportTemplate?.spec.initContainers?.find(
    (container) => container.name === "mysql-snapshot",
  );
  if (!renderedImportTemplate || !importWorker || !importMysql)
    throw new Error("Invalid import admission configuration.");
  const cel = celLiteral;
  const staticEnvChecks = (path, env) => {
    if (
      env.some((variable) =>
        ["IMPORT_ID", "IMPORT_PIPELINE_VERSION"].includes(variable.name),
      )
    )
      throw new Error("Invalid import admission environment.");
    return env
      .map((variable, index) => {
        const entry = `${path}[${index}]`;
        const literalValue =
          variable.valueFrom === undefined ? (variable.value ?? "") : "";
        return `${entry}.name == ${cel(variable.name)} && ${entry}.?value.orValue("") == ${cel(literalValue)} && ${
          variable.valueFrom === undefined
            ? `!has(${entry}.valueFrom)`
            : `dyn(${entry}.valueFrom) == ${cel(variable.valueFrom)}`
        }`;
      })
      .join(" && ");
  };
  const workerEnv = "object.spec.template.spec.containers[0].env";
  const mysqlEnv = "object.spec.template.spec.initContainers[0].env";
  const workerStaticEnvChecks = staticEnvChecks(workerEnv, importWorker.env);
  const mysqlStaticEnvChecks = staticEnvChecks(mysqlEnv, importMysql.env);
  const importIdEnv = `${workerEnv}[${importWorker.env.length}]`;
  const pipelineEnv = `${workerEnv}[${importWorker.env.length + 1}]`;
  add("v1", "Service", "api", {
    spec: {
      type: "ClusterIP",
      selector: { "app.kubernetes.io/name": "api" },
      ports: [{ name: "http", port: 3000, targetPort: "http" }],
    },
  });
  add("networking.k8s.io/v1", "NetworkPolicy", "api-ingress", {
    spec: {
      podSelector: { matchLabels: { "app.kubernetes.io/name": "api" } },
      policyTypes: ["Ingress"],
      ingress: [{ ports: [{ port: 3000, protocol: "TCP" }] }],
    },
  });
  add("elbv2.k8s.aws/v1beta1", "TargetGroupBinding", "api", {
    spec: {
      targetGroupARN: config.target_group_arn,
      targetType: "ip",
      serviceRef: { name: "api", port: 3000 },
      networking: {
        ingress: [
          {
            from: [
              {
                securityGroup: { groupID: config.target_group_security_group },
              },
            ],
            ports: [{ protocol: "TCP", port: 3000 }],
          },
        ],
      },
    },
  });
  add("autoscaling/v2", "HorizontalPodAutoscaler", "api", {
    spec: {
      scaleTargetRef: {
        apiVersion: "apps/v1",
        kind: "Deployment",
        name: "api",
      },
      minReplicas: config.api_min_replicas,
      maxReplicas: config.api_max_replicas,
      metrics: [
        {
          type: "Resource",
          resource: {
            name: "cpu",
            target: {
              type: "Utilization",
              averageUtilization: config.api_cpu_target,
            },
          },
        },
      ],
      behavior: { scaleDown: { stabilizationWindowSeconds: 300 } },
    },
  });
  add("policy/v1", "PodDisruptionBudget", "api", {
    spec: {
      maxUnavailable: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": "api" } },
    },
  });
  const apiSubject = [{ kind: "ServiceAccount", name: "api", namespace: ns }];
  add("rbac.authorization.k8s.io/v1", "Role", "argus-scheduler", {
    rules: [
      {
        apiGroups: ["batch"],
        resources: ["cronjobs"],
        resourceNames: ["ingestion-sync"],
        verbs: ["get", "patch"],
      },
    ],
  });
  add("rbac.authorization.k8s.io/v1", "RoleBinding", "argus-scheduler", {
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "Role",
      name: "argus-scheduler",
    },
    subjects: apiSubject,
  });
  add(
    "rbac.authorization.k8s.io/v1",
    "Role",
    "import-launcher",
    {
      rules: [
        { apiGroups: ["batch"], resources: ["jobs"], verbs: ["create", "get"] },
        {
          apiGroups: ["batch"],
          resources: ["cronjobs"],
          resourceNames: ["ingestion-import"],
          verbs: ["get"],
        },
      ],
    },
    `${ns}-imports`,
  );
  add(
    "rbac.authorization.k8s.io/v1",
    "RoleBinding",
    "import-launcher",
    {
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "Role",
        name: "import-launcher",
      },
      subjects: apiSubject,
    },
    `${ns}-imports`,
  );
  add(
    "admissionregistration.k8s.io/v1",
    "ValidatingAdmissionPolicy",
    `${ns}-import-jobs`,
    {
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: ["batch"],
              apiVersions: ["v1"],
              operations: ["CREATE"],
              resources: ["jobs"],
              scope: "Namespaced",
            },
          ],
        },
        matchConditions: [
          {
            name: "api-service-account",
            expression: `request.userInfo.username == ${cel(`system:serviceaccount:${ns}:api`)}`,
          },
        ],
        validations: [
          {
            expression: `object.metadata.namespace == ${cel(`${ns}-imports`)} && object.metadata.name.matches('^import-[a-z0-9]+$')`,
            message: "Import Job identity is invalid.",
          },
          {
            expression:
              "object.metadata.labels['app.kubernetes.io/name'] == 'ingestion-import' && object.metadata.labels['view-show/import-id'].matches('^imp_[0-7][0-9A-HJKMNP-TV-Z]{25}$') && object.metadata.labels['view-show/pipeline'] in ['legacy-v1', 'canonical-v2']",
            message: "Import Job labels are invalid.",
          },
          {
            expression:
              "object.spec.template.spec.serviceAccountName == 'ingestion-import' && !object.spec.template.spec.?automountServiceAccountToken.orValue(true) && (!has(object.spec.template.spec.hostNetwork) || !object.spec.template.spec.hostNetwork) && (!has(object.spec.template.spec.hostPID) || !object.spec.template.spec.hostPID) && (!has(object.spec.template.spec.hostIPC) || !object.spec.template.spec.hostIPC) && (!has(object.spec.template.spec.shareProcessNamespace) || !object.spec.template.spec.shareProcessNamespace) && object.spec.template.spec.restartPolicy == 'Never'",
            message: "Import Job Pod identity is invalid.",
          },
          {
            // Admission converts typed Jobs to maps, omitting empty repeated fields.
            expression: `object.spec.template.spec.containers.size() == 1 && object.spec.template.spec.containers[0].name == 'ingestion' && object.spec.template.spec.containers[0].image == ${cel(importWorker.image)} && object.spec.template.spec.containers[0].imagePullPolicy == ${cel(importWorker.imagePullPolicy)} && object.spec.template.spec.containers[0].?command.orValue([]).size() == 0 && object.spec.template.spec.containers[0].args == ['import-dump', '--import-id', string(object.metadata.labels['view-show/import-id'])] && object.spec.template.spec.containers[0].?envFrom.orValue([]).size() == 0 && ${workerEnv}.size() == ${importWorker.env.length + 2} && ${workerStaticEnvChecks} && ${importIdEnv}.name == "IMPORT_ID" && ${importIdEnv}.?value.orValue("") == object.metadata.labels['view-show/import-id'] && !has(${importIdEnv}.valueFrom) && ${pipelineEnv}.name == "IMPORT_PIPELINE_VERSION" && ${pipelineEnv}.?value.orValue("") == object.metadata.labels['view-show/pipeline'] && !has(${pipelineEnv}.valueFrom) && dyn(object.spec.template.spec.containers[0].volumeMounts) == ${cel(importWorker.volumeMounts)} && !has(object.spec.template.spec.containers[0].lifecycle) && !has(object.spec.template.spec.containers[0].startupProbe) && !has(object.spec.template.spec.containers[0].readinessProbe) && !has(object.spec.template.spec.containers[0].livenessProbe)`,
            message: "Import worker container is invalid.",
          },
          {
            // Pin the probe invariants while accepting Kubernetes' harmless defaults.
            expression: `object.spec.template.spec.initContainers.size() == 1 && object.spec.template.spec.initContainers[0].name == 'mysql-snapshot' && object.spec.template.spec.initContainers[0].image == ${cel(importMysql.image)} && object.spec.template.spec.initContainers[0].imagePullPolicy == ${cel(importMysql.imagePullPolicy)} && object.spec.template.spec.initContainers[0].restartPolicy == 'Always' && object.spec.template.spec.initContainers[0].?command.orValue([]).size() == 0 && object.spec.template.spec.initContainers[0].args == ${cel(importMysql.args)} && object.spec.template.spec.initContainers[0].?envFrom.orValue([]).size() == 0 && ${mysqlEnv}.size() == ${importMysql.env.length} && ${mysqlStaticEnvChecks} && dyn(object.spec.template.spec.initContainers[0].volumeMounts) == ${cel(importMysql.volumeMounts)} && object.spec.template.spec.initContainers[0].startupProbe.exec.command == ${cel(importMysql.startupProbe.exec.command)} && object.spec.template.spec.initContainers[0].startupProbe.periodSeconds == ${cel(importMysql.startupProbe.periodSeconds)} && object.spec.template.spec.initContainers[0].startupProbe.timeoutSeconds == ${cel(importMysql.startupProbe.timeoutSeconds)} && object.spec.template.spec.initContainers[0].startupProbe.failureThreshold == ${cel(importMysql.startupProbe.failureThreshold)} && object.spec.template.spec.initContainers[0].startupProbe.?successThreshold.orValue(1) == 1 && object.spec.template.spec.initContainers[0].startupProbe.?initialDelaySeconds.orValue(0) == 0 && !has(object.spec.template.spec.initContainers[0].startupProbe.httpGet) && !has(object.spec.template.spec.initContainers[0].startupProbe.tcpSocket) && !has(object.spec.template.spec.initContainers[0].startupProbe.grpc) && !has(object.spec.template.spec.initContainers[0].startupProbe.terminationGracePeriodSeconds) && !has(object.spec.template.spec.initContainers[0].lifecycle) && !has(object.spec.template.spec.initContainers[0].readinessProbe) && !has(object.spec.template.spec.initContainers[0].livenessProbe)`,
            message: "Import MySQL sidecar is invalid.",
          },
          {
            expression: `dyn(object.spec.template.spec.volumes) == ${cel(renderedImportTemplate.spec.volumes)}`,
            message: "Import Job volumes are invalid.",
          },
          {
            expression: `dyn(object.spec.template.spec.securityContext) == ${cel(renderedImportTemplate.spec.securityContext)} && dyn(object.spec.template.spec.containers[0].securityContext) == ${cel(importWorker.securityContext)} && dyn(object.spec.template.spec.initContainers[0].securityContext) == ${cel(importMysql.securityContext)}`,
            message: "Import Job security context is invalid.",
          },
        ],
      },
    },
    null,
  );
  add(
    "admissionregistration.k8s.io/v1",
    "ValidatingAdmissionPolicyBinding",
    `${ns}-import-jobs`,
    {
      spec: {
        policyName: `${ns}-import-jobs`,
        validationActions: ["Deny"],
        matchResources: {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": `${ns}-imports` },
          },
        },
      },
    },
    null,
  );
  add(
    "admissionregistration.k8s.io/v1",
    "ValidatingAdmissionPolicy",
    `${ns}-sync-suspend`,
    {
      spec: {
        failurePolicy: "Fail",
        matchConstraints: {
          resourceRules: [
            {
              apiGroups: ["batch"],
              apiVersions: ["v1"],
              operations: ["UPDATE"],
              resources: ["cronjobs"],
              scope: "Namespaced",
            },
          ],
        },
        matchConditions: [
          {
            name: "api-service-account",
            expression: `request.userInfo.username == ${cel(`system:serviceaccount:${ns}:api`)}`,
          },
        ],
        validations: [
          {
            expression: `object.metadata.namespace == ${cel(ns)} && oldObject.metadata.namespace == ${cel(ns)} && object.metadata.name == ${cel("ingestion-sync")} && oldObject.metadata.name == ${cel("ingestion-sync")}`,
            message:
              "API may only suspend or resume the ingestion-sync CronJob.",
          },
          {
            // Both objects have API defaults. Compare the complete template and every
            // CronJobSpec field except suspend, so controller-created Jobs cannot bypass
            // the import admission policy through an API patch to the sync template.
            expression:
              "object.spec.jobTemplate == oldObject.spec.jobTemplate && object.spec.schedule == oldObject.spec.schedule && object.spec.?timeZone.orValue('') == oldObject.spec.?timeZone.orValue('') && object.spec.?startingDeadlineSeconds.orValue(-1) == oldObject.spec.?startingDeadlineSeconds.orValue(-1) && object.spec.?concurrencyPolicy.orValue('Allow') == oldObject.spec.?concurrencyPolicy.orValue('Allow') && object.spec.?successfulJobsHistoryLimit.orValue(3) == oldObject.spec.?successfulJobsHistoryLimit.orValue(3) && object.spec.?failedJobsHistoryLimit.orValue(1) == oldObject.spec.?failedJobsHistoryLimit.orValue(1)",
            message:
              "API sync patches must preserve the schedule and Job template.",
          },
          {
            // generation/resourceVersion/managedFields are maintained by the API server.
            expression:
              "object.metadata.?labels.orValue({}) == oldObject.metadata.?labels.orValue({}) && object.metadata.?annotations.orValue({}) == oldObject.metadata.?annotations.orValue({}) && object.metadata.?ownerReferences.orValue([]) == oldObject.metadata.?ownerReferences.orValue([]) && object.metadata.?finalizers.orValue([]) == oldObject.metadata.?finalizers.orValue([]) && object.metadata.?generateName.orValue('') == oldObject.metadata.?generateName.orValue('')",
            message: "API sync patches must preserve CronJob metadata.",
          },
        ],
      },
    },
    null,
  );
  add(
    "admissionregistration.k8s.io/v1",
    "ValidatingAdmissionPolicyBinding",
    `${ns}-sync-suspend`,
    {
      spec: {
        policyName: `${ns}-sync-suspend`,
        validationActions: ["Deny"],
        matchResources: {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": ns },
          },
        },
      },
    },
    null,
  );
  return { resources };
}
