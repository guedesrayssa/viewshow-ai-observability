import { createServer } from "node:http";
import {
  createLogger,
  startTelemetry,
  stopTelemetry,
} from "@view-show/contracts";
import { loadConfig } from "./config.js";

const config = loadConfig();
const logger = createLogger("dashboard-query-service");
startTelemetry("dashboard-query-service");
const [{ DynamoDashboardReadRepository }, { DashboardQueries }, { createApp }] =
  await Promise.all([
    import("./adapters/dynamodb-dashboard-read-repository.js"),
    import("./application/dashboard-queries.js"),
    import("./http/app.js"),
  ]);
const queries = new DashboardQueries(
  new DynamoDashboardReadRepository(config.region, config.tableName),
  config.monitoringSources,
);
const server = createServer(createApp(queries, config.internalToken));

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
