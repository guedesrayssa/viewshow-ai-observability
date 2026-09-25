import { describe, expect, it, vi } from "vitest";
import { DynamoArgusLiveSyncControl } from "../src/modules/argus/adapters/dynamodb-argus-live-sync-control.js";

describe("DynamoArgusLiveSyncControl", () => {
  it("treats a missing singleton as disabled and uses a consistent read", async () => {
    const send = vi.fn(async () => ({}));
    const control = new DynamoArgusLiveSyncControl(
      "us-east-1",
      "view-show-operacional",
      { send } as never,
    );
    await expect(control.read()).resolves.toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      TableName: "view-show-operacional",
      Key: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC" },
      ConsistentRead: true,
    });
  });

  it.each([true, false])("round-trips enabled=%s", async (enabled) => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Item: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC", enabled },
      })
      .mockResolvedValueOnce({});
    const control = new DynamoArgusLiveSyncControl("us-east-1", "table", {
      send,
    } as never);
    await expect(control.read()).resolves.toBe(enabled);
    await expect(control.write(enabled)).resolves.toBeUndefined();
    expect(send.mock.calls[1]?.[0].input).toMatchObject({
      TableName: "table",
      Item: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC", enabled },
    });
  });

  it("rejects malformed persisted state", async () => {
    const send = vi.fn(async () => ({
      Item: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC", enabled: "yes" },
    }));
    const control = new DynamoArgusLiveSyncControl("us-east-1", "table", {
      send,
    } as never);
    await expect(control.read()).rejects.toThrow(
      "ARGUS live sync configuration is invalid",
    );
  });
});
