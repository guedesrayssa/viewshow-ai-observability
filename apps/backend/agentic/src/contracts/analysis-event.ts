/**
 * Envelope da fila de análise — contrato de `analise-e-ia.md` §4.
 *
 * A fila é SQS Standard (§4), portanto entrega duplicada e fora de ordem são
 * normais, não exceção. Quem consome precisa de dois fatos deste módulo: se a
 * mensagem é válida, e qual a identidade lógica da execução, para deduplicar.
 *
 * Toda falha aqui é PERMANENTE. O documento é explícito: "mensagem sem campo
 * obrigatório, com versão incompatível ou janela inválida é considerada erro
 * permanente e enviada à DLQ". Reprocessar não conserta um contrato quebrado —
 * só queima as cinco tentativas antes de chegar ao mesmo lugar.
 */

export type AnalysisEventType =
  | "ANOMALY_DETECTION"
  | "QOE_FORECAST"
  | "REANALYSIS_REQUESTED";

/** Versão de contrato aceita. Outra versão é erro permanente, não aviso. */
export const SUPPORTED_SCHEMA_VERSION = "1.0";

export interface TimeWindow {
  readonly start: string;
  readonly end: string;
  readonly grainSeconds: number;
}

interface EnvelopeBase {
  readonly eventId: string;
  readonly schemaVersion: string;
  /** Identidade da execução lógica; é o que deduplica, não o `eventId`. */
  readonly idempotencyKey: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly producedAt: string;
  readonly source: string;
}

/** Eventos baseados em janela exigem janela, watermark e versão do dataset. */
export interface WindowedEvent extends EnvelopeBase {
  readonly eventType: "ANOMALY_DETECTION" | "QOE_FORECAST";
  readonly payload: {
    readonly window: TimeWindow;
    readonly inputWatermark: string;
    readonly datasetVersion: string;
    readonly scope?: { readonly kind: string; readonly dimensions: Record<string, unknown> };
    /** Presente em QOE_FORECAST (§4.2). */
    readonly model?: { readonly name: string; readonly version: string };
    readonly targetWindow?: { readonly start: string; readonly end: string };
  };
}

export interface ReanalysisEvent extends EnvelopeBase {
  readonly eventType: "REANALYSIS_REQUESTED";
  readonly payload: {
    readonly incidentId: string;
    readonly requestedBy: string;
    readonly reason: string;
  };
}

export type AnalysisEvent = WindowedEvent | ReanalysisEvent;

export interface ContractFailure {
  readonly code:
    | "NOT_AN_OBJECT"
    | "MISSING_FIELD"
    | "UNSUPPORTED_SCHEMA_VERSION"
    | "UNKNOWN_EVENT_TYPE"
    | "INVALID_WINDOW"
    | "INVALID_TIMESTAMP";
  readonly detail: string;
}

/**
 * Metadados que acompanham a mensagem para a DLQ.
 *
 * Só identificadores. O documento pede metadados "sanitizados" (§4), e o
 * payload pode carregar dimensões de escopo vindas de telemetria — despejar
 * isso na DLQ espalharia dado que não precisa estar lá.
 */
export interface SanitizedFailureMetadata {
  readonly eventId: string | null;
  readonly eventType: string | null;
  readonly traceId: string | null;
  readonly schemaVersion: string | null;
  readonly failures: readonly ContractFailure[];
}

export type EventParseResult =
  | { readonly ok: true; readonly event: AnalysisEvent }
  /** `permanent` é sempre true: nenhuma falha de contrato melhora com retentativa. */
  | { readonly ok: false; readonly permanent: true; readonly metadata: SanitizedFailureMetadata };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** ISO 8601 que o `Date` consegue interpretar. Data inválida é erro de contrato. */
function isValidTimestamp(value: unknown): boolean {
  const bruto = text(value);
  return bruto !== null && !Number.isNaN(Date.parse(bruto));
}

const CAMPOS_ENVELOPE = [
  "eventId",
  "eventType",
  "schemaVersion",
  "idempotencyKey",
  "traceId",
  "occurredAt",
  "producedAt",
] as const;

const TIPOS: readonly string[] = ["ANOMALY_DETECTION", "QOE_FORECAST", "REANALYSIS_REQUESTED"];

export function parseAnalysisEvent(raw: unknown): EventParseResult {
  const failures: ContractFailure[] = [];

  if (!isObject(raw)) {
    return {
      ok: false,
      permanent: true,
      metadata: {
        eventId: null,
        eventType: null,
        traceId: null,
        schemaVersion: null,
        failures: [{ code: "NOT_AN_OBJECT", detail: "Mensagem não é um objeto JSON." }],
      },
    };
  }

  for (const campo of CAMPOS_ENVELOPE) {
    if (text(raw[campo]) === null) {
      failures.push({ code: "MISSING_FIELD", detail: `Campo obrigatório ausente ou vazio: ${campo}.` });
    }
  }

  if (raw.schemaVersion !== undefined && raw.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    failures.push({
      code: "UNSUPPORTED_SCHEMA_VERSION",
      detail: `Versão ${String(raw.schemaVersion)} não suportada; esperada ${SUPPORTED_SCHEMA_VERSION}.`,
    });
  }

  const tipo = text(raw.eventType);
  if (tipo !== null && !TIPOS.includes(tipo)) {
    failures.push({ code: "UNKNOWN_EVENT_TYPE", detail: `Tipo desconhecido: ${tipo}.` });
  }

  for (const campo of ["occurredAt", "producedAt"] as const) {
    if (raw[campo] !== undefined && !isValidTimestamp(raw[campo])) {
      failures.push({ code: "INVALID_TIMESTAMP", detail: `${campo} não é um instante ISO 8601 válido.` });
    }
  }

  const payload = isObject(raw.payload) ? raw.payload : null;
  if (payload === null) {
    failures.push({ code: "MISSING_FIELD", detail: "Campo obrigatório ausente: payload." });
  } else if (tipo === "ANOMALY_DETECTION" || tipo === "QOE_FORECAST") {
    validarEventoDeJanela(payload, failures);
  } else if (tipo === "REANALYSIS_REQUESTED") {
    for (const campo of ["incidentId", "requestedBy", "reason"] as const) {
      if (text(payload[campo]) === null) {
        failures.push({ code: "MISSING_FIELD", detail: `Campo obrigatório ausente: payload.${campo}.` });
      }
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      permanent: true,
      metadata: {
        eventId: text(raw.eventId),
        eventType: text(raw.eventType),
        traceId: text(raw.traceId),
        schemaVersion: text(raw.schemaVersion),
        failures,
      },
    };
  }

  return { ok: true, event: raw as unknown as AnalysisEvent };
}

function validarEventoDeJanela(payload: Record<string, unknown>, failures: ContractFailure[]): void {
  for (const campo of ["inputWatermark", "datasetVersion"] as const) {
    if (text(payload[campo]) === null) {
      failures.push({ code: "MISSING_FIELD", detail: `Campo obrigatório ausente: payload.${campo}.` });
    }
  }

  const janela = payload.window;
  if (!isObject(janela)) {
    failures.push({ code: "MISSING_FIELD", detail: "Campo obrigatório ausente: payload.window." });
    return;
  }

  if (!isValidTimestamp(janela.start) || !isValidTimestamp(janela.end)) {
    failures.push({ code: "INVALID_WINDOW", detail: "window.start e window.end precisam ser ISO 8601 válidos." });
    return;
  }

  // Janela invertida ou de duração zero não descreve intervalo nenhum, e
  // passaria despercebida por uma checagem que só olha se os campos existem.
  if (Date.parse(String(janela.start)) >= Date.parse(String(janela.end))) {
    failures.push({ code: "INVALID_WINDOW", detail: "window.start precisa ser anterior a window.end." });
  }

  const grao = janela.grainSeconds;
  if (typeof grao !== "number" || !Number.isFinite(grao) || grao <= 0) {
    failures.push({ code: "INVALID_WINDOW", detail: "window.grainSeconds precisa ser número positivo." });
  }
}

/**
 * Identidade determinística da execução lógica (§5):
 * `analysisRunId = hash(eventType + idempotencyKey)`.
 *
 * O `eventId` muda a cada republicação técnica e NÃO serve para deduplicar; a
 * `idempotencyKey` é que representa a execução. Uma reanálise pedida por uma
 * pessoa recebe chave nova de propósito, porque é outra execução lógica.
 *
 * Recebe a função de hash em vez de importar `node:crypto`: mantém o núcleo
 * sem dependência de plataforma e deixa o teste determinístico.
 */
export function analysisRunId(
  event: Pick<AnalysisEvent, "eventType" | "idempotencyKey">,
  hash: (input: string) => string,
): string {
  return hash(`${event.eventType}${event.idempotencyKey}`);
}
