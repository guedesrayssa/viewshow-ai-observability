import type { Span } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK, resources } from "@opentelemetry/sdk-node";
import { flushLogs, getLokiTransport } from "./loki-transport.js";
import { resolveServiceMetadata } from "./service-metadata.js";

type InstrumentationConfig = NonNullable<
  Parameters<typeof getNodeAutoInstrumentations>[0]
>;

/**
 * Parâmetros de query que nunca devem chegar ao Tempo. A lista padrão do
 * OpenTelemetry cobre só assinaturas AWS/Google; `code` e `state` do callback
 * OIDC (`GET /auth/callback`) e tokens em geral ficavam em `url.query`.
 */
export const REDACTED_QUERY_PARAMS: readonly string[] = [
  "sig",
  "Signature",
  "AWSAccessKeyId",
  "X-Goog-Signature",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "code",
  "state",
  "token",
  "id_token",
  "access_token",
  "refresh_token",
  "password",
  "client_secret",
];

/** Sondas de saúde e coleta de métricas: alto volume e nenhum valor em trace. */
export function isOperationalProbe(url: string | undefined): boolean {
  const path = (url ?? "").split("?", 1)[0];
  return path === "/health" || path === "/metrics";
}

interface ExpressRequestLike {
  readonly method?: string;
  readonly baseUrl?: unknown;
  readonly route?: { readonly path?: unknown };
}

interface ExpressResponseLike {
  readonly locals?: {
    readonly requestId?: unknown;
    readonly errorCode?: unknown;
  };
}

/**
 * Nomeia o span SERVER pelo template da rota (`GET /api/v1/incidents`) e
 * anexa o `request_id` e o código de erro de negócio. Sem isso o span se
 * chama apenas `GET`, e as métricas RED geradas pelo Tempo colapsam todas as
 * rotas em uma única série.
 *
 * O instrumentador chama este gancho também para requisições de saída; só
 * requisições do Express (que têm `baseUrl`) são tratadas.
 */
export function annotateServerSpan(
  span: Span,
  request: unknown,
  response: unknown,
): void {
  const req = request as ExpressRequestLike;
  if (typeof req.baseUrl !== "string") return;
  const locals = (response as ExpressResponseLike).locals;
  if (typeof req.route?.path === "string") {
    const route = `${req.baseUrl}${req.route.path}`;
    span.setAttribute("http.route", route);
    span.updateName(`${req.method ?? "GET"} ${route}`);
  }
  if (typeof locals?.requestId === "string")
    span.setAttribute("viewshow.request_id", locals.requestId);
  if (typeof locals?.errorCode === "string")
    span.setAttribute("viewshow.error_code", locals.errorCode);
}

/** O envio de logs ao Loki é telemetria: não deve gerar span dentro do trace. */
export function isTelemetryExport(
  request: { readonly origin: string; readonly path: string },
  lokiPushUrl: string | undefined,
): boolean {
  if (!lokiPushUrl) return false;
  try {
    const target = new URL(lokiPushUrl);
    return (
      request.origin === target.origin &&
      request.path.split("?", 1)[0] === target.pathname
    );
  } catch {
    return false;
  }
}

export function buildInstrumentationConfig(
  lokiPushUrl: string | undefined,
): InstrumentationConfig {
  return {
    "@opentelemetry/instrumentation-http": {
      ignoreIncomingRequestHook: (request) => isOperationalProbe(request.url),
      redactedQueryParamsServer: [...REDACTED_QUERY_PARAMS],
      redactedQueryParams: [...REDACTED_QUERY_PARAMS],
      applyCustomAttributesOnSpan: annotateServerSpan,
    },
    // Cada middleware do Express (helmet, cors, parser, limitador) virava um
    // span de microssegundos; o que interessa é o handler da rota.
    "@opentelemetry/instrumentation-express": {
      // O tipo do pacote é um enum; os valores são estas strings.
      ignoreLayersType: ["middleware", "router"] as never,
    },
    "@opentelemetry/instrumentation-undici": {
      ignoreRequestHook: (request) => isTelemetryExport(request, lokiPushUrl),
    },
    // O span do comando já descreve a chamada; o HTTP interno do SDK só
    // duplicava a contagem de spans por operação.
    "@opentelemetry/instrumentation-aws-sdk": {
      suppressInternalInstrumentation: true,
    },
  };
}

let telemetrySdk: NodeSDK | null = null;

/**
 * Liga o tracing quando `OTEL_EXPORTER_OTLP_ENDPOINT` está definido. Deve ser
 * chamado antes de carregar qualquer módulo que crie clientes AWS: a
 * instrumentação só alcança módulos carregados depois dela.
 */
export function startTelemetry(serviceName: string): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!endpoint || telemetrySdk) return;
  // Só as bibliotecas que a API usa: as ~50 instrumentações padrão custam
  // tempo de partida e memória numa task de 0,25 vCPU / 512 MiB. Sem net/dns
  // não nascem os traces órfãos `tcp.connect`. Sem o detector `process`, a
  // linha de comando completa não vira atributo de recurso.
  process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS ??=
    "http,express,undici,aws-sdk";
  process.env.OTEL_NODE_RESOURCE_DETECTORS ??= "env,host,os";
  const metadata = resolveServiceMetadata(serviceName);
  telemetrySdk = new NodeSDK({
    resource: resources.resourceFromAttributes({
      "service.name": metadata.serviceName,
      "service.version": metadata.version,
      "service.instance.id": metadata.instanceId,
      "deployment.environment.name": metadata.environment,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations(
        buildInstrumentationConfig(process.env.LOKI_PUSH_URL?.trim()),
      ),
    ],
  });
  telemetrySdk.start();
}

export async function stopTelemetry(): Promise<void> {
  await flushLogs();
  await telemetrySdk?.shutdown();
  telemetrySdk = null;
}

/** Estado dos sinais, para a linha de partida da API. */
export function telemetryStatus(): {
  readonly tracing: boolean;
  readonly log_shipping: boolean;
} {
  return {
    tracing: telemetrySdk !== null,
    log_shipping: getLokiTransport() !== null,
  };
}
