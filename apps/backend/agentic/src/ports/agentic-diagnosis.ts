/**
 * Fronteira de consumo: como o resto do backend aciona esta camada.
 *
 * A assinatura é deliberadamente idêntica ao `AgenticDiagnosisPort` que a
 * branch refactor/backend já reservou em
 * `incidents-service/src/ports/incident-repository.ts`, para que a integração
 * seja um adaptador e não uma negociação de contrato.
 *
 * Repare que `requestDiagnosis` devolve "accepted", e não o diagnóstico: o
 * acionamento é assíncrono por construção. Quem chama registra que pediu e lê
 * o resultado depois; nada fica bloqueado esperando um LLM responder.
 */

export type RequestOutcome = "accepted" | "unavailable";

export interface AgenticDiagnosisPort {
  requestDiagnosis(incidentId: string): Promise<RequestOutcome>;
}

export interface ReviewFeedbackPort {
  publish(review: {
    readonly incidentId: string;
    readonly hypothesisId: string;
    readonly status: string;
  }): Promise<RequestOutcome>;
}
