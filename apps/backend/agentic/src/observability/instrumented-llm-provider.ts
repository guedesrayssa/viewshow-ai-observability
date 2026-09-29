import type { LlmProvider } from "../ports/llm-provider.js";
import type { AgenticTelemetry, LlmIdentity } from "./agentic-telemetry.js";

export function instrumentLlmProvider(
  provider: LlmProvider,
  telemetry: AgenticTelemetry,
  identity: LlmIdentity,
): LlmProvider {
  return {
    generate: (request) => telemetry.traceLlm(
      identity,
      () => provider.generate(request),
    ),
  };
}
