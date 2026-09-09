/**
 * Validação da resposta do modelo de linguagem.
 *
 * A defesa real contra injeção de prompt não é a instrução no system prompt —
 * é aqui. Evidência vem de log, alerta e título de incidente, sistemas que o
 * time não controla; um texto plantado ali pode convencer o modelo a afirmar
 * qualquer coisa. O que ele NÃO consegue é citar um identificador de evidência
 * que não exista no pacote carregado. Toda hipótese precisa apontar para
 * evidência real, e a que não aponta é descartada independentemente do que
 * afirme.
 *
 * Sem AJV de propósito: o argumento de schema neutro entre linguagens vale
 * para o contrato do evento (produtor Python, consumidor TypeScript), não para
 * esta resposta, que nunca sai do TypeScript. E a parte que mais importa aqui
 * é semântica, não estrutural — AJV não checaria ancoragem em evidência.
 */

import type { Hypothesis } from "./diagnosis.js";
import type { LlmResponse } from "../ports/llm-provider.js";

export type ValidationCode =
  /** Resposta cortada por limite de tokens. Meia hipótese é pior que nenhuma. */
  | "TRUNCATED"
  /** Não é JSON, mesmo depois de remover cerca de código. */
  | "NOT_JSON"
  /** Forma inesperada: campo ausente, tipo errado, valor fora de faixa. */
  | "MALFORMED"
  /** Nenhuma hipótese devolvida. */
  | "EMPTY"
  /** Mais hipóteses do que o teto — sinal de resposta descontrolada. */
  | "TOO_MANY"
  /** Citou evidência que não existe no pacote. O caso que a injeção produz. */
  | "UNKNOWN_EVIDENCE"
  /** Hipótese sem nenhuma evidência de apoio: afirmação sem lastro. */
  | "UNGROUNDED";

export interface ValidationFailure {
  readonly code: ValidationCode;
  readonly detail: string;
}

export type ParseResult =
  | {
      readonly ok: true;
      readonly hypotheses: readonly Hypothesis[];
      /**
       * Hipóteses descartadas numa resposta que ainda assim teve aproveitamento.
       * Uma hipótese citando evidência inventada é indício de injeção parcial, e
       * sumiria justamente no caso em que as outras passaram. Quem consome deve
       * registrar isto mesmo no caminho de sucesso.
       */
      readonly discarded: readonly ValidationFailure[];
    }
  | { readonly ok: false; readonly failures: readonly ValidationFailure[] };

/** Teto de hipóteses aceitas. Acima disso a resposta perdeu o controle. */
export const MAX_HYPOTHESES = 5;

/**
 * Modelos costumam embrulhar JSON em cerca de código, mesmo instruídos a não
 * fazer. Remover é mais barato do que rejeitar uma resposta boa por causa de
 * três crases.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/**
 * Interpreta e valida a resposta.
 *
 * `id` e `rank` não vêm do modelo: id é derivado da posição e rank é a ordem
 * do array. Deixar o modelo inventar identificador convida colisão, e deixá-lo
 * numerar o ranque convida sequência furada — dois erros que simplesmente não
 * podem acontecer se ele nunca escreve esses campos.
 */
export function parseDiagnosisResponse(
  response: LlmResponse,
  knownEvidenceIds: ReadonlySet<string>,
): ParseResult {
  if (response.stopReason === "length") {
    return {
      ok: false,
      failures: [
        {
          code: "TRUNCATED",
          detail: "Geração interrompida por limite de tokens; resposta parcial não é diagnóstico.",
        },
      ],
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stripCodeFence(response.text));
  } catch (error) {
    return {
      ok: false,
      failures: [{ code: "NOT_JSON", detail: `Resposta não é JSON: ${(error as Error).message}` }],
    };
  }

  if (!isPlainObject(payload) || !Array.isArray(payload.hypotheses)) {
    return {
      ok: false,
      failures: [{ code: "MALFORMED", detail: "Esperado um objeto com a lista `hypotheses`." }],
    };
  }

  const bruto = payload.hypotheses;
  if (bruto.length === 0) {
    return { ok: false, failures: [{ code: "EMPTY", detail: "Nenhuma hipótese devolvida." }] };
  }
  if (bruto.length > MAX_HYPOTHESES) {
    return {
      ok: false,
      failures: [
        {
          code: "TOO_MANY",
          detail: `${bruto.length} hipóteses devolvidas; teto é ${MAX_HYPOTHESES}.`,
        },
      ],
    };
  }

  const failures: ValidationFailure[] = [];
  const hypotheses: Hypothesis[] = [];

  bruto.forEach((item, indice) => {
    const posicao = `hypotheses[${indice}]`;

    if (!isPlainObject(item)) {
      failures.push({ code: "MALFORMED", detail: `${posicao} não é um objeto.` });
      return;
    }

    const { title, explanation, confidence } = item;
    const apoio = readStringArray(item.supportingEvidenceIds);
    const contra = readStringArray(item.contradictingEvidenceIds ?? []);
    const faltante = readStringArray(item.missingEvidence ?? []);

    if (typeof title !== "string" || title.trim() === "") {
      failures.push({ code: "MALFORMED", detail: `${posicao}.title ausente ou vazio.` });
      return;
    }
    if (typeof explanation !== "string" || explanation.trim() === "") {
      failures.push({ code: "MALFORMED", detail: `${posicao}.explanation ausente ou vazio.` });
      return;
    }
    // Confiança fora de 0..1 não é "quase certo": é o modelo usando outra
    // escala, e aceitar isso contaminaria qualquer comparação posterior.
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      failures.push({
        code: "MALFORMED",
        detail: `${posicao}.confidence deve ser número entre 0 e 1; veio ${String(confidence)}.`,
      });
      return;
    }
    if (apoio === null || contra === null || faltante === null) {
      failures.push({
        code: "MALFORMED",
        detail: `${posicao} tem lista de evidência que não é array de strings.`,
      });
      return;
    }

    if (apoio.length === 0) {
      failures.push({
        code: "UNGROUNDED",
        detail: `${posicao} não cita nenhuma evidência de apoio.`,
      });
      return;
    }

    const inexistentes = [...apoio, ...contra].filter((id) => !knownEvidenceIds.has(id));
    if (inexistentes.length > 0) {
      failures.push({
        code: "UNKNOWN_EVIDENCE",
        detail: `${posicao} cita evidência inexistente no pacote: ${inexistentes.join(", ")}.`,
      });
      return;
    }

    hypotheses.push({
      id: `hyp_${String(hypotheses.length + 1).padStart(2, "0")}`,
      rank: hypotheses.length + 1,
      title: title.trim(),
      explanation: explanation.trim(),
      confidence,
      supportingEvidenceIds: apoio,
      contradictingEvidenceIds: contra,
      missingEvidence: faltante,
    });
  });

  // Uma hipótese ruim entre várias boas não invalida a resposta inteira — mas
  // uma resposta em que NADA sobreviveu é uma resposta rejeitada, e quem
  // investigar depois precisa dos motivos. Nos dois casos os motivos viajam
  // junto: descartar em silêncio esconderia exatamente o sinal de ataque.
  if (hypotheses.length === 0) {
    return { ok: false, failures };
  }
  return { ok: true, hypotheses, discarded: failures };
}
