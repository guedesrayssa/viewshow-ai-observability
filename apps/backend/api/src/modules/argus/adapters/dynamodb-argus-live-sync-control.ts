import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { decodeArgusLiveSyncItem } from "../domain/argus-live-sync.js";
import type { ArgusLiveSyncControlPort } from "../ports/argus-live-sync-control.js";

export class DynamoArgusLiveSyncControl implements ArgusLiveSyncControlPort {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    region: string,
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
    endpoint?: string,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(
        new DynamoDBClient({
          region,
          ...(endpoint ? { endpoint } : {}),
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      );
  }

  async read(): Promise<boolean> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC" },
        ConsistentRead: true,
      }),
    );
    return response.Item ? decodeArgusLiveSyncItem(response.Item) : false;
  }

  async write(enabled: boolean): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: "CONTROL#ARGUS", sk: "LIVE_SYNC", enabled },
      }),
    );
  }
}
