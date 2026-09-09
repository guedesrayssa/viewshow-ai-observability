/**
 * Orquestração da investigação — a tradução do fluxograma do parceiro, do
 * ponto "Reunir evidências" em diante.
 *
 * Não lê e não escreve nada: recebe o pacote pronto e devolve o diagnóstico.
 * Nem por port. A decisão é deliberada — enquanto `develop` e
 * `refactor/backend` divergem, quem persiste e como persiste é justamente a
 * parte que ainda vai mudar. Um adaptador em cada backend faz
 * "ler → investigate → gravar"; esta função sobrevive aos dois.
 *
 * O efeito colateral é bom: a camada inteira é testável com um único duplo, o
 * do modelo de linguagem. Sem banco, sem fila, sem rede.
 */

import { evaluateQuality, DEFAULT_POLICY, type GatePolicy } from "../domain/quality-gate.js";
import { parseDiagnosisResponse } from "../domain/response-validation.js";
import { classifyOutcome, rankByConfidence, DEFAULT_CONFIDENCE_FLOOR } from "../domain/outcome.js";
import { buildSystemPrompt, buildUserPrompt, PROMPT_VERSION } from "../prompts/rca-v1.js";
import type { Diagnosis, InvestigationTrigger, Reason } from "../domain/diagnosis.js";
import type { EvidenceItem, GoldenCase, IncidentContext } from "../domain/evidence.js";
import type { MlSignal } from "../domain/ml-result.js";
import type { LlmProvider } from "../ports/llm-provider.js";

export interface InvestigationInput {
  /** Nulo no caminho preventivo: previsão de risco não tem incidente ainda. */
  readonly incidentId: string | null;
  readonly trigger: InvestigationTrigger;
  readonly signal: MlSignal;
  readonly incident: IncidentContext;
  readonly evidence: readonly EvidenceItem[];
  /** Fatos de cobertura que o gate consulta. Quem coleta o dado é quem os conhece. */
  readonly quality: {
    readonly history: { readonly days: number; readonly points: number };
    readonly entities: { readonly scoped: number; readonly observed: number };
    readonly signalAgeMinutes: number;
  };
  /**
   * Caso curado que casa com a assinatura, já resolvido por quem chama. Quando
   * existe, o modelo não é acionado: reaproveitar julgamento humano confirmado
   * é mais barato e mais confiável do que redescobri-lo.
   */
  readonly goldenCase: GoldenCase | null;
}

export interface InvestigationDeps {
  readonly llm: LlmProvider;
  /** Injetado para o resultado ser determinístico em teste. */
  readonly now: () => Date;
  readonly newDiagnosisId: () => string;
  readonly policy?: GatePolicy;
  readonly confidenceFloor?: number;
}

/** Campos comuns a todos os desfechos, para nenhum caminho esquecer um deles. */
function base(input: InvestigationInput, deps: InvestigationDeps) {
  return {
    diagnosisId: deps.newDiagnosisId(),
    incidentId: input.incidentId,
    trigger: input.trigger,
    signal: input.signal,
    createdAt: deps.now().toISOString(),
  };
}

export async function investigate(
  input: InvestigationInput,
  deps: InvestigationDeps,
): Promise<Diagnosis> {
  // 1. Gate de qualidade, ANTES de qualquer chamada paga. Com falso positivo
  //    de 63% a 71% nos detectores, é aqui que a conta do LLM é contida.
  const veredito = evaluateQuality(
    {
      signal: input.signal,
      evidenceCount: input.evidence.length,
      history: input.quality.history,
      entities: input.quality.entities,
      signalAgeMinutes: input.quality.signalAgeMinutes,
    },
    deps.policy ?? DEFAULT_POLICY,
  );

  if (!veredito.ok) {
    return {
      ...base(input, deps),
      status: "deferred",
      hypotheses: [],
      reasons: veredito.reasons,
      source: null,
      model: null,
    };
  }

  // 2. Caso curado tem precedência sobre o modelo. `model` fica nulo de
  //    propósito: nenhum modelo produziu este resultado, e preencher metadados
  //    de provider aqui seria inventar procedência.
  if (input.goldenCase) {
    const caso = input.goldenCase;
    return {
      ...base(input, deps),
      status: "ready",
      hypotheses: [
        {
          id: "hyp_01",
          rank: 1,
          title: caso.expectedHypothesis,
          explanation: `Diagnóstico reaproveitado do caso curado ${caso.caseId}, confirmado por ${caso.curatedBy}.`,
          confidence: caso.expectedScore,
          // O caso curado não guarda quais evidências o sustentaram; a
          // ancoragem aqui é o próprio julgamento humano, registrado acima.
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          missingEvidence: [],
        },
      ],
      reasons: [],
      source: "golden-set",
      model: null,
    };
  }

  // 3. Chamada ao modelo. Qualquer erro daqui é `failed`, não `inconclusive`:
  //    o sistema não funcionou, e essa é a distinção que decide o alarme.
  let resposta;
  try {
    resposta = await deps.llm.generate({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt({
        incident: input.incident,
        evidence: input.evidence,
        signal: input.signal,
      }),
    });
  } catch (error) {
    return {
      ...base(input, deps),
      status: "failed",
      hypotheses: [],
      reasons: [{ code: "PROVIDER_ERROR", detail: (error as Error).message }],
      source: "llm",
      model: null,
    };
  }

  const modelo = {
    provider: resposta.provider,
    modelId: resposta.modelId,
    promptVersion: PROMPT_VERSION,
  };

  // 4. Validação. Resposta que não sobrevive é falha do sistema, não silêncio
  //    do agente — o modelo respondeu, mas fora do contrato.
  const validada = parseDiagnosisResponse(
    resposta,
    new Set(input.evidence.map((item) => item.id)),
  );

  if (!validada.ok) {
    return {
      ...base(input, deps),
      status: "failed",
      hypotheses: [],
      reasons: validada.failures,
      source: "llm",
      model: modelo,
    };
  }

  // 5. Ordena por confiança e decide se há algo firme o bastante para mostrar.
  //    Os descartes viajam junto mesmo no sucesso: hipótese citando evidência
  //    inventada é indício de injeção, e não pode sumir por ter havido outra boa.
  const hypotheses = rankByConfidence(validada.hypotheses);
  const status = classifyOutcome(hypotheses, deps.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR);
  const reasons: readonly Reason[] = validada.discarded;

  return {
    ...base(input, deps),
    status,
    hypotheses,
    reasons,
    source: "llm",
    model: modelo,
  };
}
