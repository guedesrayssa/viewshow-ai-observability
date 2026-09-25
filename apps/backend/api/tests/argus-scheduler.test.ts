import { describe, expect, it, vi } from "vitest";
import { EventBridgeArgusScheduler } from "../src/modules/argus/adapters/eventbridge-argus-scheduler.js";

const originalTarget = {
  Arn: "arn:aws:lambda:us-east-1:123456789012:function:ingestion",
  RoleArn: "arn:aws:iam::123456789012:role/scheduler",
  Input: '{"source":"argus"}',
};

const completeSchedule = {
  Name: "view-show-ingestion-sync",
  GroupName: "view-show-ingestion",
  State: "ENABLED",
  ScheduleExpression: "rate(15 minutes)",
  ScheduleExpressionTimezone: "UTC",
  FlexibleTimeWindow: { Mode: "OFF" as const },
  Target: originalTarget,
  Description: "Syncs ARGUS ingestion data",
};

describe("EventBridgeArgusScheduler", () => {
  it("preserves the retrieved schedule definition while disabling it", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(completeSchedule)
      .mockResolvedValueOnce({});
    const scheduler = new EventBridgeArgusScheduler(
      "us-east-1",
      "view-show-ingestion",
      "view-show-ingestion-sync",
      { send } as never,
    );

    await scheduler.setEnabled(false);

    const update = send.mock.calls[1]?.[0].input;
    expect(update).toMatchObject({
      Name: "view-show-ingestion-sync",
      GroupName: "view-show-ingestion",
      State: "DISABLED",
      ScheduleExpression: "rate(15 minutes)",
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      Target: originalTarget,
      Description: "Syncs ARGUS ingestion data",
    });
    expect({ ...update, State: completeSchedule.State }).toEqual(
      completeSchedule,
    );
  });

  it("retains an explicitly empty description from the retrieved schedule", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ...completeSchedule, Description: "" })
      .mockResolvedValueOnce({});
    const scheduler = new EventBridgeArgusScheduler(
      "us-east-1",
      "view-show-ingestion",
      "view-show-ingestion-sync",
      { send } as never,
    );

    await scheduler.setEnabled(false);

    expect(send.mock.calls[1]?.[0].input).toMatchObject({ Description: "" });
  });

  it.each([
    ["Target", { ...completeSchedule, Target: undefined }],
    [
      "FlexibleTimeWindow",
      { ...completeSchedule, FlexibleTimeWindow: undefined },
    ],
    [
      "ScheduleExpression",
      { ...completeSchedule, ScheduleExpression: undefined },
    ],
  ])(
    "rejects a schedule missing %s before updating",
    async (_field, schedule) => {
      const send = vi.fn().mockResolvedValueOnce(schedule);
      const scheduler = new EventBridgeArgusScheduler(
        "us-east-1",
        "view-show-ingestion",
        "view-show-ingestion-sync",
        { send } as never,
      );

      await expect(scheduler.setEnabled(false)).rejects.toThrow();
      expect(send).toHaveBeenCalledOnce();
    },
  );
});
