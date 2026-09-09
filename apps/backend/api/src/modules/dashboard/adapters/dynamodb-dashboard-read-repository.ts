import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  type QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  DashboardReadRepository,
  ProjectionRead,
  PublicProjection,
} from "../ports/dashboard-read-repository.js";

type PhysicalItem = Readonly<Record<string, unknown>>;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;
const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function publicProjection(item: PhysicalItem): PublicProjection | null {
  const candidate = item.publicData ?? item.projection;
  return candidate !== null &&
    typeof candidate === "object" &&
    !Array.isArray(candidate)
    ? (candidate as PublicProjection)
    : null;
}

function toRead(item: PhysicalItem): ProjectionRead | null {
  const data = publicProjection(item);
  if (!data) return null;
  return {
    data,
    observedThrough: text(item.observedThrough),
    coverageRatio: number(item.coverageRatio),
    source: text(item.source) ?? "argus",
  };
}

export class DynamoDashboardReadRepository implements DashboardReadRepository {
  private readonly client: DynamoDBDocumentClient;

  constructor(
    region: string,
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  private async queryAll(
    input: Omit<QueryCommandInput, "TableName">,
  ): Promise<readonly PhysicalItem[]> {
    const items: PhysicalItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          ...input,
          TableName: this.tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...((result.Items ?? []) as PhysicalItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }

  private daysBetween(from: Date, to: Date): string[] {
    const days: string[] = [];
    const first = new Date(from);
    first.setUTCHours(0, 0, 0, 0);
    const current = new Date(to);
    current.setUTCHours(0, 0, 0, 0);
    while (current >= first) {
      days.push(current.toISOString().slice(0, 10).replaceAll("-", ""));
      current.setUTCDate(current.getUTCDate() - 1);
    }
    return days;
  }

  async latestOverview(from: Date, to: Date): Promise<ProjectionRead | null> {
    const pages = await Promise.all(
      this.daysBetween(from, to).map((day) =>
        this.queryAll({
          KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
          ExpressionAttributeValues: {
            ":pk": `VIEW#OVERVIEW#GLOBAL#${day}`,
            ":from": `T#${from.getTime()}`,
            ":to": `T#${to.getTime()}`,
          },
        }),
      ),
    );
    const latest = pages
      .flat()
      .sort((left, right) =>
        String(right.sk ?? "").localeCompare(String(left.sk ?? "")),
      )[0];
    return latest ? toRead(latest) : null;
  }

  async latestMonitoring(
    from: Date,
    to: Date,
    sources: readonly string[],
  ): Promise<ProjectionRead | null> {
    const reads = await Promise.all(
      sources.flatMap((source) =>
        this.daysBetween(from, to).map((day) =>
          this.queryAll({
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
            ExpressionAttributeValues: {
              ":pk": `VIEW#MONITORING#${source}#${day}`,
              ":from": `T#${from.getTime()}`,
              ":to": `T#${to.getTime()}`,
            },
          }),
        ),
      ),
    );
    const candidates = reads
      .flat()
      .sort((left, right) =>
        String(right.sk ?? "").localeCompare(String(left.sk ?? "")),
      );
    for (const candidate of candidates) {
      const read = toRead(candidate);
      if (read) return read;
    }
    return null;
  }
}
