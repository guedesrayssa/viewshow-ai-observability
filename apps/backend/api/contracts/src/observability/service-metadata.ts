import { hostname } from "node:os";

/**
 * Identidade do processo, derivada das mesmas variáveis em todos os sinais.
 * O `service.name` do span, o `service_name` do log (rótulo do Loki) e o
 * rótulo das métricas precisam ser IGUAIS: é essa igualdade que faz os saltos
 * trace → logs e log → trace do Grafana funcionarem.
 */
export interface ServiceMetadata {
  readonly serviceName: string;
  readonly version: string;
  readonly environment: string;
  readonly instanceId: string;
}

function parseResourceAttributes(raw: string | undefined): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const pair of (raw ?? "").split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    let value = pair.slice(separator + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Valor sem codificação percentual válida: usa o texto original.
    }
    if (key) attributes.set(key, value);
  }
  return attributes;
}

let cached: { readonly key: string; readonly value: ServiceMetadata } | null =
  null;

export function resolveServiceMetadata(
  defaultServiceName: string,
  env: NodeJS.ProcessEnv = process.env,
): ServiceMetadata {
  const key = [
    defaultServiceName,
    env.OTEL_SERVICE_NAME,
    env.OTEL_RESOURCE_ATTRIBUTES,
    env.SERVICE_VERSION,
    env.OTEL_DEPLOYMENT_ENVIRONMENT,
    env.NODE_ENV,
    env.SERVICE_INSTANCE_ID,
  ].join("\u0000");
  if (env === process.env && cached?.key === key) return cached.value;
  const attributes = parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
  const value: ServiceMetadata = {
    serviceName:
      env.OTEL_SERVICE_NAME ??
      attributes.get("service.name") ??
      defaultServiceName,
    version: env.SERVICE_VERSION ?? attributes.get("service.version") ?? "dev",
    environment:
      env.OTEL_DEPLOYMENT_ENVIRONMENT ??
      attributes.get("deployment.environment.name") ??
      attributes.get("deployment.environment") ??
      env.NODE_ENV ??
      "unknown",
    instanceId: env.SERVICE_INSTANCE_ID ?? hostname(),
  };
  if (env === process.env) cached = { key, value };
  return value;
}
