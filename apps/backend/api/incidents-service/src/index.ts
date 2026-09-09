import { createServer } from "node:http";
import {
  createLogger,
  startTelemetry,
  stopTelemetry,
} from "@view-show/contracts";
import { loadConfig } from "./config.js";

const config = loadConfig();
const logger = createLogger("incidents-service");
startTelemetry("incidents-service");
const [
  { DynamoIncidentRepository },
  { IncidentUseCases, UnavailableReviewFeedbackPort },
  { CursorCodec },
  { createApp },
] = await Promise.all([
  import("./adapters/dynamodb-incident-repository.js"),
  import("./application/incident-use-cases.js"),
  import("./domain/cursor.js"),
  import("./http/app.js"),
]);
const repository = new DynamoIncidentRepository(
  config.region,
  config.tableName,
);
const useCases = new IncidentUseCases(
  repository,
  new CursorCodec(config.cursorSecret),
  new UnavailableReviewFeedbackPort(),
);
const server = createServer(createApp(useCases, config.internalToken));

server.listen(config.port, config.host, () =>
  logger.info("service started", { host: config.host, port: config.port }),
);

let closing = false;
function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("service stopping", { signal });
  server.close(async (error) => {
    await stopTelemetry();
    if (error)
      logger.error("graceful shutdown failed", { error: error.message });
    process.exitCode = error ? 1 : 0;
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
