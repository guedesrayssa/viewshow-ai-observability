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
  schemaVersion: string;
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
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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

type ErrorBody = {
  error?: { code?: string; message?: string; requestId?: string };
};

export async function apiGet<T>(
  path: string,
  params?: QueryParams,
): Promise<GatewayEnvelope<T>> {
  if (!isApiConfigured())
    throw new ApiError("O gateway não está configurado neste ambiente.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetch(gatewayUrl(path, params), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as
      GatewayEnvelope<T> | ErrorBody | null;
    if (!response.ok) {
      reportRum("frontend_api_fetch_errors_total", 1);
      const failure = body && "error" in body ? body.error : undefined;
      throw new ApiError(
        failure?.message ??
          `O gateway respondeu ${response.status} em ${path}.`,
        response.status,
        failure?.code,
        failure?.requestId,
      );
    }
    if (!body || !("data" in body) || !("meta" in body)) {
      throw new ApiError(
        "O gateway devolveu uma resposta fora do contrato.",
        response.status,
      );
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    reportRum("frontend_api_fetch_errors_total", 1);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(
        `O gateway não respondeu em ${REQUEST_TIMEOUT / 1000}s.`,
      );
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Falha ao falar com o gateway.",
    );
  } finally {
    clearTimeout(timeout);
  }
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
