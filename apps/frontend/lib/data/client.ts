/** Gateway HTTP client and data-quality boundary used by every dashboard screen. */
import { ALLOW_EXAMPLE_DATA } from "@/lib/data/mode";
import { WARNINGS, type Warning } from "@/lib/data/warnings";
import { reportRum } from "@/lib/rum";

const CONFIGURED_API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const REQUEST_TIMEOUT = 8000;

export type DataSource = "api" | "exemplo" | "indisponivel";
export type Availability = "measured" | "partial" | "unavailable";

export type GatewayMeta = {
  requestId: string;
  schemaVersion: "1.0";
  datasetVersion: string | null;
  generatedAt: string;
  window: { preset: string | null; from: string; to: string } | null;
  partial: boolean;
  refreshAfterSeconds: number | null;
  freshness: Array<{
    source: string;
    observedThrough: string | null;
    lagSeconds: number | null;
    state: "fresh" | "delayed" | "partial" | "unavailable";
  }>;
  warnings: Warning[];
};

export type GatewayEnvelope<T> = { data: T; meta: GatewayMeta };

export type Resource<T> = {
  data?: T;
  source: DataSource;
  availability: Availability;
  warnings: Warning[];
  fetchedAt: Date;
  fallbackReason?: string;
  requestId?: string;
  refreshAfterSeconds?: number | null;
  freshness?: GatewayMeta["freshness"];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly fields?: readonly ApiErrorField[],
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiErrorField = {
  field: string;
  code: string;
  message: string;
};

function apiBase(): URL {
  const configured = CONFIGURED_API_BASE_URL.trim();
  const browserOrigin =
    typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return new URL(configured || "/", browserOrigin);
}

export function isApiConfigured(): boolean {
  return CONFIGURED_API_BASE_URL.trim() !== "";
}

export type QueryParams = Record<string, string | number | undefined>;

export function gatewayUrl(path: string, params?: QueryParams): string {
  const url = apiBase();
  const basePath = url.pathname.replace(/\/$/, "");
  const endpointPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${endpointPath}`.replace(/\/{2,}/g, "/");
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type ApiRequestOptions = {
  method?: ApiMethod;
  params?: QueryParams;
  json?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  expectNoContent?: false;
};

export type ApiNoContentRequestOptions = Omit<
  ApiRequestOptions,
  "expectNoContent"
> & { expectNoContent: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DATASET_VERSION = /^dsv_[0-9a-f]{64}$/;
const ISO_DATE_SOURCE =
  "(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))";
const ISO_DATETIME = new RegExp(
  `^${ISO_DATE_SOURCE}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d+)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$`,
);

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function isIsoDatetime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATETIME.test(value);
}

function isWarning(value: unknown): value is Warning {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["code", "message"]) &&
    typeof value.code === "string" &&
    value.code.length > 0 &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isFreshness(
  value: unknown,
): value is GatewayMeta["freshness"][number] {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["source", "observedThrough", "lagSeconds", "state"]) &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    (value.observedThrough === null || isIsoDatetime(value.observedThrough)) &&
    (value.lagSeconds === null ||
      (typeof value.lagSeconds === "number" &&
        Number.isFinite(value.lagSeconds) &&
        value.lagSeconds >= 0)) &&
    (value.state === "fresh" ||
      value.state === "delayed" ||
      value.state === "partial" ||
      value.state === "unavailable")
  );
}

function isResolvedWindow(
  value: unknown,
): value is NonNullable<GatewayMeta["window"]> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["preset", "from", "to"]) &&
    (value.preset === null || typeof value.preset === "string") &&
    isIsoDatetime(value.from) &&
    isIsoDatetime(value.to)
  );
}

function isGatewayMeta(value: unknown): value is GatewayMeta {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "requestId",
      "schemaVersion",
      "datasetVersion",
      "generatedAt",
      "window",
      "partial",
      "refreshAfterSeconds",
      "freshness",
      "warnings",
    ]) &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.schemaVersion === "1.0" &&
    (value.datasetVersion === null ||
      (typeof value.datasetVersion === "string" &&
        DATASET_VERSION.test(value.datasetVersion))) &&
    isIsoDatetime(value.generatedAt) &&
    (value.window === null || isResolvedWindow(value.window)) &&
    typeof value.partial === "boolean" &&
    (value.refreshAfterSeconds === null ||
      (typeof value.refreshAfterSeconds === "number" &&
        Number.isSafeInteger(value.refreshAfterSeconds) &&
        value.refreshAfterSeconds > 0)) &&
    Array.isArray(value.freshness) &&
    value.freshness.every(isFreshness) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isWarning)
  );
}

function isGatewayEnvelope<T>(value: unknown): value is GatewayEnvelope<T> {
  return isRecord(value) && "data" in value && isGatewayMeta(value.meta);
}

function errorFields(value: unknown): readonly ApiErrorField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: ApiErrorField[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.field !== "string" ||
      typeof item.code !== "string" ||
      typeof item.message !== "string"
    )
      return undefined;
    parsed.push({
      field: item.field,
      code: item.code,
      message: item.message,
    });
  }
  return parsed;
}

function apiFailure(body: unknown, status: number, path: string): ApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return new ApiError(
    typeof error?.message === "string"
      ? error.message
      : `O gateway respondeu ${status} em ${path}.`,
    status,
    typeof error?.code === "string" ? error.code : undefined,
    typeof error?.requestId === "string" ? error.requestId : undefined,
    errorFields(error?.fields),
    isRecord(error?.details) ? error.details : undefined,
  );
}

let redirectingExpiredSession = false;

function redirectExpiredSessionToLogin(): void {
  if (
    redirectingExpiredSession ||
    typeof globalThis.location === "undefined" ||
    globalThis.location.pathname === "/login"
  )
    return;
  const returnTo = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
  redirectingExpiredSession = true;
  globalThis.location.assign(
    new URL(
      `/login?returnTo=${encodeURIComponent(returnTo)}`,
      globalThis.location.origin,
    ).toString(),
  );
}

export function apiRequest(
  path: string,
  options: ApiNoContentRequestOptions,
): Promise<void>;
export function apiRequest<T>(
  path: string,
  options?: ApiRequestOptions,
): Promise<GatewayEnvelope<T>>;
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions | ApiNoContentRequestOptions = {},
): Promise<GatewayEnvelope<T> | void> {
  if (!isApiConfigured())
    throw new ApiError("O gateway não está configurado neste ambiente.");

  const controller = new AbortController();
  let abortCause: "external" | "timeout" | null = null;
  const onExternalAbort = () => {
    if (abortCause !== null) return;
    abortCause = "external";
    controller.abort();
  };
  if (options.signal?.aborted) onExternalAbort();
  else
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT;
  const timeout = setTimeout(() => {
    if (abortCause !== null) return;
    abortCause = "timeout";
    controller.abort();
  }, timeoutMs);

  const headers = new Headers({ Accept: "application/json" });
  if (options.json !== undefined)
    headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined)
    headers.set("Idempotency-Key", options.idempotencyKey);

  try {
    const response = await fetch(gatewayUrl(path, options.params), {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers,
      credentials: "include",
      cache: "no-store",
      ...(options.json === undefined
        ? {}
        : { body: JSON.stringify(options.json) }),
    });
    if (response.status === 204) {
      if (options.expectNoContent) return;
      throw new ApiError(
        "O gateway devolveu uma resposta fora do contrato.",
        response.status,
        "INVALID_API_RESPONSE",
      );
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      reportRum("frontend_api_fetch_errors_total", 1);
      const failure = apiFailure(body, response.status, path);
      if (failure.status === 401 && failure.code === "UNAUTHENTICATED")
        redirectExpiredSessionToLogin();
      throw failure;
    }
    if (!isGatewayEnvelope<T>(body))
      throw new ApiError(
        "O gateway devolveu uma resposta fora do contrato.",
        response.status,
        "INVALID_API_RESPONSE",
      );
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reportRum("frontend_api_fetch_errors_total", 1);
    if (
      controller.signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      if (abortCause === "external")
        throw new ApiError(
          "A solicitação foi cancelada.",
          undefined,
          "ABORTED",
        );
      if (abortCause === "timeout")
        throw new ApiError(
          "O gateway excedeu o tempo limite.",
          undefined,
          "TIMEOUT",
        );
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Falha ao falar com o gateway.",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function apiGet<T>(
  path: string,
  params?: QueryParams,
): Promise<GatewayEnvelope<T>> {
  return apiRequest<T>(path, { params });
}

export async function apiPatch<TBody, TResponse>(
  path: string,
  body: TBody,
): Promise<GatewayEnvelope<TResponse>> {
  return apiRequest<TResponse>(path, { method: "PATCH", json: body });
}

type ResourceShape<TData> = {
  fallback?: () => TData;
  warnings?: Warning[];
};

export type LoadOptions<TResponse, TData> = ResourceShape<TData> & {
  path: string;
  params?: QueryParams;
  map: (response: TResponse, meta: GatewayMeta) => TData;
};

export type ComposeOptions<TData> = ResourceShape<TData> & {
  read: (warn: (warning: Warning) => void) => Promise<{
    data: TData;
    meta?: GatewayMeta;
  }>;
};

function unavailable<TData>(
  reason: Warning,
  fallback: (() => TData) | undefined,
  warnings: Warning[],
): Resource<TData> {
  if (ALLOW_EXAMPLE_DATA && fallback) {
    return {
      data: fallback(),
      source: "exemplo",
      availability: "partial",
      warnings: [reason, WARNINGS.dadoDeExemplo, ...warnings],
      fetchedAt: new Date(),
      fallbackReason: reason.message,
    };
  }
  return {
    source: "indisponivel",
    availability: "unavailable",
    warnings: [reason, ...warnings],
    fetchedAt: new Date(),
    fallbackReason: reason.message,
  };
}

export async function composeResource<TData>({
  read,
  fallback,
  warnings = [],
}: ComposeOptions<TData>): Promise<Resource<TData>> {
  const collected = [...warnings];
  const warn = (warning: Warning) => {
    if (!collected.some((item) => item.code === warning.code))
      collected.push(warning);
  };

  if (!isApiConfigured())
    return unavailable(WARNINGS.apiNaoConfigurada, fallback, collected);
  try {
    const result = await read(warn);
    for (const warning of result.meta?.warnings ?? []) warn(warning);
    return {
      data: result.data,
      source: "api",
      availability:
        result.meta?.partial || collected.length ? "partial" : "measured",
      warnings: collected,
      fetchedAt: new Date(result.meta?.generatedAt ?? Date.now()),
      ...(result.meta
        ? {
            requestId: result.meta.requestId,
            refreshAfterSeconds: result.meta.refreshAfterSeconds,
            freshness: result.meta.freshness,
          }
        : {}),
    };
  } catch (error) {
    return unavailable(
      {
        code:
          error instanceof ApiError
            ? (error.code ?? WARNINGS.leituraFalhou.code)
            : WARNINGS.leituraFalhou.code,
        message:
          error instanceof Error
            ? error.message
            : WARNINGS.leituraFalhou.message,
      },
      fallback,
      collected,
    );
  }
}

export function loadResource<TResponse, TData>({
  path,
  params,
  map,
  fallback,
  warnings,
}: LoadOptions<TResponse, TData>): Promise<Resource<TData>> {
  return composeResource({
    read: async () => {
      const response = await apiGet<TResponse>(path, params);
      return { data: map(response.data, response.meta), meta: response.meta };
    },
    fallback,
    warnings,
  });
}

export function jitter(value: number, seed: number, amplitude = 0.06): number {
  const wave = Math.sin(seed * 12.9898) * 43758.5453;
  const offset = (wave - Math.floor(wave)) * 2 - 1;
  return value * (1 + offset * amplitude);
}
