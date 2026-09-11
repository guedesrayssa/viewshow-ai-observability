/**
 * Fronteira com o modelo de linguagem. A aplicação depende desta interface e
 * nunca de um SDK: trocar Bedrock por Ollama, ou por um provider novo, é
 * escrever um adaptador, não mexer na lógica de investigação.
 *
 * Só o adaptador conhece protocolo, autenticação e formato de resposta.
 */

export interface LlmRequest {
  readonly systemPrompt: string;
  /**
   * Conteúdo a analisar. Vem de log, alerta e título de incidente — sistemas
   * que o time não controla —, portanto é DADO, nunca instrução. O adaptador
   * delimita este bloco, e a validação de evidência é o que efetivamente
   * segura o caso em que o modelo obedece a um texto injetado aqui.
   */
  readonly userPrompt: string;
}

export interface LlmResponse {
  readonly text: string;
  readonly provider: string;
  readonly modelId: string;
  /**
   * Por que a geração parou. `length` significa resposta cortada: um JSON
   * truncado precisa ser rejeitado como falha, e não aceito como diagnóstico
   * parcial — meia hipótese é pior que nenhuma.
   */
  readonly stopReason: "stop" | "length" | "other";
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

export interface LlmProvider {
  generate(request: LlmRequest): Promise<LlmResponse>;
}
