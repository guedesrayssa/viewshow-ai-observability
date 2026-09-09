import { createServer } from "node:http";
import {
  createLogger,
  startTelemetry,
  stopTelemetry,
} from "@view-show/contracts";
import { loadConfig } from "./config.js";

startTelemetry("api-gateway");
const [{ createApp }] = await Promise.all([import("./app.js")]);
const config = loadConfig();
const logger = createLogger("api-gateway");
const server = createServer(createApp(config));

server.listen(config.port, config.host, () =>
  logger.info("gateway started", { host: config.host, port: config.port }),
);
let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info("gateway stopping", { signal });
  const closeResult = await new Promise<Error | null>((resolve) =>
    server.close((error) => resolve(error ?? null)),
  );
  await stopTelemetry();
  if (closeResult)
    logger.error("graceful shutdown failed", { error: closeResult.message });
  process.exit(closeResult ? 1 : 0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
