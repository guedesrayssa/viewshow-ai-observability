import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { importIdSchema } from "@view-show/contracts";
import type { ImportPipelineVersion } from "../domain/import.js";
import type { ImportWorkerLauncher } from "../ports/import-worker-launcher.js";

export interface EcsImportWorkerConfig {
  readonly clusterArn: string;
  readonly taskDefinitionArn: string;
  readonly subnetIds: readonly string[];
  readonly securityGroupId: string;
  readonly containerName: string;
}

const launchError = () =>
  new Error("ECS returned invalid import worker launch evidence.");
const statusError = () =>
  new Error("ECS returned invalid import worker status evidence.");

export class EcsImportWorkerLauncher implements ImportWorkerLauncher {
  private readonly client: ECSClient;
  private readonly taskArnPrefix: string;

  constructor(
    private readonly config: EcsImportWorkerConfig,
    client?: ECSClient,
  ) {
    this.client = client ?? new ECSClient({ region: this.clusterRegion() });
    this.taskArnPrefix = this.deriveTaskArnPrefix();
  }

  private clusterRegion(): string {
    const match = /^arn:[^:]+:ecs:([^:]+):\d{12}:cluster\/[^/]+$/.exec(
      this.config.clusterArn,
    );
    if (!match) throw new Error("Invalid ECS ingestion cluster ARN.");
    return match[1]!;
  }

  private deriveTaskArnPrefix(): string {
    const match = /^(arn:[^:]+:ecs:[^:]+:\d{12}):cluster\/([^/]+)$/.exec(
      this.config.clusterArn,
    );
    if (!match) throw new Error("Invalid ECS ingestion cluster ARN.");
    return `${match[1]}:task/${match[2]}/`;
  }

  private validTask(
    task: Task | undefined,
    expectedArn?: string,
  ): task is Task & {
    taskArn: string;
  } {
    return (
      task !== undefined &&
      task.clusterArn === this.config.clusterArn &&
      typeof task.taskArn === "string" &&
      this.validTaskArn(task.taskArn) &&
      (expectedArn === undefined || task.taskArn === expectedArn)
    );
  }

  private validTaskArn(taskArn: string): boolean {
    return (
      taskArn.startsWith(this.taskArnPrefix) &&
      /^[0-9a-f]{32}$/.test(taskArn.slice(this.taskArnPrefix.length))
    );
  }

  async launch(
    importId: string,
    pipelineVersion: ImportPipelineVersion,
  ): Promise<{ taskArn: string }> {
    importIdSchema.parse(importId);
    const result = await this.client.send(
      new RunTaskCommand({
        cluster: this.config.clusterArn,
        taskDefinition: this.config.taskDefinitionArn,
        count: 1,
        launchType: "FARGATE",
        platformVersion: "1.4.0",
        clientToken: importId,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [...this.config.subnetIds],
            securityGroups: [this.config.securityGroupId],
            assignPublicIp: "DISABLED",
          },
        },
        overrides: {
          containerOverrides: [
            {
              name: this.config.containerName,
              command: ["import-dump", "--import-id", importId],
              environment: [
                { name: "IMPORT_ID", value: importId },
                { name: "IMPORT_PIPELINE_VERSION", value: pipelineVersion },
              ],
            },
          ],
        },
      }),
    );
    if (
      (result.failures?.length ?? 0) !== 0 ||
      result.tasks?.length !== 1 ||
      !this.validTask(result.tasks[0])
    )
      throw launchError();
    return { taskArn: result.tasks[0].taskArn };
  }

  async status(taskArn: string) {
    if (!this.validTaskArn(taskArn)) throw statusError();
    const result = await this.client.send(
      new DescribeTasksCommand({
        cluster: this.config.clusterArn,
        tasks: [taskArn],
      }),
    );
    const task = result.tasks?.[0];
    const state: "PENDING" | "RUNNING" | "STOPPED" | undefined =
      task?.lastStatus === "STOPPED"
        ? "STOPPED"
        : ["PROVISIONING", "PENDING", "ACTIVATING"].includes(
              task?.lastStatus ?? "",
            )
          ? "PENDING"
          : ["RUNNING", "DEACTIVATING", "STOPPING", "DEPROVISIONING"].includes(
                task?.lastStatus ?? "",
              )
            ? "RUNNING"
            : undefined;
    if (
      (result.failures?.length ?? 0) !== 0 ||
      result.tasks?.length !== 1 ||
      !this.validTask(task, taskArn) ||
      state === undefined
    )
      throw statusError();

    if (state !== "STOPPED") return { state };
    const exitCode = task.containers?.find(
      (container) => container.name === this.config.containerName,
    )?.exitCode;
    if (
      exitCode !== undefined &&
      (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255)
    )
      throw statusError();
    return {
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }
}
