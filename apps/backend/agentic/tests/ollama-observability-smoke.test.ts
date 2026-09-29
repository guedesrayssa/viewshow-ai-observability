import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { runOllamaObservabilitySmoke } from "../src/ollama/observability-smoke.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("smoke invokes Ollama through telemetry and flushes OTLP without logging content", async (context) => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/api/version") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ version: "0.12.3" }));
      return;
    }
    if (request.url === "/api/tags") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }));
      return;
    }
    if (request.url === "/api/chat") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        message: { content: "RESPONSE_SMOKE_SENTINEL" },
        done_reason: "stop",
        prompt_eval_count: 10,
        eval_count: 4,
      }));
      return;
    }
    response.statusCode = 200;
    response.end();
  });
  context.after(() => server.close());
  const baseUrl = await listen(server);
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await runOllamaObservabilitySmoke({
      baseUrl,
      modelId: "qwen2.5:7b",
      otlpEndpoint: baseUrl,
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.ok(paths.includes("/api/chat"));
  assert.ok(paths.includes("/v1/traces"));
  assert.ok(paths.includes("/v1/metrics"));
  assert.match(lines.join(""), /qwen2\.5:7b/);
  assert.match(lines.join(""), /success/);
  assert.doesNotMatch(lines.join(""), /PROMPT_SMOKE_SENTINEL|RESPONSE_SMOKE_SENTINEL/);
});
