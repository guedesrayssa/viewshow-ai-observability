/**
 * @file api.js
 * Camada de acesso à API de analytics de telemetria.
 *
 * Concentra todas as chamadas HTTP da aplicação. Nenhum outro arquivo deve
 * chamar `fetch` diretamente — assim, uma mudança de contrato da API afeta
 * apenas este módulo.
 *
 * Os formatos documentados aqui refletem a implementação real dos services
 * do backend, e não um contrato hipotético. Duas convenções valem para todos
 * os endpoints de analytics:
 *
 * - a resposta traz sempre um objeto `window` com `start`, `end` e
 *   `duration_seconds`, e o conteúdo útil vem em uma chave própria;
 * - métricas sem base de cálculo vêm como `null`, e não como zero — a
 *   interface distingue "nenhuma amostra" de "valor zero".
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
 * Acrescenta automaticamente o parâmetro `window` configurado em
 * `config.js`. Sem ele a API assume 15 minutos, janela curta demais para a
 * demonstração.
 *
 * Mede o tempo total da chamada, usado pelo rodapé para exibir a latência.
 *
 * @param {string} path - Caminho do endpoint, iniciando com barra.
 *   Exemplo: `"/v1/analytics/errors/top"`.
 * @param {Object<string, string|number>} [params] - Parâmetros de consulta
 *   adicionais, como `limit`.
 * @returns {Promise<{data: Object, elapsedMs: number}>} Corpo da resposta e
 *   tempo decorrido em milissegundos.
 * @throws {ApiError} Se a resposta não for 2xx, se o corpo não for JSON válido
 *   ou se a requisição falhar por rede, CORS ou timeout. Quando a API devolve
 *   o envelope `{error: {code, message}}`, a mensagem exibida é a da API.
 *
 * @example
 * const { data, elapsedMs } = await apiGet("/v1/analytics/errors/top", { limit: 5 });
 */
async function apiGet(path, params = {}) {
  const query = new URLSearchParams({ window: ANALYTICS_WINDOW, ...params });
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let response;
  try {
    response = await fetch(`${API_BASE_URL}${path}?${query}`, {
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

  let data;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) throw new ApiError(`A API respondeu com status ${response.status}.`, response.status);
    throw new ApiError("A resposta da API não é um JSON válido.", response.status);
  }

  if (!response.ok) {
    const message = data?.error?.message || `A API respondeu com status ${response.status}.`;
    throw new ApiError(message, response.status);
  }

  return { data, elapsedMs: Math.round(performance.now() - startedAt) };
}

/**
 * Busca o resumo de erros da janela.
 *
 * @returns {Promise<{data: {window: Object, summary: {total_errors: number,
 *   fatal_errors: number, unique_error_codes: number, affected_sessions: number,
 *   total_sessions: number, error_rate: number|null,
 *   crash_free_rate: number|null}}, elapsedMs: number}>} Resumo da janela.
 *   `error_rate` é a razão entre erros e eventos de reprodução;
 *   `crash_free_rate` é a fração de sessões sem nenhuma falha fatal. Ambos
 *   vêm como `null` quando não houve base de cálculo.
 * @throws {ApiError} Quando a chamada falha.
 */
function getErrorsSummary() {
  return apiGet("/v1/analytics/errors/summary");
}

/**
 * Busca o ranking dos códigos de erro mais frequentes, ordenado por número de
 * ocorrências em ordem decrescente.
 *
 * @param {number} [limit=10] - Quantidade máxima de códigos retornados.
 * @returns {Promise<{data: {window: Object, total_errors: number,
 *   errors: Array<{error_code: string, occurrences: number, share: number|null,
 *   affected_sessions: number, fatal_occurrences: number, top_module: string,
 *   first_seen: string, last_seen: string}>}, elapsedMs: number}>} Ranking.
 * @throws {ApiError} Quando a chamada falha.
 */
function getTopErrors(limit = 10) {
  return apiGet("/v1/analytics/errors/top", { limit });
}

/**
 * Busca o detalhamento de um código de erro: impacto, segmentações,
 * linha do tempo e amostras de mensagem.
 *
 * @param {string} errorCode - Código do erro, conforme aparece no ranking.
 *   Exemplo: `"DNS_RESOLVE_FAIL"`.
 * @returns {Promise<{data: {error_code: string, occurrences: number,
 *   share_of_errors: number|null, affected_sessions: number,
 *   fatal_occurrences: number, first_seen: string, last_seen: string,
 *   breakdown: Object<string, Array<Object>>,
 *   timeline: Array<{start: string, occurrences: number}>,
 *   sample_messages: Array<string>, sample_traces: Array<string>}},
 *   elapsedMs: number}>} Detalhes do erro.
 * @throws {ApiError} Quando a chamada falha. Um código sem ocorrências na
 *   janela consultada devolve **404**, e não uma lista vazia.
 */
function getErrorDetails(errorCode) {
  return apiGet(`/v1/analytics/errors/${encodeURIComponent(errorCode)}/details`);
}

/**
 * Busca os indicadores de qualidade de experiência (QoE) da janela.
 *
 * @returns {Promise<{data: {window: Object, metrics: {events: number,
 *   sessions: number, playback_hours: number,
 *   startup_time_ms: {samples: number, p50: number|null, p95: number|null,
 *   average: number|null}, rebuffer: {rate: number|null, count: number},
 *   average_bitrate_kbps: number|null}}, elapsedMs: number}>} Métricas de QoE.
 *   O tempo de início do vídeo (VST) vem em percentis, não em valor único.
 * @throws {ApiError} Quando a chamada falha.
 */
function getQoeMetrics() {
  return apiGet("/v1/analytics/qoe/metrics");
}

/**
 * Busca a evolução das métricas de QoE ao longo da janela.
 *
 * Cada ponto carrega o mesmo bloco `metrics` devolvido por
 * {@link getQoeMetrics}, agregado apenas sobre o seu intervalo.
 *
 * @returns {Promise<{data: {window: Object, interval_seconds: number,
 *   points: Array<{start: string, end: string, metrics: Object}>},
 *   elapsedMs: number}>} Série temporal.
 * @throws {ApiError} Quando a chamada falha.
 */
function getQoeTimeseries() {
  return apiGet("/v1/analytics/qoe/timeseries");
}
