import {
  ApiError,
  apiRequest,
  type ApiRequestOptions,
  type GatewayEnvelope,
} from "@/lib/data/client";
import { ENDPOINTS } from "@/lib/data/endpoints";
import {
  parseImportPage,
  parseDatasetActivation,
  parseImportParts,
  parseImportSnapshot,
  parseSignedImportParts,
  type ImportPage,
  type DatasetActivation,
  type ImportPart,
  type ImportSnapshot,
  type SignedImportPart,
} from "@/lib/imports/types";

export type RequestControl = { signal?: AbortSignal };
export type MutableControl = RequestControl & { idempotencyKey: string };

export type StartImportInput = {
  fileName: string;
  sizeBytes: number;
  snapshotExtractedOn: string;
};

export type SignImportPartInput = {
  partNumber: number;
  checksumSha256: string;
};

export type CompleteImportPartInput = SignImportPartInput & { etag: string };

export type ImportRequester = (
  path: string,
  options?: ApiRequestOptions,
) => Promise<GatewayEnvelope<unknown>>;

function withSignal<T extends ApiRequestOptions>(
  options: T,
  control?: RequestControl,
): T {
  if (!control?.signal) return options;
  return { ...options, signal: control.signal };
}

function invalidImportResponse(error: unknown): never {
  throw new ApiError(
    error instanceof Error
      ? error.message
      : "A API devolveu dados de importação fora do contrato.",
    undefined,
    "INVALID_API_RESPONSE",
  );
}

async function parsed<T>(
  promise: Promise<GatewayEnvelope<unknown>>,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse((await promise).data);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalidImportResponse(error);
  }
}

const defaultRequester: ImportRequester = (path, options) =>
  apiRequest<unknown>(path, options);

export class ImportClient {
  constructor(private readonly request: ImportRequester = defaultRequester) {}

  list(
    query: { limit?: number; cursor?: string } = {},
    control?: RequestControl,
  ): Promise<ImportPage> {
    return parsed(
      this.request(
        ENDPOINTS.imports.root,
        withSignal({ method: "GET", params: query }, control),
      ),
      parseImportPage,
    );
  }

  get(importId: string, control?: RequestControl): Promise<ImportSnapshot> {
    return parsed(
      this.request(
        ENDPOINTS.imports.status(importId),
        withSignal({ method: "GET" }, control),
      ),
      parseImportSnapshot,
    );
  }

  start(
    body: StartImportInput,
    control: MutableControl,
  ): Promise<ImportSnapshot> {
    return parsed(
      this.request(
        ENDPOINTS.imports.root,
        withSignal(
          {
            method: "POST",
            json: body,
            idempotencyKey: control.idempotencyKey,
          },
          control,
        ),
      ),
      parseImportSnapshot,
    );
  }

  listParts(importId: string, control?: RequestControl): Promise<ImportPart[]> {
    return parsed(
      this.request(
        ENDPOINTS.imports.parts(importId),
        withSignal({ method: "GET" }, control),
      ),
      parseImportParts,
    );
  }

  signParts(
    importId: string,
    parts: SignImportPartInput[],
    control?: RequestControl,
  ): Promise<SignedImportPart[]> {
    return parsed(
      this.request(
        ENDPOINTS.imports.parts(importId),
        withSignal({ method: "POST", json: { parts } }, control),
      ),
      parseSignedImportParts,
    );
  }

  restart(importId: string, control: MutableControl): Promise<ImportSnapshot> {
    return parsed(
      this.request(
        ENDPOINTS.imports.restart(importId),
        withSignal(
          {
            method: "POST",
            json: {},
            idempotencyKey: control.idempotencyKey,
          },
          control,
        ),
      ),
      parseImportSnapshot,
    );
  }

  complete(
    importId: string,
    parts: CompleteImportPartInput[],
    control: MutableControl,
  ): Promise<ImportSnapshot> {
    return parsed(
      this.request(
        ENDPOINTS.imports.complete(importId),
        withSignal(
          {
            method: "POST",
            json: { parts },
            idempotencyKey: control.idempotencyKey,
          },
          control,
        ),
      ),
      parseImportSnapshot,
    );
  }

  activate(
    importId: string,
    control: MutableControl,
  ): Promise<DatasetActivation> {
    return parsed(
      this.request(
        ENDPOINTS.imports.activate(importId),
        withSignal(
          {
            method: "POST",
            json: {},
            idempotencyKey: control.idempotencyKey,
          },
          control,
        ),
      ),
      parseDatasetActivation,
    );
  }
}

export function createImportIdempotencyKey(
  action: "start" | "restart" | "complete" | "activate",
): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function")
    return `import-${action}-${browserCrypto.randomUUID()}`;
  if (typeof browserCrypto?.getRandomValues !== "function")
    throw new Error("O navegador não oferece aleatoriedade segura.");
  const bytes = browserCrypto.getRandomValues(new Uint8Array(24));
  let token = "";
  for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
  return `import-${action}-${token}`;
}
