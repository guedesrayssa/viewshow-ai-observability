/**
 * @file client.ts
 * Ponte entre as telas e a API de telemetria.
 *
 * Toda leitura de dado do painel passa por aqui. A tela não conhece `fetch`,
 * não conhece a URL da API e não conhece o formato bruto da resposta: ela pede
 * um recurso e recebe o dado já no tipo que usa para desenhar.
 *
 * Enquanto a API não está configurada (`NEXT_PUBLIC_API_BASE_URL` vazia) ou não
 * responde, o recurso cai no conjunto de exemplo declarado pela própria tela e
 * devolve `source: "exemplo"`. A interface mostra esse estado em texto — o
 * número na tela nunca se apresenta como medição real quando não é. Ligar o
 * backend depois é preencher a variável de ambiente e escrever o `map` da
 * resposta; nenhum componente muda.
 *
 * @see `lib/data/endpoints.ts` para os caminhos publicados pela API.
 */

/** Endereço da API de telemetria. Vazio significa "ainda não integrada". */
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

/** Tempo máximo de espera por resposta, em milissegundos. */
const REQUEST_TIMEOUT = 8000;

/** Origem do dado que está na tela. */
export type DataSource = "api" | "exemplo";

/** Dado entregue a uma tela, com a procedência declarada. */
export type Resource<T> = {
  data: T;
  source: DataSource;
  /** Momento da leitura, para o rótulo "atualizado há...". */
  fetchedAt: Date;
  /** Motivo da queda para o conjunto de exemplo, quando houve uma. */
  fallbackReason?: string;
};

/** Falha de comunicação com a API. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Informa se existe uma API configurada para este ambiente. */
export function isApiConfigured(): boolean {
  return API_BASE_URL.trim() !== "";
}

/** Parâmetros de consulta aceitos pelos endpoints analíticos. */
export type QueryParams = Record<string, string | number | undefined>;

function buildUrl(path: string, params?: QueryParams): string {
  const url = new URL(path, API_BASE_URL);

  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/**
 * Faz uma leitura na API e devolve o corpo já convertido.
 *
 * @param path - Caminho do endpoint, como `/v1/analytics/realtime/overview`.
 * @param params - Parâmetros de consulta.
 * @returns O corpo da resposta.
 * @throws {ApiError} Quando a API não está configurada, demora demais ou
 * responde fora da faixa 2xx.
 *
 * @example
 * const overview = await apiGet<RealtimeOverview>(ENDPOINTS.realtimeOverview);
 */
export async function apiGet<T>(path: string, params?: QueryParams): Promise<T> {
  if (!isApiConfigured()) {
    throw new ApiError("API de telemetria não configurada neste ambiente.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(buildUrl(path, params), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
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

export type LoadOptions<TResponse, TData> = {
  /** Caminho do endpoint que servirá este recurso quando a API existir. */
  path: string;
  params?: QueryParams;
  /** Converte a resposta da API no formato que a tela desenha. */
  map: (response: TResponse) => TData;
  /** Conjunto de exemplo usado enquanto a API não responde. */
  fallback: () => TData;
};

/**
 * Carrega um recurso do painel, com queda para o conjunto de exemplo.
 *
 * @example
 * loadResource({
 *   path: ENDPOINTS.errorsSummary,
 *   params: { window: "30m" },
 *   map: (response: ErrorsSummary) => toStats(response),
 *   fallback: () => exampleStats(),
 * });
 */
export async function loadResource<TResponse, TData>({
  path,
  params,
  map,
  fallback,
}: LoadOptions<TResponse, TData>): Promise<Resource<TData>> {
  if (!isApiConfigured()) {
    return {
      data: fallback(),
      source: "exemplo",
      fetchedAt: new Date(),
      fallbackReason: "API de telemetria não configurada neste ambiente.",
    };
  }

  try {
    const response = await apiGet<TResponse>(path, params);
    return { data: map(response), source: "api", fetchedAt: new Date() };
  } catch (error) {
    return {
      data: fallback(),
      source: "exemplo",
      fetchedAt: new Date(),
      fallbackReason:
        error instanceof Error ? error.message : "Falha ao falar com a API.",
    };
  }
}

/**
 * Oscila um valor de exemplo de forma previsível.
 *
 * Serve para que uma atualização do painel sem API ainda mostre movimento nos
 * números e nas séries, em vez de repetir o mesmo quadro. A variação é
 * determinística: a mesma leitura devolve sempre o mesmo valor, e nada aqui
 * chega perto do que a tela apresenta como dado medido — o selo "dados de
 * exemplo" continua visível o tempo todo.
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
