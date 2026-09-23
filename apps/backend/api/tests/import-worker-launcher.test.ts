import { describe, expect, it, vi } from "vitest";
import {
  DescribeTasksCommand,
  RunTaskCommand,
  type ECSClient,
} from "@aws-sdk/client-ecs";
import { EcsImportWorkerLauncher } from "../src/modules/imports/adapters/ecs-import-worker-launcher.js";

const clusterArn = "arn:aws:ecs:sa-east-1:123456789012:cluster/argus-ingestion";
const taskArn =
  "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcdef";
const importId = "imp_01K5BB9WQ6EJ5V6TVCMSK74NQ3";

function setup() {
  const send = vi.fn();
  return {
    send,
    launcher: new EcsImportWorkerLauncher(
      {
        clusterArn,
        taskDefinitionArn:
          "arn:aws:ecs:sa-east-1:123456789012:task-definition/g05-ingestion-import:7",
        subnetIds: ["subnet-private-a", "subnet-private-b"],
        securityGroupId: "sg-import",
        containerName: "ingestion",
      },
      { send } as unknown as ECSClient,
    ),
  };
}

describe("ECS import worker launcher", () => {
  it("launches one private Fargate 1.4.0 task with an idempotent exact command", async () => {
    const { launcher, send } = setup();
    send.mockResolvedValue({
      tasks: [{ taskArn, clusterArn }],
      failures: [],
    });

    await expect(launcher.launch(importId, "canonical-v2")).resolves.toEqual({
      taskArn,
    });
    const command = send.mock.calls[0]![0] as RunTaskCommand;
    expect(command).toBeInstanceOf(RunTaskCommand);
    expect(command.input).toEqual({
      cluster: clusterArn,
      taskDefinition:
        "arn:aws:ecs:sa-east-1:123456789012:task-definition/g05-ingestion-import:7",
      count: 1,
      launchType: "FARGATE",
      platformVersion: "1.4.0",
      clientToken: importId,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-private-a", "subnet-private-b"],
          securityGroups: ["sg-import"],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "ingestion",
            command: ["import-dump", "--import-id", importId],
            environment: [
              { name: "IMPORT_ID", value: importId },
              { name: "IMPORT_PIPELINE_VERSION", value: "canonical-v2" },
            ],
          },
        ],
      },
    });
  });

  it.each([
    { tasks: [], failures: [] },
    {
      tasks: [{ taskArn, clusterArn }],
      failures: [{ arn: taskArn, reason: "capacity" }],
    },
    { tasks: [{ taskArn }, { taskArn, clusterArn }], failures: [] },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:999999999999:task/argus-ingestion/bad",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws-cn:ecs:sa-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcdef",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:us-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcdef",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn: "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/not a valid task:id",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcde",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcdef0",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/0123456789abcdef0123456789abcde?",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn: "arn:aws:ecs:sa-east-1:123456789012:task/other-cluster/bad",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn: "arn:aws:ecs:sa-east-1:123456789012:task/legacy-id",
          clusterArn,
        },
      ],
      failures: [],
    },
    {
      tasks: [
        {
          taskArn,
          clusterArn:
            "arn:aws:ecs:sa-east-1:123456789012:cluster/other-cluster",
        },
      ],
      failures: [],
    },
  ])("rejects malformed or untrusted launch evidence: %#", async (response) => {
    const { launcher, send } = setup();
    send.mockResolvedValue(response);
    await expect(launcher.launch(importId, "legacy-v1")).rejects.toThrow(
      "ECS returned invalid import worker launch evidence.",
    );
  });

  it.each([
    ["PROVISIONING", "PENDING"],
    ["PENDING", "PENDING"],
    ["ACTIVATING", "PENDING"],
    ["RUNNING", "RUNNING"],
    ["DEACTIVATING", "RUNNING"],
    ["STOPPING", "RUNNING"],
    ["DEPROVISIONING", "RUNNING"],
    ["STOPPED", "STOPPED"],
  ] as const)(
    "maps ECS %s to %s and uses the exact task identity",
    async (lastStatus, state) => {
      const { launcher, send } = setup();
      send.mockResolvedValue({
        tasks: [
          {
            taskArn,
            clusterArn,
            lastStatus,
            containers: [{ name: "ingestion", exitCode: 17 }],
          },
        ],
        failures: [],
      });

      await expect(launcher.status(taskArn)).resolves.toEqual({
        state,
        ...(lastStatus === "STOPPED" ? { exitCode: 17 } : {}),
      });
      const command = send.mock.calls[0]![0] as DescribeTasksCommand;
      expect(command).toBeInstanceOf(DescribeTasksCommand);
      expect(command.input).toEqual({ cluster: clusterArn, tasks: [taskArn] });
    },
  );

  it("recognizes STOPPED without container or exit-code evidence", async () => {
    const { launcher, send } = setup();
    send.mockResolvedValue({
      tasks: [{ taskArn, clusterArn, lastStatus: "STOPPED" }],
      failures: [],
    });
    await expect(launcher.status(taskArn)).resolves.toEqual({
      state: "STOPPED",
    });
  });

  it.each([NaN, "17", 17.5, -1, 256])(
    "rejects malformed main-container exit code %s",
    async (exitCode) => {
      const { launcher, send } = setup();
      send.mockResolvedValue({
        tasks: [
          {
            taskArn,
            clusterArn,
            lastStatus: "STOPPED",
            containers: [{ name: "ingestion", exitCode }],
          },
        ],
        failures: [],
      });
      await expect(launcher.status(taskArn)).rejects.toThrow(
        "ECS returned invalid import worker status evidence.",
      );
    },
  );

  it.each([
    { tasks: [], failures: [] },
    { tasks: [{ taskArn, clusterArn, lastStatus: "UNKNOWN" }], failures: [] },
    {
      tasks: [{ taskArn, clusterArn, lastStatus: "STOPPED" }],
      failures: [{ arn: taskArn, reason: "missing" }],
    },
    {
      tasks: [
        {
          taskArn:
            "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/other",
          clusterArn,
          lastStatus: "RUNNING",
        },
      ],
      failures: [],
    },
  ])("rejects malformed status evidence: %#", async (response) => {
    const { launcher, send } = setup();
    send.mockResolvedValue(response);
    await expect(launcher.status(taskArn)).rejects.toThrow(
      "ECS returned invalid import worker status evidence.",
    );
  });

  it("rejects a malformed task ARN before DescribeTasks", async () => {
    const { launcher, send } = setup();
    await expect(
      launcher.status(
        "arn:aws:ecs:sa-east-1:123456789012:task/argus-ingestion/not-valid",
      ),
    ).rejects.toThrow("ECS returned invalid import worker status evidence.");
    expect(send).not.toHaveBeenCalled();
  });
});
