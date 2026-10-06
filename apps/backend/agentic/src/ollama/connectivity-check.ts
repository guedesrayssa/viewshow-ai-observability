export interface OllamaConnectivityResult {
  readonly version: string;
  readonly modelAvailable: boolean;
}

export type OllamaConnectivityErrorCode =
  | "OLLAMA_CONNECTIVITY_TIMEOUT"
  | "OLLAMA_CONNECTIVITY_NETWORK"
  | "OLLAMA_CONNECTIVITY_HTTP"
  | "OLLAMA_CONNECTIVITY_INVALID_JSON"
  | "OLLAMA_CONNECTIVITY_INVALID_RESPONSE"
  | "OLLAMA_MODEL_UNAVAILABLE";

export class OllamaConnectivityError extends Error {
  constructor(readonly code: OllamaConnectivityErrorCode) {
    super(code);
    this.name = "OllamaConnectivityError";
  }
}

async function getJson(options: {
  url: string;
  timeoutMs: number;
  fetch: typeof globalThis.fetch;
}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await options.fetch(options.url, { signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new OllamaConnectivityError("OLLAMA_CONNECTIVITY_TIMEOUT");
    }
    throw new OllamaConnectivityError("OLLAMA_CONNECTIVITY_NETWORK");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new OllamaConnectivityError("OLLAMA_CONNECTIVITY_HTTP");
  try {
    return await response.json();
  } catch {
    throw new OllamaConnectivityError("OLLAMA_CONNECTIVITY_INVALID_JSON");
  }
}

export async function checkOllamaConnectivity(options: {
  baseUrl: string;
  modelId: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}): Promise<OllamaConnectivityResult> {
  const request = options.fetch ?? globalThis.fetch;
  const versionUrl = new URL("/api/version", options.baseUrl).toString();
  const tagsUrl = new URL("/api/tags", options.baseUrl).toString();
  const versionBody = await getJson({ url: versionUrl, timeoutMs: options.timeoutMs, fetch: request });
  const tagsBody = await getJson({ url: tagsUrl, timeoutMs: options.timeoutMs, fetch: request });

  const version = typeof versionBody === "object" && versionBody !== null &&
    "version" in versionBody && typeof versionBody.version === "string"
    ? versionBody.version
    : undefined;
  const models = typeof tagsBody === "object" && tagsBody !== null &&
    "models" in tagsBody && Array.isArray(tagsBody.models)
    ? tagsBody.models
    : undefined;
  if (!version || !models) {
    throw new OllamaConnectivityError("OLLAMA_CONNECTIVITY_INVALID_RESPONSE");
  }
  const modelAvailable = models.some((model) =>
    typeof model === "object" && model !== null &&
    "name" in model && model.name === options.modelId
  );
  if (!modelAvailable) throw new OllamaConnectivityError("OLLAMA_MODEL_UNAVAILABLE");
  return { version, modelAvailable };
}
