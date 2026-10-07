import {
  KubernetesClient,
  kubernetesNamePattern,
  type KubernetesClientPort,
} from "../../../platform/kubernetes-client.js";
import type { ArgusSchedulerPort } from "../ports/argus-scheduler.js";

export class KubernetesArgusScheduler implements ArgusSchedulerPort {
  constructor(
    private readonly namespace: string,
    private readonly name: string,
    private readonly client: KubernetesClientPort = new KubernetesClient(),
  ) {
    if (![namespace, name].every((value) => kubernetesNamePattern.test(value)))
      throw new Error("Invalid ARGUS CronJob configuration.");
  }
  async setEnabled(enabled: boolean): Promise<void> {
    // Merge patch changes only suspend and preserves the job template/schedule.
    await this.client.request(
      "PATCH",
      `/apis/batch/v1/namespaces/${this.namespace}/cronjobs/${this.name}`,
      { spec: { suspend: !enabled } },
    );
  }
}
