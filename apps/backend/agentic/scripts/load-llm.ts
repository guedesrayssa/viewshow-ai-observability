/**
 * Teste de carga da camada de LLM.
 *
 * Exercita `investigate()` — prompt, chamada ao provider, validação — sob
 * concorrência crescente, em modelo fechado: C clientes, cada um disparando a
 * próxima investigação assim que a anterior volta. É o formato do worker, que
 * processa no máximo WORKER_CONCURRENCY mensagens por vez; a pergunta é qual
 * concorrência o provider sustenta antes de a latência ou a taxa de falha
 * estourar.
 *
 * Providers:
 *   fake    — padrão. Latência simulada com jitter; mede o custo da própria
 *             camada (montagem de prompt, parse, validação) e serve de linha
 *             de base. Não diz nada sobre o modelo.
 *   ollama  — OLLAMA_BASE_URL, LLM_MODEL_ID.
 *   bedrock — AWS_REGION, LLM_MODEL_ID. Custa dinheiro: comece pequeno.
 *
 * Uso:
 *   npm run load:llm
 *   LLM_PROVIDER=ollama LLM_MODEL_ID=llama3.1 STAGES=1,2,4 REQUESTS_PER_STAGE=20 npm run load:llm
 *   LLM_PROVIDER=bedrock LLM_MODEL_ID=<id> STAGES=1,2 REQUESTS_PER_STAGE=10 npm run load:llm
 *
 * Variáveis: STAGES (1,2,4,8,16), REQUESTS_PER_STAGE (50), FAKE_LATENCY_MS
 * (800), FAKE_JITTER_MS (400), FAKE_ERROR_RATE (0), LLM_TIMEOUT_MS (120000),
 * LLM_MAX_TOKENS (2500), P95_MAX_MS, ERROR_RATE_MAX (0.05), OUT (arquivo JSON).
 *
 * Sai com código 1 se algum estágio violar ERROR_RATE_MAX ou P95_MAX_MS.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { investigate, type InvestigationInput } from "../src/application/investigate.js";
import { createFakeProvider } from "../src/adapters/llm/fake-provider.js";
import { createOllamaProvider } from "../src/adapters/llm/ollama-provider.js";
import { createBedrockProvider, type ConverseInput, type ConverseOutput } from "../src/adapters/llm/bedrock-provider.js";
import type { LlmProvider, LlmRequest, LlmResponse } from "../src/ports/llm-provider.js";
import type { MlSignal } from "../src/domain/ml-result.js";
import { resumir, type Amostra, type ResumoEstagio } from "./load-stats.js";

const PROVIDER = process.env.LLM_PROVIDER ?? "fake";
const STAGES = (process.env.STAGES ?? "1,2,4,8,16").split(",").map(Number).filter((n) => n > 0);
const REQUESTS_PER_STAGE = Number(process.env.REQUESTS_PER_STAGE ?? 50);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 2500);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);
const P95_MAX_MS = process.env.P95_MAX_MS ? Number(process.env.P95_MAX_MS) : null;
const ERROR_RATE_MAX = Number(process.env.ERROR_RATE_MAX ?? 0.05);
const OUT = process.env.OUT ?? `resultados-carga/llm-${PROVIDER}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

const SINAL: MlSignal = {
  detector: "univariate-robust-z",
  scale: "robust-z",
  score: 7.4,
  threshold: { value: 4, origin: "loio-calibration" },
  model: { name: "robust-z-walkforward", version: "2026.09.01" },
  observedAt: "2026-09-09T14:00:00.000Z",
  series: { source: "rpaas", entity: "globoplay-search-api-gcp-prod", metric: "error_rate" },
};

const BASE: InvestigationInput = {
  incidentId: "inc_load",
  trigger: "ANOMALY_DETECTION",
  datasetVersion: "dsv_load",
  signal: SINAL,
  incident: { component: "Playback", services: ["search-api"], deviceType: "Smart TV", region: "Sudeste" },
  evidence: [],
  quality: { history: { days: 9, points: 620 }, entities: { scoped: 3, observed: 14 }, signalAgeMinutes: 4 },
  goldenCase: null,
};

/**
 * Mistura de cargas. O caso sem evidência é barrado pelo gate e nunca chega
 * ao modelo — entra na mistura porque em produção boa parte dos sinais é
 * assim, e a vazão real depende dessa proporção.
 */
const CENARIOS: readonly InvestigationInput[] = [
  {
    ...BASE,
    evidence: [
      { id: "ev_01", type: "metric", description: "Taxa de erro 5xx na Search API subiu de 0,4% para 6,1% em 10 minutos.", source: "rpaas", strength: "forte", capturedAt: "2026-09-09T13:52:00.000Z" },
      { id: "ev_02", type: "log", description: "Timeouts de conexão com o origin: 2.400 ocorrências, todas em GCP us-east1.", source: "newrelic", strength: "forte", capturedAt: "2026-09-09T13:55:00.000Z" },
      { id: "ev_03", type: "deploy", description: "Deploy da versão 4.12.0 do search-api concluído às 13:47.", source: "argus", strength: "média", capturedAt: "2026-09-09T13:47:00.000Z" },
      { id: "ev_04", type: "metric", description: "Buffer ratio médio em Smart TV subiu de 1,2% para 4,8%.", source: "youbora", strength: "média", capturedAt: "2026-09-09T13:58:00.000Z" },
    ],
  },
  {
    ...BASE,
    evidence: [
      { id: "ev_01", type: "log", description: "Alguns usuários relataram lentidão.", source: "suporte", strength: "fraca", capturedAt: "2026-09-09T13:50:00.000Z" },
      { id: "ev_02", type: "metric", description: "Variação de 0,3% na taxa de erro, dentro do ruído habitual.", source: "prometheus", strength: "fraca", capturedAt: "2026-09-09T13:55:00.000Z" },
    ],
  },
  { ...BASE, evidence: [] },
];

/** Fake com latência variável e erro injetável; o fake puro só tem atraso fixo. */
function criarFake(): LlmProvider {
  const latencia = Number(process.env.FAKE_LATENCY_MS ?? 800);
  const jitter = Number(process.env.FAKE_JITTER_MS ?? 400);
  const taxaErro = Number(process.env.FAKE_ERROR_RATE ?? 0);
  const fake = createFakeProvider({
    hypotheses: [
      { title: "Regressão no deploy 4.12.0 do search-api", explanation: "Erros sobem logo após o deploy.", confidence: 0.72, supportingEvidenceIds: ["ev_01"] },
    ],
  });
  return {
    async generate(request) {
      await new Promise((r) => setTimeout(r, Math.max(0, latencia + (Math.random() * 2 - 1) * jitter)));
      if (Math.random() < taxaErro) throw new Error("fake: erro injetado");
      const resposta = await fake.generate(request);
      return { ...resposta, usage: { inputTokens: Math.ceil((request.systemPrompt.length + request.userPrompt.length) / 4), outputTokens: Math.ceil(resposta.text.length / 4) } };
    },
  };
}

function criarProvider(): { llm: LlmProvider; modelo: string } {
  const modelo = process.env.LLM_MODEL_ID ?? "";
  switch (PROVIDER) {
    case "fake":
      return { llm: criarFake(), modelo: "fake-deterministic" };
    case "ollama":
      return {
        llm: createOllamaProvider({ baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434", model: modelo || "llama3.1", maxTokens: MAX_TOKENS, temperature: 0, timeoutMs: TIMEOUT_MS }),
        modelo: modelo || "llama3.1",
      };
    case "bedrock": {
      if (!modelo) throw new Error("LLM_MODEL_ID é obrigatório para bedrock.");
      // Sem retentativa do SDK: o teste quer ver o throttling, não escondê-lo.
      const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1", maxAttempts: 1 });
      return {
        llm: createBedrockProvider({
          modelId: modelo,
          maxTokens: MAX_TOKENS,
          temperature: 0,
          converse: async (input: ConverseInput) =>
            (await client.send(new ConverseCommand(input as unknown as ConstructorParameters<typeof ConverseCommand>[0]))) as unknown as ConverseOutput,
        }),
        modelo,
      };
    }
    default:
      throw new Error(`LLM_PROVIDER desconhecido: ${PROVIDER}`);
  }
}

async function rodarEstagio(llm: LlmProvider, concorrencia: number): Promise<ResumoEstagio> {
  const amostras: Amostra[] = [];
  let proximo = 0;
  let seq = 0;

  const cliente = async (): Promise<void> => {
    while (proximo < REQUESTS_PER_STAGE) {
      const indice = proximo++;
      const cenario = CENARIOS[indice % CENARIOS.length]!;
      const entrada: InvestigationInput = { ...cenario, incidentId: `inc_load_${concorrencia}_${indice}` };

      let llmMs: number | null = null;
      let usage: LlmResponse["usage"];
      const deps = {
        llm: {
          async generate(req: LlmRequest) {
            const inicio = performance.now();
            try {
              const r = await llm.generate(req);
              usage = r.usage;
              return r;
            } finally {
              llmMs = Math.round(performance.now() - inicio);
            }
          },
        },
        now: () => new Date(),
        newDiagnosisId: () => `diag_load_${++seq}`,
      };

      const inicio = performance.now();
      const diagnostico = await investigate(entrada, deps);
      amostras.push({
        totalMs: Math.round(performance.now() - inicio),
        llmMs,
        status: diagnostico.status,
        reasonCodes: diagnostico.reasons.map((r) => r.code),
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      });
    }
  };

  const inicio = performance.now();
  await Promise.all(Array.from({ length: concorrencia }, cliente));
  return resumir(concorrencia, Math.round(performance.now() - inicio), amostras);
}

function imprimir(r: ResumoEstagio): void {
  const l = r.latenciaMs;
  console.log(
    `  C=${String(r.concorrencia).padStart(3)}  n=${r.requisicoes}  ${r.vazaoPorSegundo.toFixed(2).padStart(7)} req/s  ` +
      `p50=${l.p50}ms p95=${l.p95}ms p99=${l.p99}ms max=${l.max}ms  llm-p95=${r.latenciaLlmP95Ms ?? "—"}ms  ` +
      `falha=${(r.taxaFalha * 100).toFixed(1)}%  ${JSON.stringify(r.status)}`,
  );
  const motivos = Object.entries(r.motivos);
  if (motivos.length) console.log(`         motivos: ${motivos.map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

async function main(): Promise<void> {
  const { llm, modelo } = criarProvider();
  console.log(`Carga da camada de LLM\n  provider: ${PROVIDER}   modelo: ${modelo}\n  estágios: ${STAGES.join(", ")}   requisições/estágio: ${REQUESTS_PER_STAGE}\n`);

  // Aquecimento fora da medição: primeira chamada ao Ollama carrega o modelo na memória.
  if (PROVIDER !== "fake") {
    process.stdout.write("  aquecendo… ");
    await investigate(CENARIOS[0]!, { llm, now: () => new Date(), newDiagnosisId: () => "diag_warmup" });
    console.log("ok\n");
  }

  const estagios: ResumoEstagio[] = [];
  const violacoes: string[] = [];
  for (const c of STAGES) {
    const r = await rodarEstagio(llm, c);
    imprimir(r);
    estagios.push(r);
    if (r.taxaFalha > ERROR_RATE_MAX) violacoes.push(`C=${c}: taxa de falha ${r.taxaFalha} > ${ERROR_RATE_MAX}`);
    if (P95_MAX_MS !== null && r.latenciaMs.p95 > P95_MAX_MS) violacoes.push(`C=${c}: p95 ${r.latenciaMs.p95}ms > ${P95_MAX_MS}ms`);
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify({ executadoEm: new Date().toISOString(), provider: PROVIDER, modelo, maxTokens: MAX_TOKENS, requisicoesPorEstagio: REQUESTS_PER_STAGE, limites: { p95MaxMs: P95_MAX_MS, taxaFalhaMax: ERROR_RATE_MAX }, estagios, violacoes }, null, 2),
  );
  console.log(`\n  resultado: ${OUT}`);

  if (violacoes.length) {
    console.log("\n  ✗ limites violados:");
    for (const v of violacoes) console.log(`    · ${v}`);
    process.exit(1);
  }
  console.log("  ✓ todos os estágios dentro dos limites");
}

main().catch((erro: unknown) => {
  console.error("\nFalha no teste de carga:", erro);
  process.exit(1);
});
