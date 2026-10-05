import { checkOllamaConnectivity } from "../ollama/connectivity-check.js";
import { safeErrorType } from "./worker-runtime.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MissingEnvironment:${name}`);
  return value;
}

export async function main(): Promise<void> {
  const result = await checkOllamaConnectivity({
    baseUrl: required("OLLAMA_BASE_URL"),
    modelId: required("LLM_MODEL_ID"),
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 10_000),
  });
  process.stdout.write(`${JSON.stringify({
    event: "ollama_connectivity_ok",
    version: result.version,
    modelAvailable: result.modelAvailable,
  })}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "ollama_connectivity_failed",
      errorType: safeErrorType(error),
    })}\n`);
    process.exitCode = 1;
  });
}
