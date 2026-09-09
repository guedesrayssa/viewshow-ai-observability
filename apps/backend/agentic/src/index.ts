/**
 * Superfície pública da camada agêntica. Quem integra importa daqui, e não de
 * caminhos internos — assim a reorganização interna não quebra consumidor.
 */
export * from "./domain/ml-result.js";
export * from "./domain/diagnosis.js";
export * from "./domain/quality-gate.js";
export * from "./domain/response-validation.js";
export * from "./domain/outcome.js";
export * from "./ports/llm-provider.js";
export * from "./ports/agentic-diagnosis.js";
export * from "./adapters/llm/fake-provider.js";
