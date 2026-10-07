import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
} from "../../ports/llm-provider.js";
import { AnalysisError } from "../../worker/types.js";

type Fact = {
  readonly id: string;
  readonly metric: string;
  readonly scopeId: string;
  readonly direction: "increase" | "decrease" | "stable" | "unavailable";
};

const RULES = [
  {
    category: "cdn_failure",
    metrics: ["cdn_live_err_rate"],
    directions: ["increase"],
    checks: ["network"],
  },
  {
    category: "origin_failure",
    metrics: ["origin_live_err_rate", "origin_cdn_live_err_rate"],
    directions: ["increase"],
    checks: ["network"],
  },
  {
    category: "startup_failure",
    metrics: ["startup_errors_per_session_pooled", "jointime_s_avg"],
    directions: ["increase"],
    checks: ["player"],
  },
  {
    category: "delivery_instability",
    metrics: [
      "bufferratio_avg",
      "latency_ms_avg",
      "latency_ms_p95",
      "stalls_avg",
    ],
    directions: ["increase"],
    checks: ["network", "player"],
  },
  {
    category: "traffic_mix",
    metrics: ["sessions", "active_sessions"],
    directions: ["increase", "decrease"],
    checks: ["traffic"],
  },
] as const;

function factsFrom(request: LlmRequest): readonly Fact[] {
  let raw: unknown;
  try {
    raw = JSON.parse(request.userPrompt);
  } catch {
    throw new AnalysisError("INVALID_RULE_CONTEXT", true);
  }
  if (!raw || typeof raw !== "object" || !("context" in raw))
    throw new AnalysisError("INVALID_RULE_CONTEXT", true);
  const context = (raw as { context?: unknown }).context;
  if (!context || typeof context !== "object" || !("facts" in context))
    throw new AnalysisError("INVALID_RULE_CONTEXT", true);
  const facts = (context as { facts?: unknown }).facts;
  if (!Array.isArray(facts))
    throw new AnalysisError("INVALID_RULE_CONTEXT", true);
  return facts.flatMap((value) => {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      typeof value.metric !== "string" ||
      typeof value.scopeId !== "string" ||
      !["increase", "decrease", "stable", "unavailable"].includes(
        String(value.direction),
      )
    ) return [];
    return [value as Fact];
  });
}

/**
 * Seleção determinística e ancorada no catálogo A′.
 *
 * Este provider não gera texto nem valores: ele só escolhe candidatos já
 * revisados quando há fatos compatíveis. A validação de `interpret()` continua
 * conferindo cada referência antes de publicar o diagnóstico. É o caminho de
 * produção para ambientes sem Bedrock/Ollama, não um duplo de teste.
 */
export function createGroundedRulesProvider(): LlmProvider {
  return {
    async generate(request: LlmRequest): Promise<LlmResponse> {
      const facts = factsFrom(request);
      const hypotheses = RULES.flatMap((rule) => {
        const supporting = facts
          .filter(
            (fact) =>
              (rule.metrics as readonly string[]).includes(fact.metric) &&
              (rule.directions as readonly string[]).includes(fact.direction),
          )
          .map((fact) => ({
            factId: fact.id,
            metric: fact.metric,
            scopeId: fact.scopeId,
            direction: fact.direction,
          }));
        return supporting.length > 0
          ? [{ category: rule.category, supporting, contradicting: [] }]
          : [];
      }).slice(0, 3);
      const categories = new Set(hypotheses.map((item) => item.category));
      const nextChecks = [
        ...new Set(
          RULES.filter((rule) => categories.has(rule.category)).flatMap(
            (rule) => rule.checks,
          ),
        ),
      ].slice(0, 4);
      return {
        text: JSON.stringify({ hypotheses, nextChecks }),
        provider: "grounded-rules",
        modelId: "a-prime-grounded-rules-v1",
        stopReason: "stop",
      };
    },
  };
}
