export interface ThrottleDecision {
  /** Se esta ocorrência deve ser registrada. */
  readonly emit: boolean;
  /** Ocorrências omitidas desde o último registro (só quando `emit`). */
  readonly suppressed: number;
}

/**
 * Limita a frequência de um registro que se repete a cada requisição durante
 * uma falha persistente (dataset ativo ausente, dependência fora do ar). O
 * primeiro evento de cada janela sai com `suppressed` informando quantos
 * foram omitidos, então o sinal e a dimensão do problema não se perdem.
 *
 * As chaves devem ser um conjunto pequeno e fixo, nunca valores de entrada.
 */
export function createLogThrottle(
  intervalMs = 30_000,
  now: () => number = Date.now,
): (key: string) => ThrottleDecision {
  const windows = new Map<string, { start: number; suppressed: number }>();
  return (key) => {
    const current = now();
    const window = windows.get(key);
    if (!window || current - window.start >= intervalMs) {
      windows.set(key, { start: current, suppressed: 0 });
      return { emit: true, suppressed: window?.suppressed ?? 0 };
    }
    window.suppressed += 1;
    return { emit: false, suppressed: 0 };
  };
}
