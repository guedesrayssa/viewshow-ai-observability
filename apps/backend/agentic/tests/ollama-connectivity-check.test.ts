import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  checkOllamaConnectivity,
  OllamaConnectivityError,
} from "../src/ollama/connectivity-check.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

test("checks Ollama version and configured model over HTTP", async (context) => {
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    response.end(request.url === "/api/version"
      ? JSON.stringify({ version: "0.12.3" })
      : JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }));
  });
  context.after(() => server.close());
  const baseUrl = await listen(server);

  assert.deepEqual(await checkOllamaConnectivity({
    baseUrl,
    modelId: "qwen2.5:7b",
    timeoutMs: 100,
  }), { version: "0.12.3", modelAvailable: true });
  assert.deepEqual(paths, ["/api/version", "/api/tags"]);
});

test("uses a stable code when the configured model is absent", async (context) => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(request.url === "/api/version"
      ? JSON.stringify({ version: "0.12.3" })
      : JSON.stringify({ models: [{ name: "another-model" }] }));
  });
  context.after(() => server.close());
  const baseUrl = await listen(server);

  await assert.rejects(
    () => checkOllamaConnectivity({ baseUrl, modelId: "required-model", timeoutMs: 100 }),
    (error: unknown) => error instanceof OllamaConnectivityError &&
      error.code === "OLLAMA_MODEL_UNAVAILABLE",
  );
});

test("maps HTTP and invalid JSON failures without response body leakage", async (context) => {
  for (const scenario of [
    { status: 401, body: "AUTH_BODY_SENTINEL", code: "OLLAMA_CONNECTIVITY_HTTP" },
    { status: 500, body: "HTTP_BODY_SENTINEL", code: "OLLAMA_CONNECTIVITY_HTTP" },
    { status: 200, body: "INVALID_JSON_SENTINEL", code: "OLLAMA_CONNECTIVITY_INVALID_JSON" },
  ] as const) {
    const server = createServer((_request, response) => {
      response.statusCode = scenario.status;
      response.end(scenario.body);
    });
    const baseUrl = await listen(server);
    await assert.rejects(
      () => checkOllamaConnectivity({ baseUrl, modelId: "m", timeoutMs: 100 }),
      (error: unknown) => {
        assert.ok(error instanceof OllamaConnectivityError);
        assert.equal(error.code, scenario.code);
        assert.doesNotMatch(error.message, /SENTINEL/);
        return true;
      },
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  context.after(() => {});
});

test("maps timeout to a stable code", async () => {
  const server = createServer(() => {});
  const baseUrl = await listen(server);
  await assert.rejects(
    () => checkOllamaConnectivity({ baseUrl, modelId: "m", timeoutMs: 10 }),
    (error: unknown) => error instanceof OllamaConnectivityError &&
      error.code === "OLLAMA_CONNECTIVITY_TIMEOUT",
  );
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
