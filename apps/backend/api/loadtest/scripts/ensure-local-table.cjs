const {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} = require("@aws-sdk/client-dynamodb");

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.OPERATIONAL_TABLE_NAME;
if (
  !endpoint ||
  !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\/?$/.test(endpoint)
) {
  throw new Error(
    "DYNAMODB_ENDPOINT precisa apontar para DynamoDB Local em loopback.",
  );
}
if (!tableName) throw new Error("OPERATIONAL_TABLE_NAME não definido.");

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  endpoint,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function main() {
  let dynamoReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await client.send(new DescribeTableCommand({ TableName: tableName }));
      dynamoReady = true;
      console.log(`Tabela local existente: ${tableName}`);
      return;
    } catch (error) {
      if (error.name === "ResourceNotFoundException") {
        dynamoReady = true;
        break;
      }
      if (attempt === 39) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!dynamoReady) throw new Error("DynamoDB Local não respondeu a tempo.");

  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "trace_id", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "trace-index",
          KeySchema: [{ AttributeName: "trace_id", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        },
      ],
    }),
  );

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { Table } = await client.send(
      new DescribeTableCommand({ TableName: tableName }),
    );
    if (Table?.TableStatus === "ACTIVE") {
      console.log(`Tabela local pronta: ${tableName}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Tabela ${tableName} não ficou ACTIVE no DynamoDB Local.`);
}

main()
  .finally(() => client.destroy())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
