/**
 * Dados de entrada da investigação, no formato em que a camada agêntica os
 * consome. São estruturas simples de propósito: quem integra converte do seu
 * modelo de persistência para cá, e a camada nunca aprende o schema de ninguém.
 */

export interface EvidenceItem {
  /**
   * Identificador estável dentro do pacote. É o que as hipóteses citam e o que
   * a validação confere — sem id, não há como distinguir evidência real de
   * evidência inventada pelo modelo.
   */
  readonly id: string;
  readonly type: string;
  /** Texto livre vindo de sistema externo. Tratado como DADO, nunca instrução. */
  readonly description: string;
  readonly source: string;
  readonly strength: string;
  readonly capturedAt: string;
}

export interface IncidentContext {
  readonly component: string;
  /**
   * Serviços afetados. É o campo que escopa quais entidades de telemetria são
   * relevantes; ignorá-lo foi o que produziu ~92% de falso positivo por
   * comparações múltiplas no notebook (seção 8).
   */
  readonly services: readonly string[];
  readonly deviceType?: string;
  readonly region?: string;
  readonly appVersion?: string;
}

/** Caso já curado e confirmado por humano, recuperado por assinatura. */
export interface GoldenCase {
  readonly caseId: string;
  readonly signature: string;
  readonly expectedHypothesis: string;
  readonly expectedScore: number;
  readonly curatedBy: string;
}
