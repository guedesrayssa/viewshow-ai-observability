import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createLogger } from "@view-show/contracts";

export interface ProcessSpec {
  readonly name: string;
  readonly entry: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface SupervisorOptions {
  readonly root: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawnProcess?: (
    spec: ProcessSpec,
    inherited: NodeJS.ProcessEnv,
  ) => ChildProcess;
  readonly onFatal?: (code: number) => void;
}

const logger = createLogger("runtime-compat");

export function processSpecs(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): readonly ProcessSpec[] {
  const internalToken =
    environment.INTERNAL_AUTH_TOKEN ?? randomBytes(32).toString("base64url");
  const cursorSecret =
    environment.CURSOR_SECRET ?? randomBytes(32).toString("base64url");
  const cookieSecret =
    environment.AUTH_COOKIE_SECRET ?? randomBytes(32).toString("base64url");
  const shared = {
    INTERNAL_AUTH_TOKEN: internalToken,
    CURSOR_SECRET: cursorSecret,
    AUTH_COOKIE_SECRET: cookieSecret,
  };
  return [
    {
      name: "incidents-service",
      entry: resolve(root, "incidents-service/dist/index.js"),
      environment: {
        ...shared,
        INCIDENTS_HOST: "127.0.0.1",
        INCIDENTS_PORT: environment.INCIDENTS_PORT ?? "3001",
        OTEL_SERVICE_NAME: "incidents-service",
      },
    },
    {
      name: "dashboard-query-service",
      entry: resolve(root, "dashboard-query-service/dist/index.js"),
      environment: {
        ...shared,
        DASHBOARD_QUERY_HOST: "127.0.0.1",
        DASHBOARD_QUERY_PORT: environment.DASHBOARD_QUERY_PORT ?? "3002",
        OTEL_SERVICE_NAME: "dashboard-query-service",
      },
    },
    {
      name: "identity-service",
      entry: resolve(root, "identity-service/dist/index.js"),
      environment: {
        ...shared,
        IDENTITY_HOST: "127.0.0.1",
        IDENTITY_PORT: environment.IDENTITY_PORT ?? "3003",
        OTEL_SERVICE_NAME: "identity-service",
      },
    },
    {
      name: "api-gateway",
      entry: resolve(root, "dist/index.js"),
      environment: {
        ...shared,
        HOST: "0.0.0.0",
        PORT: environment.PORT ?? "3000",
        INCIDENTS_SERVICE_URL: `http://127.0.0.1:${environment.INCIDENTS_PORT ?? "3001"}`,
        DASHBOARD_QUERY_SERVICE_URL: `http://127.0.0.1:${environment.DASHBOARD_QUERY_PORT ?? "3002"}`,
        IDENTITY_SERVICE_URL: `http://127.0.0.1:${environment.IDENTITY_PORT ?? "3003"}`,
        OTEL_SERVICE_NAME: "api-gateway",
      },
    },
  ];
}

export function startSupervisor(options: SupervisorOptions) {
  const inherited = options.environment ?? process.env;
  if (
    (inherited.NODE_ENV ?? "development") === "production" &&
    !inherited.AUTH_COOKIE_SECRET
  ) {
    throw new Error("AUTH_COOKIE_SECRET is required in production");
  }
  const spawnProcess =
    options.spawnProcess ??
    ((spec, environment) =>
      spawn(process.execPath, [spec.entry], {
        env: { ...environment, ...spec.environment },
        stdio: "inherit",
      }));
  const children = new Map<string, ChildProcess>();
  let stopping = false;
  let fatal = false;

  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    logger.info("forwarding shutdown", {
      signal,
      processes: [...children.keys()],
    });
    for (const child of children.values()) {
      if (child.exitCode === null && child.signalCode === null)
        child.kill(signal);
    }
  };

  for (const spec of processSpecs(options.root, inherited)) {
    const child = spawnProcess(spec, inherited);
    children.set(spec.name, child);
    child.once("exit", (code, signal) => {
      children.delete(spec.name);
      logger.info("child exited", { process_name: spec.name, code, signal });
      if (!stopping) {
        fatal = true;
        stop();
        options.onFatal?.(code && code !== 0 ? code : 1);
      } else if (children.size === 0 && fatal) {
        options.onFatal?.(1);
      }
    });
    child.once("error", (error) => {
      logger.error("child failed to start", {
        process_name: spec.name,
        error: error.message,
      });
      fatal = true;
      stop();
      options.onFatal?.(1);
    });
  }
  return { children, stop };
}
