import { createServer } from "node:http";
import {
  createLogger,
  startTelemetry,
  stopTelemetry,
} from "@view-show/contracts";
import { loadConfig } from "./config.js";
import { stopApiServices } from "./api-lifecycle.js";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "view-show-api";
startTelemetry(SERVICE_NAME);
const [
  { createApp },
  { createAuthModule },
  { createIncidentsModule },
  { createDashboardModule },
  { createImportsModule },
  { createActiveDatasetModule },
  { createArgusModule },
] = await Promise.all([
  import("./app.js"),
  import("./modules/auth/index.js"),
  import("./modules/incidents/index.js"),
  import("./modules/dashboard/index.js"),
  import("./modules/imports/index.js"),
  import("./modules/datasets/index.js"),
  import("./modules/argus/index.js"),
]);
const config = loadConfig();
const activeDataset = createActiveDatasetModule();
const logger = createLogger(SERVICE_NAME);
const importsModule = createImportsModule(process.env, { logger });
const server = createServer(
  createApp({
    config,
    auth: createAuthModule(),
    incidents: createIncidentsModule(process.env, activeDataset),
    dashboard: createDashboardModule(process.env, activeDataset),
    imports: importsModule.useCases,
    argus: createArgusModule(process.env),
  }),
);

server.listen(config.port, config.host, () => {
  importsModule.reconciler.start();
  logger.info("api started", { host: config.host, port: config.port });
});
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("api stopping", { signal });
  const closeResult = await stopApiServices({
    server,
    reconciler: importsModule.reconciler,
    stopTelemetry,
  });
  if (closeResult)
    logger.error("graceful shutdown failed", { error: closeResult.message });
  process.exit(closeResult ? 1 : 0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
