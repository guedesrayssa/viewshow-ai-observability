import { createServer } from "node:http";
import {
  createLogger,
  startTelemetry,
  stopTelemetry,
} from "@view-show/contracts";
import { loadConfig } from "./config.js";

const config = loadConfig();
const logger = createLogger("identity-service");
startTelemetry("identity-service");
const [
  { ConfiguredIdentityProvider },
  { IdentityUseCases },
  { SessionCodec },
  { createApp },
] = await Promise.all([
  import("./adapters/configured-identity-provider.js"),
  import("./application/identity-use-cases.js"),
  import("./domain/session.js"),
  import("./http/app.js"),
]);
const provider = new ConfiguredIdentityProvider(config);
const useCases = new IdentityUseCases(provider, config.devAuth !== false);
const server = createServer(
  createApp(useCases, new SessionCodec(config.cookieSecret), config),
);

server.listen(config.port, config.host, () =>
  logger.info("service started", {
    host: config.host,
    port: config.port,
    provider: config.devAuth
      ? "development"
      : config.oidc
        ? "oidc-reserved"
        : "unavailable",
  }),
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
