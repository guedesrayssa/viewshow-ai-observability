import { importIdSchema } from "@view-show/contracts";
import {
  KubernetesApiError,
  KubernetesClient,
  kubernetesNamePattern,
  type KubernetesClientPort,
} from "../../../platform/kubernetes-client.js";
import type { ImportPipelineVersion } from "../domain/import.js";
import type { ImportWorkerLauncher } from "../ports/import-worker-launcher.js";

export interface KubernetesImportWorkerConfig {
  readonly namespace: string;
  readonly templateName: string;
  readonly containerName: string;
}
interface Container {
  name: string;
  args?: string[];
  env?: { name: string; value?: string; valueFrom?: unknown }[];
}
interface JobSpec {
  template: {
    metadata?: { labels?: Record<string, string> };
    spec: { containers: Container[]; serviceAccountName?: string };
  };
  [key: string]: unknown;
}
interface Job {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    labels?: Record<string, string>;
  };
  spec: JobSpec;
  status?: { active?: number; conditions?: { type: string; status: string }[] };
}
interface Template {
  spec: { jobTemplate: { spec: JobSpec } };
}

/** taskArn remains the persisted field name for compatibility with stored imports. */
export class KubernetesImportWorkerLauncher implements ImportWorkerLauncher {
  private readonly base: string;
  constructor(
    private readonly config: KubernetesImportWorkerConfig,
    private readonly client: KubernetesClientPort = new KubernetesClient(),
  ) {
    if (
      ![config.namespace, config.templateName, config.containerName].every(
        (name) => kubernetesNamePattern.test(name),
      )
    )
      throw new Error("Invalid Kubernetes import configuration.");
    this.base = `/apis/batch/v1/namespaces/${config.namespace}`;
  }
  private validate(
    job: Job,
    name: string,
    importId?: string,
    pipelineVersion?: string,
  ): void {
    if (
      job.metadata?.name !== name ||
      job.metadata.namespace !== this.config.namespace ||
      !/^[0-9a-f-]{36}$/.test(job.metadata.uid) ||
      job.spec?.template.spec.serviceAccountName !== "ingestion-import" ||
      job.metadata.labels?.["app.kubernetes.io/name"] !== "ingestion-import" ||
      (importId !== undefined &&
        job.metadata.labels?.["view-show/import-id"] !== importId) ||
      (pipelineVersion !== undefined &&
        job.metadata.labels?.["view-show/pipeline"] !== pipelineVersion)
    )
      throw new Error("Invalid Kubernetes import job evidence.");
  }
  async launch(
    importId: string,
    pipelineVersion: ImportPipelineVersion,
  ): Promise<{ taskArn: string }> {
    importIdSchema.parse(importId);
    const name = `import-${importId.slice(4).toLowerCase()}`;
    const template = await this.client.request<Template>(
      "GET",
      `${this.base}/cronjobs/${this.config.templateName}`,
    );
    const spec = structuredClone(template.spec.jobTemplate.spec);
    const container = spec.template.spec.containers.find(
      (c) => c.name === this.config.containerName,
    );
    if (
      !container ||
      spec.template.spec.serviceAccountName !== "ingestion-import"
    )
      throw new Error("Invalid Kubernetes import job template.");
    container.args = ["import-dump", "--import-id", importId];
    container.env = [
      ...(container.env ?? []).filter(
        (v) => !["IMPORT_ID", "IMPORT_PIPELINE_VERSION"].includes(v.name),
      ),
      { name: "IMPORT_ID", value: importId },
      { name: "IMPORT_PIPELINE_VERSION", value: pipelineVersion },
    ];
    // Retain evidence long enough for reconciliation after API/operator downtime.
    spec.ttlSecondsAfterFinished = 7 * 24 * 60 * 60;
    const labels = {
      "app.kubernetes.io/name": "ingestion-import",
      "view-show/import-id": importId,
      "view-show/pipeline": pipelineVersion,
    };
    spec.template.metadata = {
      ...spec.template.metadata,
      labels: { ...spec.template.metadata?.labels, ...labels },
    };
    let job: Job;
    try {
      job = await this.client.request<Job>("POST", `${this.base}/jobs`, {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace: this.config.namespace, labels },
        spec,
      });
    } catch (error) {
      if (!(error instanceof KubernetesApiError) || error.statusCode !== 409)
        throw error;
      job = await this.client.request<Job>("GET", `${this.base}/jobs/${name}`);
    }
    this.validate(job, name, importId, pipelineVersion);
    return {
      taskArn: `k8s://${this.config.namespace}/jobs/${name}/${job.metadata.uid}`,
    };
  }
  async status(
    reference: string,
  ): Promise<{ state: "PENDING" | "RUNNING" | "STOPPED"; exitCode?: number }> {
    const match =
      /^k8s:\/\/([a-z0-9-]+)\/jobs\/(import-[a-z0-9]+)\/([0-9a-f-]{36})$/.exec(
        reference,
      );
    if (!match || match[1] !== this.config.namespace)
      throw new Error("Invalid Kubernetes import job reference.");
    let job: Job;
    try {
      job = await this.client.request<Job>(
        "GET",
        `${this.base}/jobs/${match[2]}`,
      );
    } catch (error) {
      if (error instanceof KubernetesApiError && error.statusCode === 404)
        return { state: "STOPPED" };
      throw error;
    }
    this.validate(job, match[2]!);
    if (job.metadata.uid !== match[3])
      throw new Error("Kubernetes import job UID changed.");
    const terminal = job.status?.conditions?.find(
      (c) => c.status === "True" && ["Complete", "Failed"].includes(c.type),
    );
    if (terminal)
      return {
        state: "STOPPED",
        exitCode: terminal.type === "Complete" ? 0 : 1,
      };
    return { state: (job.status?.active ?? 0) > 0 ? "RUNNING" : "PENDING" };
  }
}
