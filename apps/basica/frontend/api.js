/**
 * @file api.js
 * Camada de acesso à API de analytics de telemetria.
 *
 * Concentra todas as chamadas HTTP da aplicação. Nenhum outro arquivo deve
 * chamar `fetch` diretamente — assim, uma mudança de contrato da API afeta
 * apenas este módulo.
 *
 * Os formatos de resposta documentados aqui refletem o que a API realmente
 * devolve hoje (branch `feat/endpoints-controllers`), e não um contrato
 * hipotético.
 *
 * Depende de `config.js`, que deve ser carregado antes deste arquivo.
 */

/**
 * Erro lançado quando a API responde com status fora da faixa 2xx
 * ou quando a requisição não pôde ser concluída.
 *
 * @extends Error
 */
class ApiError extends Error {
  /**
   * @param {string} message - Mensagem legível para exibição na interface.
   * @param {number|null} status - Status HTTP recebido, ou `null` se a
   *   requisição sequer chegou ao servidor (rede indisponível, CORS, DNS).
   */
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Executa uma requisição GET na API e devolve o corpo já convertido em objeto.
 *
 * Mede o tempo total da chamada, que é usado pela interface para exibir a
 * latência de cada endpoint.
 *
 * @param {string} path - Caminho do endpoint, iniciando com barra.
 *   Exemplo: `"/v1/analytics/errors/top"`.
 * @returns {Promise<{data: Object, elapsedMs: number}>} Corpo da resposta e
 *   tempo decorrido em milissegundos.
 * @throws {ApiError} Se a resposta não for 2xx, se o corpo não for JSON válido
 *   ou se a requisição falhar por rede, CORS ou timeout.
 *
 * @example
 * const { data, elapsedMs } = await apiGet("/v1/analytics/errors/summary");
 * console.log(data.total_errors, elapsedMs);
 */
async function apiGet(path) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (cause) {
    throw new ApiError(
      cause.name === "AbortError"
        ? "A API demorou mais de 10s para responder."
        : "Não foi possível conectar à API. Verifique se ela está no ar e se o CORS está liberado.",
      null,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ApiError(`A API respondeu com status ${response.status}.`, response.status);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError("A resposta da API não é um JSON válido.", response.status);
  }

  return { data, elapsedMs: Math.round(performance.now() - startedAt) };
}

/**
 * Busca o resumo de erros do período.
 *
 * @returns {Promise<{data: {total_errors: number, error_rate: number,
 *   crash_free_rate: number}, elapsedMs: number}>} Total de erros, taxa de
 *   erro e proporção de sessões sem falha (0 a 1).
 * @throws {ApiError} Quando a chamada falha.
 */
function getErrorsSummary() {
  return apiGet("/v1/analytics/errors/summary");
}

/**
 * Busca o ranking de erros mais frequentes, já ordenado da API por número
 * de ocorrências em ordem decrescente.
 *
 * @returns {Promise<{data: {errors: Array<{error_code: string,
 *   occurrences: number}>}, elapsedMs: number}>} Lista de erros do ranking.
 * @throws {ApiError} Quando a chamada falha.
 */
function getTopErrors() {
  return apiGet("/v1/analytics/errors/top");
}

/**
 * Busca o detalhamento de um código de erro específico, incluindo todas as
 * ocorrências registradas como foram recebidas pela API de ingestão.
 *
 * Os objetos dentro de `errors` não têm formato fixo: são os payloads brutos
 * enviados pelos dispositivos. A interface renderiza dinamicamente as chaves
 * que vierem.
 *
 * @param {string} errorCode - Código do erro, conforme aparece no ranking.
 *   Exemplo: `"DNS_RESOLVE_FAIL"`.
 * @returns {Promise<{data: {error_code: string, occurrences: number,
 *   errors: Array<Object>}, elapsedMs: number}>} Detalhes do erro.
 * @throws {ApiError} Quando a chamada falha.
 */
function getErrorDetails(errorCode) {
  return apiGet(`/v1/analytics/errors/${encodeURIComponent(errorCode)}/details`);
}

/**
 * Busca os indicadores de qualidade de experiência (QoE).
 *
 * @returns {Promise<{data: {vst_ms: number, rebuffer_rate: number,
 *   average_bitrate_kbps: number}, elapsedMs: number}>} Tempo de início de
 *   vídeo, taxa de rebuffer e bitrate médio.
 * @throws {ApiError} Quando a chamada falha.
 */
function getQoeMetrics() {
  return apiGet("/v1/analytics/qoe/metrics");
}

/**
 * Busca a evolução temporal das métricas de qualidade.
 *
 * A API ainda devolve `points` vazio: o cálculo a partir dos eventos
 * armazenados está pendente no backend. A interface trata a lista vazia como
 * estado legítimo, e não como erro.
 *
 * @returns {Promise<{data: {points: Array<Object>}, elapsedMs: number}>}
 *   Pontos da série temporal.
 * @throws {ApiError} Quando a chamada falha.
 */
function getQoeTimeseries() {
  return apiGet("/v1/analytics/qoe/timeseries");
}
