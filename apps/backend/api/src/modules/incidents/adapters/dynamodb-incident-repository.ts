import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ServiceError } from "@view-show/contracts";
import { itemKind, type PhysicalItem } from "../domain/incident.js";
import type {
  IncidentBundle,
  IncidentRepository,
  ReviewWrite,
} from "../ports/incident-repository.js";

export class DynamoIncidentRepository implements IncidentRepository {
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
        {
          marshallOptions: { removeUndefinedValues: true },
        },
      );
  }

  private async queryAll(
    input: Omit<QueryCommandInput, "TableName">,
  ): Promise<readonly PhysicalItem[]> {
    const items: PhysicalItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((response.Items ?? []) as PhysicalItem[]));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  async listBetween(from: Date, to: Date): Promise<readonly PhysicalItem[]> {
    const manifest = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk: "CONTROL#DATASET", sk: "ACTIVE" }, ConsistentRead: true }));
    const activeDataset = typeof manifest.Item?.activeDatasetVersion === "string" ? manifest.Item.activeDatasetVersion : null;
    const partitions: { readonly pk: string; readonly prefix?: string }[] = [];
    if (!activeDataset) {
      const firstHour = new Date(from); firstHour.setUTCMinutes(0, 0, 0);
      const hour = new Date(to); hour.setUTCMinutes(0, 0, 0);
      while (hour >= firstHour) {
        partitions.push({ pk: `INC#${hour.toISOString().slice(0, 13)}`, prefix: "INCIDENT#" });
        hour.setUTCHours(hour.getUTCHours() - 1);
      }
    }
    const firstDay = new Date(from);
    firstDay.setUTCHours(0, 0, 0, 0);
    const day = new Date(to);
    day.setUTCHours(0, 0, 0, 0);
    while (day >= firstDay) {
      const suffix=`VIEW#INCIDENTS#DAY#${day.toISOString().slice(0, 10).replaceAll("-", "")}`;
      partitions.push({ pk: activeDataset ? `DATASET#${activeDataset}#${suffix}` : suffix });
      day.setUTCDate(day.getUTCDate() - 1);
    }

    const pages = await Promise.all(
      partitions.map(({ pk, prefix }) =>
        this.queryAll({
          KeyConditionExpression: prefix
            ? "pk = :pk AND begins_with(sk, :prefix)"
            : "pk = :pk",
          ExpressionAttributeValues: prefix
            ? { ":pk": pk, ":prefix": prefix }
            : { ":pk": pk },
        }),
      ),
    );

    const unique = new Map<string, PhysicalItem>();
    for (const item of pages.flat()) {
      if (itemKind(item) !== "incident") continue;
      const id =
        typeof item.id === "string"
          ? item.id
          : typeof item.incidentId === "string"
            ? item.incidentId
            : null;
      if (!id) continue;
      const current = unique.get(id);
      const timestamp =
        typeof item.updatedAt === "string"
          ? item.updatedAt
          : typeof item.startedAt === "string"
            ? item.startedAt
            : "";
      const currentTimestamp =
        typeof current?.updatedAt === "string"
          ? current.updatedAt
          : typeof current?.startedAt === "string"
            ? current.startedAt
            : "";
      if (!current || timestamp >= currentTimestamp) unique.set(id, item);
    }
    return [...unique.values()];
  }

  async bundle(incidentId: string): Promise<IncidentBundle> {
    const items = await this.queryAll({
      IndexName: "trace-index",
      KeyConditionExpression: "trace_id = :incidentId",
      ExpressionAttributeValues: { ":incidentId": incidentId },
    });
    return {
      incident: items.find((item) => itemKind(item) === "incident") ?? null,
      children: items.filter((item) => itemKind(item) !== "incident"),
    };
  }

  async writeReview(write: ReviewWrite): Promise<PhysicalItem> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: write.key,
          UpdateExpression:
            "SET reviewStatus = :status, reviewNote = :note, reviewedBy = :reviewer, reviewedAt = :reviewedAt, reviewVersion = :nextVersion",
          ConditionExpression:
            "attribute_exists(pk) AND attribute_exists(sk) AND ((attribute_not_exists(reviewVersion) AND :expectedVersion = :zero) OR reviewVersion = :expectedVersion)",
          ExpressionAttributeValues: {
            ":status": write.status,
            ":note": write.note,
            ":reviewer": write.reviewerId,
            ":reviewedAt": write.reviewedAt,
            ":expectedVersion": write.expectedVersion,
            ":nextVersion": write.expectedVersion + 1,
            ":zero": 0,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      if (!result.Attributes)
        throw new ServiceError(
          500,
          "INTERNAL_ERROR",
          "A revisão não foi persistida.",
        );
      return result.Attributes;
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      ) {
        throw new ServiceError(
          409,
          "REVIEW_VERSION_CONFLICT",
          "A hipótese foi revisada por outra sessão.",
        );
      }
      throw error;
    }
  }
}
