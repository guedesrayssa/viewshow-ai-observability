/**
 * Sanitização de tudo que sai da API como telemetria (logs e eventos de span).
 *
 * Duas camadas independentes, porque nenhuma sozinha basta:
 *   1. por NOME do campo: qualquer chave que sugira credencial é substituída,
 *      qualquer que seja o valor;
 *   2. por VALOR: textos livres (mensagens de erro de SDK, URLs) passam por
 *      padrões de JWT, Bearer, chaves AWS, assinaturas de URL pré-assinada,
 *      pares `senha=valor` e e-mails.
 *
 * A redação acontece aqui, no logger, e não é delegada à disciplina de cada
 * chamador.
 */

export const REDACTED = "[REDACTED]";

const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 2_000;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 60;
const MAX_STACK_LINES = 12;

const SENSITIVE_KEY =
  /pass(?:word|wd|phrase)|secret|token|authori[sz]ation|cookie|api[-_]?key|credential|signature|private[-_]?key|^session(?:[-_]?id)?$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

const VALUE_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[REDACTED_JWT]"],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [
    /([?&;](?:X-Amz-(?:Signature|Credential|Security-Token)|Signature|AWSAccessKeyId|sig|code|state|(?:access_|id_|refresh_)?token|password|client_secret)=)[^&\s"'<>]+/gi,
    "$1[REDACTED]",
  ],
  [
    /\b(password|passwd|secret|token|api[-_]?key)(\s*[=:]\s*)[^\s,;&"'}]+/gi,
    "$1$2[REDACTED]",
  ],
  [/([\w.+-])[\w.+-]*@([\w-]+(?:\.[\w-]+)+)/g, "$1***@$2"],
];

/** Remove segredos reconhecíveis de um texto livre e limita o tamanho. */
export function scrubText(value: string): string {
  let text =
    value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncado, ${value.length - MAX_STRING_LENGTH} caracteres]`
      : value;
  for (const [pattern, replacement] of VALUE_PATTERNS)
    text = text.replace(pattern, replacement);
  return text;
}

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly aws_request_id?: string;
  readonly cause?: string;
  readonly stack?: string;
}

interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly status?: unknown;
  readonly stack?: unknown;
  readonly cause?: unknown;
  readonly $metadata?: {
    readonly requestId?: unknown;
    readonly httpStatusCode?: unknown;
  };
}

/**
 * Converte um erro qualquer em campos de log seguros. A pilha vai em campo
 * próprio (nunca concatenada à mensagem) e só quando pedida.
 */
export function serializeError(
  error: unknown,
  options: { readonly includeStack?: boolean } = {},
): SerializedError {
  if (error === null || typeof error !== "object") {
    return { type: "NonError", message: scrubText(String(error)) };
  }
  const source = error as ErrorLike;
  const awsRequestId = source.$metadata?.requestId;
  const status =
    typeof source.status === "number"
      ? source.status
      : typeof source.$metadata?.httpStatusCode === "number"
        ? source.$metadata.httpStatusCode
        : undefined;
  const cause = source.cause;
  const stack =
    options.includeStack && typeof source.stack === "string"
      ? scrubText(source.stack.split("\n").slice(0, MAX_STACK_LINES).join("\n"))
      : undefined;
  return {
    type: typeof source.name === "string" ? source.name : "Error",
    message: scrubText(
      typeof source.message === "string" ? source.message : String(error),
    ),
    ...(typeof source.code === "string" ? { code: source.code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(typeof awsRequestId === "string"
      ? { aws_request_id: awsRequestId }
      : {}),
    ...(cause instanceof Error
      ? { cause: scrubText(`${cause.name}: ${cause.message}`) }
      : {}),
    ...(stack ? { stack } : {}),
  };
}

/**
 * Copia profunda e segura de um valor para serialização: aplica as duas
 * camadas de redação, quebra ciclos e limita profundidade, tamanho de listas
 * e de objetos para que um campo mal escolhido não vire uma linha gigante.
 */
export function sanitizeValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean" || value === null || value === undefined)
    return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return undefined;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  seen.add(value);
  if (Array.isArray(value))
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1, seen));
  const result: Record<string, unknown> = {};
  let kept = 0;
  for (const [key, child] of Object.entries(value)) {
    if (kept >= MAX_OBJECT_KEYS) {
      result["_truncated"] = true;
      break;
    }
    result[key] = isSensitiveKey(key)
      ? REDACTED
      : sanitizeValue(child, depth + 1, seen);
    kept += 1;
  }
  return result;
}

/** Aplica a sanitização ao mapa de campos de uma linha de log. */
export function sanitizeFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return sanitizeValue(fields) as Record<string, unknown>;
}
