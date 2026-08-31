/**
 * @file client.ts
 * Ponte entre as telas e as APIs deste repositório.
 *
 * Toda leitura de dado do painel passa por aqui. A tela não conhece `fetch`,
 * não conhece a URL da API e não conhece o formato bruto da resposta: ela pede
 * um recurso e recebe o dado já no tipo que usa para desenhar.
 *
 * São duas APIs, com domínios que não se cruzam, e por isso duas bases de URL:
 *
 * - `operacional` — Node/Express (`apps/backend/api`): incidentes, evidências,
 *   hipótese e a revisão humana. É a única que tem sessão, e por isso a única
 *   que envia o cookie.
 * - `telemetria` — Flask (`apps/basica/backend`): medição bruta — QoE, erros,
 *   segmentações e séries no tempo.
 *
 * Cada recurso declara o que a leitura devolveu: `source` diz de onde veio o
 * número, e `availability` diz o quanto do bloco ficou preenchido. Os dois são
 * necessários porque não respondem a mesma pergunta: uma leitura pode vir da
 * API e ainda assim estar parcial, quando parte do que a tela desenha não tem
 * fonte em nenhuma das duas.
 *
 * @see `lib/data/endpoints.ts` para os caminhos publicados por cada API.
 * @see `lib/data/mode.ts` para quando o conjunto de exemplo é permitido.
 */

import { ALLOW_EXAMPLE_DATA } from "@/lib/data/mode";
import { WARNINGS, type Warning } from "@/lib/data/warnings";

/** Qual das duas APIs serve a leitura. */
export type ApiTarget = "operacional" | "telemetria";

/**
 * Endereço de cada API. Vazio significa "ainda não integrada neste ambiente".
 *
 * A leitura é feita membro a membro porque é assim que o Next substitui a
 * variável no pacote do navegador; um acesso dinâmico chegaria como `undefined`
 * no cliente.
 */
const API_BASES: Record<ApiTarget, string> = {
  operacional: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
  telemetria: process.env.NEXT_PUBLIC_TELEMETRY_API_BASE_URL ?? "",
};

/**
 * Base efetiva de uma API, resolvendo o valor especial `"/"`.
 *
 * `"/"` significa "mesma origem do painel": usado quando o painel e as APIs
 * são servidos atrás do mesmo host (ex.: nginx num único provisionamento),
 * caso em que o endereço só é conhecido no navegador, nunca na compilação.
 * `new URL(path, "/")` lançaria `TypeError: Invalid base URL`, por isso a
 * resolução para `window.location.origin` acontece aqui, e não na declaração
 * de `API_BASES`.
 */
function apiBase(target: ApiTarget): string {
  const configurada = API_BASES[target].trim();
  if (configurada === "/") {
    return typeof window === "undefined" ? "http://localhost" : window.location.origin;
  }
  return configurada;
}

/** Tempo máximo de espera por resposta, em milissegundos. */
const REQUEST_TIMEOUT = 8000;

/** Origem do dado que está na tela. */
export type DataSource = "api" | "exemplo" | "indisponivel";

/** O quanto do bloco a leitura conseguiu preencher. */
export type Availability = "measured" | "partial" | "unavailable";

/** Dado entregue a uma tela, com a procedência declarada. */
export type Resource<T> = {
  /** Ausente quando `availability` é `unavailable`. */
  data?: T;
  source: DataSource;
  availability: Availability;
  /** O que da leitura não pôde ser preenchido, e por quê. */
  warnings: Warning[];
  /** Momento da leitura, para o rótulo "atualizado há...". */
  fetchedAt: Date;
  /** Motivo da queda para o conjunto de exemplo, quando houve uma. */
  fallbackReason?: string;
};

/** Falha de comunicação com uma das APIs. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Informa se a API pedida foi apontada por variável de ambiente. */
export function isApiConfigured(target: ApiTarget): boolean {
  return API_BASES[target].trim() !== "";
}

/** Parâmetros de consulta aceitos pelos endpoints. */
export type QueryParams = Record<string, string | number | undefined>;

function buildUrl(target: ApiTarget, path: string, params?: QueryParams): string {
  const url = new URL(path, apiBase(target));

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/**
 * Faz uma leitura em uma das APIs e devolve o corpo já convertido.
 *
 * @param target - Qual API serve esta leitura.
 * @param path - Caminho do endpoint, como `/v1/analytics/realtime/overview`.
 * @param params - Parâmetros de consulta.
 * @returns O corpo da resposta.
 * @throws {ApiError} Quando a API não está configurada, demora demais ou
 * responde fora da faixa 2xx.
 *
 * @example
 * const overview = await apiGet<RealtimeOverviewResponse>(
 *   "telemetria",
 *   ENDPOINTS.telemetria.realtimeOverview,
 * );
 */
export async function apiGet<T>(
  target: ApiTarget,
  path: string,
  params?: QueryParams,
): Promise<T> {
  if (!isApiConfigured(target)) {
    throw new ApiError(`A API ${target} não está configurada neste ambiente.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(buildUrl(target, path, params), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      // A sessão da API operacional é um cookie assinado pelo servidor. Ele
      // precisa acompanhar a leitura para que uma rota protegida devolva o
      // recurso, e não 401.
      credentials: target === "operacional" ? "include" : "same-origin",
      // O painel mostra o estado agora; uma resposta de cache seria um número
      // velho apresentado como recente.
      cache: "no-store",
    });

    if (!response.ok) {
      throw new ApiError(
        `A API respondeu ${response.status} em ${path}.`,
        response.status,
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(`A API não respondeu em ${REQUEST_TIMEOUT / 1000}s.`);
    }
    throw new ApiError(
      error instanceof Error ? error.message : "Falha ao falar com a API.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Parte comum a uma leitura simples e a uma leitura composta. */
type ResourceShape<TData> = {
  /**
   * Conjunto de exemplo. Sem ele — ou fora dos ambientes em que o exemplo é
   * permitido —, a falha vira estado de indisponível, e não número.
   */
  fallback?: () => TData;
  /**
   * Avisos que valem mesmo quando a leitura funciona: o que aquele bloco
   * desenha e a fonte não mede.
   */
  warnings?: Warning[];
};

export type LoadOptions<TResponse, TData> = ResourceShape<TData> & {
  target: ApiTarget;
  /** Caminho do endpoint que serve este recurso. */
  path: string;
  params?: QueryParams;
  /** Converte a resposta da API no formato que a tela desenha. */
  map: (response: TResponse) => TData;
};

export type ComposeOptions<TData> = ResourceShape<TData> & {
  /**
   * As APIs sem as quais a leitura não acontece. Uma fonte secundária, cuja
   * ausência apenas esvazia um bloco, não entra aqui: ela é tratada dentro do
   * `read` e reportada por `warn`.
   */
  targets: ApiTarget[];
  /**
   * Faz as leituras e monta o formato que a tela desenha.
   *
   * Recebe `warn` para declarar o que não conseguiu preencher. É o que
   * diferencia "a leitura falhou" de "a leitura foi, e esta parte não tem
   * fonte" — a segunda continua sendo uma resposta utilizável.
   */
  read: (warn: (warning: Warning) => void) => Promise<TData>;
};

/**
 * Executa uma leitura já montada e classifica o resultado.
 *
 * É a primitiva das duas funções públicas: `loadResource`, para um endpoint, e
 * `composeResource`, para várias leituras que formam um bloco só.
 */
async function resolve<TData>({
  targets,
  read,
  fallback,
  warnings = [],
}: ComposeOptions<TData>): Promise<Resource<TData>> {
  const collected: Warning[] = [...warnings];
  const warn = (warning: Warning) => {
    if (!collected.some((item) => item.code === warning.code)) {
      collected.push(warning);
    }
  };

  const unavailableOr = (reason: Warning): Resource<TData> => {
    if (ALLOW_EXAMPLE_DATA && fallback) {
      return {
        data: fallback(),
        source: "exemplo",
        availability: collected.length > 0 ? "partial" : "measured",
        warnings: [reason, WARNINGS.dadoDeExemplo, ...collected],
        fetchedAt: new Date(),
        fallbackReason: reason.message,
      };
    }

    return {
      source: "indisponivel",
      availability: "unavailable",
      warnings: [reason, ...collected],
      fetchedAt: new Date(),
      fallbackReason: reason.message,
    };
  };

  if (targets.some((target) => !isApiConfigured(target))) {
    return unavailableOr(WARNINGS.apiNaoConfigurada);
  }

  try {
    const data = await read(warn);
    return {
      data,
      source: "api",
      availability: collected.length > 0 ? "partial" : "measured",
      warnings: collected,
      fetchedAt: new Date(),
    };
  } catch (error) {
    return unavailableOr({
      code: WARNINGS.leituraFalhou.code,
      message:
        error instanceof Error ? error.message : WARNINGS.leituraFalhou.message,
    });
  }
}

/**
 * Carrega um recurso servido por um único endpoint.
 *
 * @example
 * loadResource({
 *   target: "telemetria",
 *   path: ENDPOINTS.telemetria.errorsSummary,
 *   params: { window: "30m" },
 *   map: (response: ErrorsSummaryResponse) => toStats(response),
 *   fallback: () => exampleStats(),
 * });
 */
export function loadResource<TResponse, TData>({
  target,
  path,
  params,
  map,
  fallback,
  warnings,
}: LoadOptions<TResponse, TData>): Promise<Resource<TData>> {
  return resolve({
    targets: [target],
    read: async () => map(await apiGet<TResponse>(target, path, params)),
    fallback,
    warnings,
  });
}

/**
 * Carrega um recurso montado a partir de várias leituras.
 *
 * Usado onde um bloco da tela só existe com o que duas ou três rotas dizem
 * juntas — o detalhe de um incidente, por exemplo, que hoje sai de três
 * leituras separadas na API operacional.
 *
 * @example
 * composeResource({
 *   targets: ["operacional"],
 *   read: async () => {
 *     const [incident, evidence] = await Promise.all([...]);
 *     return { incident, evidence };
 *   },
 *   fallback: () => exampleEvidence(),
 * });
 */
export function composeResource<TData>(
  options: ComposeOptions<TData>,
): Promise<Resource<TData>> {
  return resolve(options);
}

/**
 * Oscila um valor de exemplo de forma previsível.
 *
 * Serve para que uma atualização do painel sem API ainda mostre movimento nos
 * números e nas séries, em vez de repetir o mesmo quadro. A variação é
 * determinística: a mesma leitura devolve sempre o mesmo valor, e nada aqui
 * chega perto do que a tela apresenta como dado medido — o selo de exemplo
 * continua visível o tempo todo.
 *
 * @param value - Valor base da fixture.
 * @param seed - Contador de atualizações e posição do ponto na série.
 * @param amplitude - Variação máxima, como fração do valor (0,06 = 6%).
 *
 * @example
 * jitter(342, 3, 0.05); // 349
 */
export function jitter(value: number, seed: number, amplitude = 0.06): number {
  const wave = Math.sin(seed * 12.9898) * 43758.5453;
  const offset = (wave - Math.floor(wave)) * 2 - 1;
  return value * (1 + offset * amplitude);
}
