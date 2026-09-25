import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  ActiveDatasetContractError,
  decodeActiveDatasetItem,
} from "../domain/active-dataset.js";
import type {
  ActiveDatasetResolver,
  ActiveDatasetSnapshot,
} from "../ports/active-dataset-resolver.js";

export { ActiveDatasetContractError } from "../domain/active-dataset.js";

export class DynamoActiveDatasetResolver implements ActiveDatasetResolver {
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

  async resolve(): Promise<ActiveDatasetSnapshot | null> {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" },
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return null;
    try {
      return decodeActiveDatasetItem(response.Item);
    } catch (error) {
      if (error instanceof ActiveDatasetContractError) throw error;
      throw new ActiveDatasetContractError();
    }
  }
}
