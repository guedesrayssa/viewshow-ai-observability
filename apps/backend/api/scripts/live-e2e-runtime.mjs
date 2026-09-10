import { pathToFileURL } from "node:url";

const endpointError = "DYNAMODB_ENDPOINT is required for live E2E";
const unsafeEndpointError =
  "DYNAMODB_ENDPOINT must be a local DynamoDB URL using HTTP";

export function requireDynamoDbEndpoint(environment = process.env) {
  const endpoint = environment.DYNAMODB_ENDPOINT?.trim();
  if (!endpoint) throw new Error(endpointError);

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(unsafeEndpointError);
  }
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  const isCiService = endpoint === "http://dynamodb:8000";
  const isCanonicalRoot =
    endpoint === url.origin || endpoint === `${url.origin}/`;
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/" ||
    !isCanonicalRoot ||
    (!isLoopback && !isCiService)
  )
    throw new Error(unsafeEndpointError);
  return endpoint;
}

export function liveApiChildEnvironment({
  endpoint,
  port,
  tableName,
  authSecret,
  cursorSecret,
}) {
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(port),
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "local",
    AWS_SECRET_ACCESS_KEY: "local",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    DYNAMODB_ENDPOINT: endpoint,
    OPERATIONAL_TABLE_NAME: tableName,
    MONITORING_SOURCES: "argus",
    AUTH_COOKIE_SECRET: authSecret,
    CURSOR_SECRET: cursorSecret,
    METRICS_ENABLED: "true",
  };
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(
      () => finish(child.exitCode !== null),
      Math.max(1, timeoutMilliseconds),
    );
    child.once("exit", onExit);
    if (child.exitCode !== null) finish(true);
  });
}

export async function terminateChild(child, timeoutMilliseconds = 2_000) {
  if (child.exitCode !== null) return;
  const gracefulExit = waitForExit(child, timeoutMilliseconds);
  child.kill("SIGTERM");
  if (await gracefulExit) return;

  const forcedExit = waitForExit(child, timeoutMilliseconds);
  child.kill("SIGKILL");
  if (!(await forcedExit))
    throw new Error("compiled API did not exit after SIGKILL");
}

export async function cleanupLiveApiResources({
  stopApi,
  deleteTable,
  destroyClient,
}) {
  try {
    await stopApi();
  } finally {
    try {
      await deleteTable();
    } finally {
      destroyClient();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    requireDynamoDbEndpoint();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : endpointError}\n`,
    );
    process.exitCode = 1;
  }
}
