import {
  GetScheduleCommand,
  SchedulerClient,
  UpdateScheduleCommand,
  type GetScheduleCommandOutput,
  type UpdateScheduleCommandInput,
} from "@aws-sdk/client-scheduler";
import type { ArgusSchedulerPort } from "../ports/argus-scheduler.js";

function updateDefinition(
  schedule: GetScheduleCommandOutput,
  groupName: string,
  name: string,
  enabled: boolean,
): UpdateScheduleCommandInput {
  if (
    !schedule.Target ||
    !schedule.FlexibleTimeWindow ||
    !schedule.ScheduleExpression
  )
    throw new Error("ARGUS ingestion schedule definition is incomplete");

  return {
    Name: name,
    GroupName: groupName,
    ScheduleExpression: schedule.ScheduleExpression,
    Target: schedule.Target,
    FlexibleTimeWindow: schedule.FlexibleTimeWindow,
    ...(schedule.StartDate !== undefined
      ? { StartDate: schedule.StartDate }
      : {}),
    ...(schedule.EndDate !== undefined ? { EndDate: schedule.EndDate } : {}),
    ...(schedule.Description !== undefined
      ? { Description: schedule.Description }
      : {}),
    ...(schedule.ScheduleExpressionTimezone !== undefined
      ? { ScheduleExpressionTimezone: schedule.ScheduleExpressionTimezone }
      : {}),
    ...(schedule.KmsKeyArn !== undefined
      ? { KmsKeyArn: schedule.KmsKeyArn }
      : {}),
    ...(schedule.ActionAfterCompletion !== undefined
      ? { ActionAfterCompletion: schedule.ActionAfterCompletion }
      : {}),
    State: enabled ? "ENABLED" : "DISABLED",
  };
}

export class EventBridgeArgusScheduler implements ArgusSchedulerPort {
  private readonly client: SchedulerClient;

  constructor(
    region: string,
    private readonly groupName: string,
    private readonly name: string,
    client?: SchedulerClient,
  ) {
    this.client = client ?? new SchedulerClient({ region });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const schedule = await this.client.send(
      new GetScheduleCommand({ Name: this.name, GroupName: this.groupName }),
    );
    await this.client.send(
      new UpdateScheduleCommand(
        updateDefinition(schedule, this.groupName, this.name, enabled),
      ),
    );
  }
}
