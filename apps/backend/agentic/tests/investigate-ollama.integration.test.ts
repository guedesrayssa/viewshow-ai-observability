import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { investigate } from "../src/application/investigate.js";
import { createOllamaProvider } from "../src/adapters/llm/ollama-provider.js";
import type { MlSignal } from "../src/domain/ml-result.js";

/**
 * Integração pelo caminho real: HTTP de verdade, `fetch` de verdade, JSON
 * serializado e desserializado. O duplo de `fetch` dos testes de unidade não
 * exercita nada disso — aqui o único faz-de-conta é o modelo.
 */
function subirOllamaFalso(responder: (prompt: string) => unknown): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let corpo = "";
    req.on("data", (chunk) => (corpo += chunk));
    req.on("end", () => {
      const pedido = JSON.parse(corpo) as { messages: Array<{ role: string; content: string }> };
      const userPrompt = pedido.messages.find((m) => m.role === "user")?.content ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responder(userPrompt)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

const SINAL: MlSignal = {
  detector: "univariate-robust-z",
  scale: "robust-z",
  score: 6,
  threshold: { value: 4, origin: "loio-calibration" },
  model: { name: "robust-z-walkforward", version: "2026.09.01" },
  observedAt: "2026-09-08T12:00:00Z",
  series: { source: "rpaas", entity: "search-api-rpaas-be-gcp-prod", metric: "error_rate" },
};

const ENTRADA = {
  incidentId: "inc-001",
  trigger: "ANOMALY_DETECTION" as const,
  datasetVersion: "dsv_teste",
  signal: SINAL,
  incident: { component: "Playback", services: ["search-api"] },
  evidence: [
    { id: "ev_01", type: "metric", description: "Erro 5xx subiu 4x", source: "rpaas", strength: "forte", capturedAt: "2026-09-08T11:58:00Z" },
    { id: "ev_02", type: "log", description: "Timeout no origin", source: "newrelic", strength: "média", capturedAt: "2026-09-08T11:59:00Z" },
  ],
  quality: { history: { days: 7, points: 480 }, entities: { scoped: 2, observed: 9 }, signalAgeMinutes: 5 },
  goldenCase: null,
};

function deps(url: string) {
  return {
    llm: createOllamaProvider({ baseUrl: url, model: "llama3.1", timeoutMs: 5000 }),
    now: () => new Date("2026-09-08T12:00:05Z"),
    newDiagnosisId: () => "diag_01",
  };
}

test("pipeline completo sobre HTTP real produz diagnóstico pronto", async (t) => {
  const { url, server } = await subirOllamaFalso((prompt) => {
    // O "modelo" responde citando uma evidência que leu do próprio prompt.
    assert.match(prompt, /<<<DADOS_DE_EVIDENCIA>>>/);
    const idsNoPrompt = [...prompt.matchAll(/id: (ev_\d+)/g)].map((m) => m[1]);
    return {
      message: {
        role: "assistant",
        content: JSON.stringify({
          hypotheses: [
            {
              title: "Degradação na origem",
              explanation: "Timeout no origin acompanha a subida de 5xx.",
              confidence: 0.82,
              supportingEvidenceIds: idsNoPrompt,
              contradictingEvidenceIds: [],
              missingEvidence: ["Latência do origin por região"],
            },
          ],
        }),
      },
      done_reason: "stop",
      prompt_eval_count: 400,
      eval_count: 90,
    };
  });
  t.after(() => server.close());

  const resultado = await investigate(ENTRADA, deps(url));

  assert.equal(resultado.status, "ready");
  assert.equal(resultado.source, "llm");
  assert.equal(resultado.model?.provider, "ollama");
  assert.equal(resultado.model?.modelId, "llama3.1");
  assert.equal(resultado.model?.promptVersion, "rca-v1");
  assert.equal(resultado.hypotheses.length, 1);
  assert.deepEqual(resultado.hypotheses[0]?.supportingEvidenceIds, ["ev_01", "ev_02"]);
  assert.deepEqual(resultado.reasons, []);
});

test("modelo que inventa evidência não contamina o diagnóstico", async (t) => {
  const { url, server } = await subirOllamaFalso(() => ({
    message: {
      role: "assistant",
      content: JSON.stringify({
        hypotheses: [
          {
            title: "Causa inventada",
            explanation: "Baseada em evidência que não existe.",
            confidence: 0.99,
            supportingEvidenceIds: ["ev_forjada"],
            contradictingEvidenceIds: [],
            missingEvidence: [],
          },
        ],
      }),
    },
    done_reason: "stop",
  }));
  t.after(() => server.close());

  const resultado = await investigate(ENTRADA, deps(url));

  // Confiança de 0,99 não compra nada: o identificador não existe no pacote.
  assert.equal(resultado.status, "failed");
  assert.deepEqual(resultado.reasons.map((r) => r.code), ["UNKNOWN_EVIDENCE"]);
  assert.equal(resultado.hypotheses.length, 0);
});

test("servidor fora do ar vira failed com motivo de provider", async () => {
  // Porta fechada: exercita o erro de conexão pelo caminho real.
  const resultado = await investigate(ENTRADA, deps("http://127.0.0.1:1"));
  assert.equal(resultado.status, "failed");
  assert.deepEqual(resultado.reasons.map((r) => r.code), ["PROVIDER_ERROR"]);
});

test("gate reprovado não abre conexão nenhuma (fica pendente)", async () => {
  // Aponta para uma porta fechada de propósito: se o gate falhasse em barrar,
  // o teste quebraria com erro de conexão em vez de passar.
  const resultado = await investigate({ ...ENTRADA, evidence: [] }, deps("http://127.0.0.1:1"));
  assert.equal(resultado.status, "pending");
  assert.ok(resultado.reasons.some((r) => r.code === "NO_EVIDENCE"));
});
