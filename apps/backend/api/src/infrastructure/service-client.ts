import { context, propagation } from "@opentelemetry/api";
import {
  ServiceError,
  errorCodeSchema,
  internalResponseSchema,
  type InternalResponse,
} from "@view-show/contracts";
import { z } from "zod";

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly requestId: string;
  readonly cookie?: string;
  readonly reviewerId?: string;
  readonly body?: unknown;
}

export interface FullServiceResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

export class ServiceClient {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
    private readonly timeoutMs: number,
  ) {}

  async get<T>(
    path: string,
    requestId: string,
    dataSchema: z.ZodType<T>,
  ): Promise<InternalResponse<T>> {
    const response = await this.request({ path, requestId });
    const parsed = internalResponseSchema(dataSchema).safeParse(response.body);
    if (!parsed.success)
      throw new ServiceError(
        503,
        "DATA_UNAVAILABLE",
        "Um serviço interno respondeu fora do contrato.",
      );
    return parsed.data;
  }

  async mutate<T>(
    options: RequestOptions,
    dataSchema: z.ZodType<T>,
  ): Promise<InternalResponse<T>> {
    const response = await this.request(options);
    const parsed = internalResponseSchema(dataSchema).safeParse(response.body);
    if (!parsed.success)
      throw new ServiceError(
        503,
        "DATA_UNAVAILABLE",
        "Um serviço interno respondeu fora do contrato.",
      );
    return parsed.data;
  }

  async request(options: RequestOptions): Promise<FullServiceResponse> {
    if (Date.now() < this.openUntil)
      throw new ServiceError(
        503,
        "DATA_UNAVAILABLE",
        "O serviço interno está temporariamente isolado após falhas sucessivas.",
      );
    const attempts = (options.method ?? "GET") === "GET" ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          accept: "application/json",
          "content-type": "application/json",
          "x-internal-token": this.internalToken,
          "x-request-id": options.requestId,
        };
        if (options.cookie) headers.cookie = options.cookie;
        if (options.reviewerId) headers["x-reviewer-id"] = options.reviewerId;
        propagation.inject(context.active(), headers);
        const response = await fetch(new URL(options.path, this.baseUrl), {
          method: options.method ?? "GET",
          headers,
          signal: controller.signal,
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        });
        const body: unknown =
          response.status === 204 ? null : await response.json();
        if (!response.ok) throw this.upstreamError(response.status, body);
        this.failures = 0;
        return { status: response.status, body, headers: response.headers };
      } catch (error) {
        lastError = error;
        if (
          error instanceof ServiceError &&
          error.code !== "UPSTREAM_TIMEOUT" &&
          error.status < 500
        )
          throw error;
        if (attempt + 1 < attempts)
          await new Promise((resolve) =>
            setTimeout(resolve, 50 * (attempt + 1)),
          );
      } finally {
        clearTimeout(timeout);
      }
    }
    this.failures += 1;
    if (this.failures >= 3) this.openUntil = Date.now() + 10_000;
    if (lastError instanceof ServiceError) throw lastError;
    if (lastError instanceof Error && lastError.name === "AbortError")
      throw new ServiceError(
        503,
        "UPSTREAM_TIMEOUT",
        "Um serviço interno excedeu o tempo limite.",
      );
    throw new ServiceError(
      503,
      "DATA_UNAVAILABLE",
      "Um serviço interno está indisponível.",
    );
  }

  private upstreamError(status: number, body: unknown): ServiceError {
    if (
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      body.error !== null &&
      typeof body.error === "object"
    ) {
      const record = body.error as Record<string, unknown>;
      const code = errorCodeSchema.safeParse(record.code);
      return new ServiceError(
        status,
        code.success ? code.data : "DATA_UNAVAILABLE",
        typeof record.message === "string"
          ? record.message
          : "Falha em serviço interno.",
        undefined,
        record.details !== null && typeof record.details === "object"
          ? (record.details as Record<string, unknown>)
          : undefined,
      );
    }
    return new ServiceError(
      status >= 500 ? 503 : status,
      status >= 500 ? "DATA_UNAVAILABLE" : "INTERNAL_ERROR",
      "Falha em serviço interno.",
    );
  }
}
