/**
 * Estatística do teste de carga do LLM. Separada do script para ser testável
 * sem rede e sem modelo.
 */

export interface Amostra {
  /** Tempo de `investigate` inteiro: prompt, chamada, validação. */
  readonly totalMs: number;
  /** Só a chamada ao provider. Nulo quando o modelo não foi acionado. */
  readonly llmMs: number | null;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface ResumoEstagio {
  readonly concorrencia: number;
  readonly requisicoes: number;
  readonly duracaoMs: number;
  readonly vazaoPorSegundo: number;
  readonly latenciaMs: { readonly min: number; readonly p50: number; readonly p90: number; readonly p95: number; readonly p99: number; readonly max: number; readonly media: number };
  readonly latenciaLlmP95Ms: number | null;
  readonly status: Record<string, number>;
  readonly motivos: Record<string, number>;
  readonly taxaFalha: number;
  readonly tokens: { readonly entrada: number; readonly saida: number };
}

/** Percentil por posto mais próximo — sem interpolação, valor que realmente ocorreu. */
export function percentil(ordenados: readonly number[], p: number): number {
  if (ordenados.length === 0) return 0;
  const posto = Math.ceil((p / 100) * ordenados.length);
  return ordenados[Math.min(Math.max(posto, 1), ordenados.length) - 1]!;
}

function contar(itens: readonly string[]): Record<string, number> {
  const contagem: Record<string, number> = {};
  for (const item of itens) contagem[item] = (contagem[item] ?? 0) + 1;
  return contagem;
}

export function resumir(concorrencia: number, duracaoMs: number, amostras: readonly Amostra[]): ResumoEstagio {
  const totais = amostras.map((a) => a.totalMs).sort((a, b) => a - b);
  const llm = amostras.flatMap((a) => (a.llmMs === null ? [] : [a.llmMs])).sort((a, b) => a - b);
  const falhas = amostras.filter((a) => a.status === "failed").length;
  const soma = totais.reduce((acc, v) => acc + v, 0);

  return {
    concorrencia,
    requisicoes: amostras.length,
    duracaoMs,
    vazaoPorSegundo: duracaoMs > 0 ? Number(((amostras.length * 1000) / duracaoMs).toFixed(3)) : 0,
    latenciaMs: {
      min: totais[0] ?? 0,
      p50: percentil(totais, 50),
      p90: percentil(totais, 90),
      p95: percentil(totais, 95),
      p99: percentil(totais, 99),
      max: totais[totais.length - 1] ?? 0,
      media: totais.length ? Math.round(soma / totais.length) : 0,
    },
    latenciaLlmP95Ms: llm.length ? percentil(llm, 95) : null,
    status: contar(amostras.map((a) => a.status)),
    motivos: contar(amostras.flatMap((a) => a.reasonCodes)),
    taxaFalha: amostras.length ? Number((falhas / amostras.length).toFixed(4)) : 0,
    tokens: {
      entrada: amostras.reduce((acc, a) => acc + (a.inputTokens ?? 0), 0),
      saida: amostras.reduce((acc, a) => acc + (a.outputTokens ?? 0), 0),
    },
  };
}
