/**
 * Envio best-effort das linhas de log ao Loki, em lote.
 *
 * O `stdout` continua sendo o destino durável (no Fargate o driver `awslogs`
 * o leva ao CloudWatch). Este transporte é um segundo caminho, só para a
 * correlação no Grafana, e por isso nunca pode atrapalhar a API:
 *   - agrupa linhas e envia uma requisição por intervalo, em vez de uma por
 *     linha (a task de 0,25 vCPU já é limitada por CPU);
 *   - o buffer é limitado: no excesso descarta as linhas mais antigas e conta;
 *   - falha de rede só incrementa um contador; não há retentativa nem exceção;
 *   - o temporizador não mantém o processo vivo (`unref`).
 */

export interface LokiStreamLabels {
  readonly service_name: string;
  readonly level: string;
  readonly environment: string;
}

export interface LokiTransportOptions {
  readonly url: string;
  readonly flushIntervalMs?: number;
  readonly maxBatchLines?: number;
  readonly maxBufferLines?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface LogTransportStats {
  readonly enabled: boolean;
  readonly pushedLines: number;
  readonly failures: number;
  readonly droppedLines: number;
  readonly bufferedLines: number;
}

interface Entry {
  readonly streamKey: string;
  readonly labels: LokiStreamLabels;
  readonly timestamp: string;
  readonly line: string;
}

const DEFAULTS = {
  flushIntervalMs: 1_000,
  maxBatchLines: 500,
  maxBufferLines: 5_000,
  timeoutMs: 2_000,
} as const;

export class LokiTransport {
  private buffer: Entry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private sequence = 0;
  private pushedLines = 0;
  private failures = 0;
  private droppedLines = 0;
  private readonly flushIntervalMs: number;
  private readonly maxBatchLines: number;
  private readonly maxBufferLines: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: LokiTransportOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULTS.flushIntervalMs;
    this.maxBatchLines = options.maxBatchLines ?? DEFAULTS.maxBatchLines;
    this.maxBufferLines = options.maxBufferLines ?? DEFAULTS.maxBufferLines;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  get url(): string {
    return this.options.url;
  }

  enqueue(labels: LokiStreamLabels, line: string, epochMs: number): void {
    // Os 6 dígitos finais desempatam linhas do mesmo milissegundo.
    this.sequence = (this.sequence + 1) % 1_000_000;
    this.buffer.push({
      streamKey: `${labels.service_name}\u0000${labels.level}\u0000${labels.environment}`,
      labels,
      timestamp: `${epochMs}${String(this.sequence).padStart(6, "0")}`,
      line,
    });
    const overflow = this.buffer.length - this.maxBufferLines;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.droppedLines += overflow;
    }
    if (this.buffer.length >= this.maxBatchLines) {
      void this.flush();
      return;
    }
    this.schedule();
  }

  /** Envia o que está no buffer; nunca rejeita. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.inFlight) return this.inFlight;
    if (this.buffer.length === 0) return Promise.resolve();
    this.inFlight = this.drain().finally(() => {
      this.inFlight = undefined;
      if (this.buffer.length > 0) this.schedule();
    });
    return this.inFlight;
  }

  stats(): LogTransportStats {
    return {
      enabled: true,
      pushedLines: this.pushedLines,
      failures: this.failures,
      droppedLines: this.droppedLines,
      bufferedLines: this.buffer.length,
    };
  }

  private schedule(): void {
    if (this.timer || this.inFlight) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.maxBatchLines);
      const streams = new Map<
        string,
        { stream: LokiStreamLabels; values: [string, string][] }
      >();
      for (const entry of batch) {
        let stream = streams.get(entry.streamKey);
        if (!stream) {
          stream = { stream: entry.labels, values: [] };
          streams.set(entry.streamKey, stream);
        }
        stream.values.push([entry.timestamp, entry.line]);
      }
      try {
        const response = await this.fetchImpl(this.options.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
          body: JSON.stringify({ streams: [...streams.values()] }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.pushedLines += batch.length;
      } catch {
        // O stdout segue como fonte durável; aqui só medimos a perda.
        this.failures += 1;
        this.droppedLines += batch.length;
        return;
      }
    }
  }
}

let transport: LokiTransport | null | undefined;

function positiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Transporte do processo, criado sob demanda a partir de `LOKI_PUSH_URL`. */
export function getLokiTransport(): LokiTransport | null {
  if (transport !== undefined) return transport;
  const url = process.env.LOKI_PUSH_URL?.trim();
  if (!url) {
    transport = null;
    return transport;
  }
  const flushIntervalMs = positiveInteger("LOKI_FLUSH_INTERVAL_MS");
  const maxBatchLines = positiveInteger("LOKI_MAX_BATCH_LINES");
  const maxBufferLines = positiveInteger("LOKI_MAX_BUFFER_LINES");
  transport = new LokiTransport({
    url,
    ...(flushIntervalMs !== undefined ? { flushIntervalMs } : {}),
    ...(maxBatchLines !== undefined ? { maxBatchLines } : {}),
    ...(maxBufferLines !== undefined ? { maxBufferLines } : {}),
  });
  return transport;
}

export async function flushLogs(): Promise<void> {
  await transport?.flush();
}

export function getLogTransportStats(): LogTransportStats {
  return (
    transport?.stats() ?? {
      enabled: false,
      pushedLines: 0,
      failures: 0,
      droppedLines: 0,
      bufferedLines: 0,
    }
  );
}

/** Descarta o transporte do processo; usado para reconfigurar em testes. */
export function resetLogTransport(): void {
  transport = undefined;
}
