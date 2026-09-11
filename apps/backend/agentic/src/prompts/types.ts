/**
 * Contrato de um template de prompt.
 *
 * Versões coexistem de propósito: a versão fica gravada em todo diagnóstico,
 * então comparar duas nos mesmos casos é o único jeito de saber se uma
 * mudança de redação melhorou ou piorou. Editar o texto no lugar destruiria
 * essa possibilidade.
 */

import type { EvidenceItem, IncidentContext } from "../domain/evidence.js";
import type { MlSignal } from "../domain/ml-result.js";

export interface UserPromptInput {
  readonly incident: IncidentContext;
  readonly evidence: readonly EvidenceItem[];
  readonly signal: MlSignal;
}

export interface PromptTemplate {
  readonly version: string;
  buildSystemPrompt(): string;
  buildUserPrompt(input: UserPromptInput): string;
}
