import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@view-show/contracts";
import { startSupervisor } from "./supervisor.js";

const logger = createLogger("runtime-compat");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const supervisor = startSupervisor({
  root,
  onFatal(code) {
    logger.error("essential process stopped", { code });
    process.exitCode = code;
  },
});

process.on("SIGTERM", () => supervisor.stop("SIGTERM"));
process.on("SIGINT", () => supervisor.stop("SIGINT"));
