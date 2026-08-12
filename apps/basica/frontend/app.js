/**
 * @file app.js
 * Renderização da página e orquestração das chamadas à API.
 *
 * Carrega os cinco endpoints de analytics em paralelo e desenha cada seção de
 * forma independente: uma seção que falha exibe seu próprio estado de erro
 * sem derrubar o restante da página.
 *
 * Depende de `config.js` e `api.js`, carregados antes deste arquivo.
 */

/* ========================== Formatação de valores ========================== */

/**
 * Formata um número inteiro no padrão brasileiro, com separador de milhar.
 *
 * @param {number} value - Valor a formatar.
 * @returns {string} Número formatado, ou `"—"` se o valor não for numérico.
 *
 * @example
 * formatInteger(48213); // "48.213"
 */
function formatInteger(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toLocaleString("pt-BR");
}

/**
 * Converte uma proporção de 0 a 1 em percentual legível.
 *
 * @param {number} value - Proporção entre 0 e 1.
 * @param {number} [decimals=2] - Casas decimais exibidas.
 * @returns {string} Percentual formatado, ou `"—"` se o valor não for numérico.
 *
 * @example
 * formatRateAsPercent(0.0142); // "1,42%"
 */
function formatRateAsPercent(value, decimals = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${(value * 100).toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

/**
 * Escapa caracteres especiais de HTML para impedir que conteúdo vindo da API
 * seja interpretado como marcação ao ser inserido na página.
 *
 * @param {*} value - Valor de qualquer tipo; será convertido em texto.
 * @returns {string} Texto seguro para interpolação em HTML.
 */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escolhe uma cor da rampa de severidade conforme a posição do erro no
 * ranking. É uma decisão puramente visual: a API ainda não classifica
 * severidade, então a cor comunica apenas a ordem relativa de impacto.
 *
 * @param {number} position - Índice do erro no ranking, começando em zero.
 * @returns {string} Variável CSS da cor correspondente.
 */
function severityColorByRank(position) {
  const ramp = ["--sev-1", "--sev-2", "--sev-3", "--sev-4", "--sev-5"];
  return `var(${ramp[Math.min(position, ramp.length - 1)]})`;
}

/* ============================ Blocos de interface ============================ */

/**
 * Monta o HTML de um cartão de indicador.
 *
 * @param {Object} card - Descrição do cartão.
 * @param {string} card.label - Rótulo exibido acima do valor.
 * @param {string} card.value - Valor já formatado.
 * @param {string} [card.unit] - Unidade exibida ao lado do valor.
 * @param {string} [card.note] - Observação exibida abaixo do valor.
 * @returns {string} Marcação HTML do cartão.
 */
function cardTemplate({ label, value, unit, note }) {
  return `
    <div class="card">
      <div class="card__label">${escapeHtml(label)}</div>
      <div class="card__value">${escapeHtml(value)}${
        unit ? `<span class="card__unit">${escapeHtml(unit)}</span>` : ""
      }</div>
      ${note ? `<div class="card__note">${escapeHtml(note)}</div>` : ""}
    </div>`;
}

/**
 * Substitui o conteúdo de um elemento por uma mensagem de estado.
 *
 * @param {HTMLElement} container - Elemento que receberá a mensagem.
 * @param {string} message - Texto exibido.
 * @param {"info"|"error"} [kind="info"] - Estilo da mensagem.
 * @returns {void}
 */
function renderState(container, message, kind = "info") {
  container.innerHTML = `<p class="state ${
    kind === "error" ? "state--error" : ""
  }">${escapeHtml(message)}</p>`;
}

/**
 * Preenche um elemento com blocos de carregamento (skeleton).
 *
 * @param {HTMLElement} container - Elemento que receberá os blocos.
 * @param {number} count - Quantidade de blocos.
 * @param {"card"|"row"} [variant="card"] - Formato do bloco.
 * @returns {void}
 */
function renderSkeleton(container, count, variant = "card") {
  container.innerHTML = Array.from(
    { length: count },
    () => `<div class="skeleton skeleton--${variant}"></div>`,
  ).join("");
}

/* ============================== Seções da página ============================== */

/**
 * Desenha a seção de visão geral: a manchete de saúde e os cartões de resumo.
 *
 * A manchete reproduz o comportamento previsto no design — mensagem tranquila
 * quando a taxa de sessões sem falha está acima do limite, e mensagem de
 * atenção caso contrário.
 *
 * @param {{total_errors: number, error_rate: number, crash_free_rate: number}} summary
 *   Resumo devolvido por `GET /v1/analytics/errors/summary`.
 * @returns {void}
 */
function renderSummary(summary) {
  const headline = document.getElementById("headline-text");
  const caption = document.getElementById("headline-caption");
  const healthy = summary.crash_free_rate >= 0.99;

  headline.textContent = healthy ? "Tudo bem por aqui!" : "Atenção necessária";
  caption.textContent = healthy
    ? "Nenhuma degradação relevante detectada no período."
    : `${formatRateAsPercent(1 - summary.crash_free_rate)} das sessões registraram falha.`;

  document.getElementById("summary-cards").innerHTML = [
    cardTemplate({
      label: "Erros no período",
      value: formatInteger(summary.total_errors),
    }),
    cardTemplate({
      label: "Taxa de erro",
      value: formatRateAsPercent(summary.error_rate),
      note: "Erros sobre sessões ativas",
    }),
    cardTemplate({
      label: "Sessões sem falha",
      value: formatRateAsPercent(summary.crash_free_rate),
      note: "Crash-free rate",
    }),
  ].join("");
}

/**
 * Desenha os cartões de qualidade de experiência.
 *
 * @param {{vst_ms: number, rebuffer_rate: number, average_bitrate_kbps: number}} metrics
 *   Indicadores devolvidos por `GET /v1/analytics/qoe/metrics`.
 * @returns {void}
 */
function renderQoeMetrics(metrics) {
  document.getElementById("qoe-cards").innerHTML = [
    cardTemplate({
      label: "Tempo de início do vídeo",
      value: formatInteger(metrics.vst_ms),
      unit: "ms",
      note: "VST — do play até o primeiro quadro",
    }),
    cardTemplate({
      label: "Taxa de rebuffer",
      value: formatRateAsPercent(metrics.rebuffer_rate),
      note: "Proporção da sessão em travamento",
    }),
    cardTemplate({
      label: "Bitrate médio",
      value: formatInteger(metrics.average_bitrate_kbps),
      unit: "kbps",
      note: "Qualidade média entregue",
    }),
  ].join("");
}

/**
 * Desenha a série temporal de qualidade como um gráfico de barras simples.
 *
 * O formato de cada ponto ainda não foi definido pela API, que hoje devolve a
 * lista vazia. Para não travar a interface, a função procura a primeira
 * propriedade numérica de cada ponto e a utiliza como altura da barra.
 *
 * @param {Array<Object>} points - Pontos devolvidos por
 *   `GET /v1/analytics/qoe/timeseries`.
 * @returns {void}
 */
function renderQoeTimeseries(points) {
  const container = document.getElementById("qoe-timeseries");

  if (!Array.isArray(points) || points.length === 0) {
    renderState(container, "Ainda não há pontos suficientes para desenhar a série.");
    return;
  }

  const values = points.map((point) => {
    const numeric = Object.values(point).find((value) => typeof value === "number");
    return typeof numeric === "number" ? numeric : 0;
  });

  const max = Math.max(...values, 1);
  container.innerHTML = `<div class="spark">${values
    .map(
      (value) =>
        `<div class="spark__bar" style="height:${Math.max((value / max) * 100, 2)}%"></div>`,
    )
    .join("")}</div>`;
}

/**
 * Desenha o ranking de erros como uma lista de botões selecionáveis.
 *
 * @param {Array<{error_code: string, occurrences: number}>} errors - Ranking
 *   devolvido por `GET /v1/analytics/errors/top`.
 * @param {function(string): void} onSelect - Função chamada com o código do
 *   erro quando uma linha é acionada.
 * @returns {void}
 */
function renderErrorsList(errors, onSelect) {
  const container = document.getElementById("errors-list");

  if (!Array.isArray(errors) || errors.length === 0) {
    renderState(container, "Nenhum erro registrado no período.");
    return;
  }

  container.innerHTML = errors
    .map(
      (error, index) => `
        <button class="error-row" type="button" data-code="${escapeHtml(error.error_code)}">
          <span class="error-row__dot" style="background:${severityColorByRank(index)}"></span>
          <span class="error-row__code">${escapeHtml(error.error_code)}</span>
          <span class="error-row__count">${formatInteger(
            error.occurrences,
          )}<small>ocorrências</small></span>
        </button>`,
    )
    .join("");

  container.querySelectorAll(".error-row").forEach((row) => {
    row.addEventListener("click", () => {
      container
        .querySelectorAll(".error-row")
        .forEach((other) => other.classList.remove("error-row--active"));
      row.classList.add("error-row--active");
      onSelect(row.dataset.code);
    });
  });
}

/**
 * Desenha o painel de detalhe de um erro.
 *
 * As ocorrências chegam da API exatamente como foram enviadas pelos
 * dispositivos, sem formato fixo. Por isso a função renderiza dinamicamente
 * todas as chaves presentes em cada ocorrência, em vez de assumir campos.
 *
 * @param {{error_code: string, occurrences: number, errors: Array<Object>}} details
 *   Detalhes devolvidos por `GET /v1/analytics/errors/{error_code}/details`.
 * @returns {void}
 */
function renderErrorDetails(details) {
  const container = document.getElementById("error-details");
  const samples = Array.isArray(details.errors) ? details.errors.slice(0, 5) : [];

  const header = `
    <p class="detail__code">${escapeHtml(details.error_code)}</p>
    <p class="detail__meta">${formatInteger(details.occurrences)} ocorrência(s) registrada(s)</p>`;

  if (samples.length === 0) {
    container.innerHTML = `${header}<p class="state">Sem ocorrências detalhadas.</p>`;
    return;
  }

  const occurrences = samples
    .map((sample, index) => {
      const rows = Object.entries(sample)
        .map(
          ([key, value]) => `
            <span class="kv__key">${escapeHtml(key)}</span>
            <span class="kv__value">${escapeHtml(
              typeof value === "object" && value !== null ? JSON.stringify(value) : value,
            )}</span>`,
        )
        .join("");

      return `
        <div class="occurrence">
          <div class="occurrence__index">Ocorrência ${index + 1}</div>
          <div class="kv">${rows}</div>
        </div>`;
    })
    .join("");

  const omitted = details.errors.length - samples.length;
  const footer = omitted > 0 ? `<p class="state">e mais ${formatInteger(omitted)}…</p>` : "";

  container.innerHTML = header + occurrences + footer;
}

/* ================================ Orquestração ================================ */

/**
 * Atualiza o indicador de conexão exibido no cabeçalho.
 *
 * @param {"loading"|"ok"|"error"} status - Estado da última carga.
 * @param {string} [label] - Texto exibido; usa um padrão por estado se omitido.
 * @returns {void}
 */
function setApiStatus(status, label) {
  const pill = document.getElementById("api-status");
  const defaults = { loading: "Conectando…", ok: "API conectada", error: "API indisponível" };
  pill.className = `pill pill--${status}`;
  pill.textContent = label || defaults[status];
}

/**
 * Carrega os cinco endpoints em paralelo e redesenha a página.
 *
 * Usa `Promise.allSettled` para que a falha de um endpoint não impeça a
 * renderização dos demais. O banner global só aparece quando nenhuma das
 * chamadas obtém resposta — cenário típico de API fora do ar ou CORS ausente.
 *
 * @returns {Promise<void>} Resolve quando todas as seções foram renderizadas.
 */
async function loadDashboard() {
  const button = document.getElementById("refresh");
  const banner = document.getElementById("global-error");

  button.disabled = true;
  setApiStatus("loading");
  banner.hidden = true;

  renderSkeleton(document.getElementById("summary-cards"), 3);
  renderSkeleton(document.getElementById("qoe-cards"), 3);
  renderSkeleton(document.getElementById("errors-list"), 4, "row");
  renderState(document.getElementById("error-details"), "Selecione um erro na lista.");

  const [summary, qoe, timeseries, topErrors] = await Promise.allSettled([
    getErrorsSummary(),
    getQoeMetrics(),
    getQoeTimeseries(),
    getTopErrors(),
  ]);

  const results = [summary, qoe, timeseries, topErrors];
  const failures = results.filter((result) => result.status === "rejected");
  const allFailed = failures.length === results.length;

  /**
   * Escolhe a mensagem de erro de uma seção.
   *
   * Quando todas as chamadas falham, a causa já está explicada no banner do
   * topo: repetir o mesmo texto em cada seção só polui a tela.
   *
   * @param {PromiseRejectedResult} result - Resultado rejeitado da chamada.
   * @returns {string} Mensagem a exibir na seção.
   */
  const sectionMessage = (result) =>
    allFailed ? "Indisponível" : result.reason.message;

  const latencies = [];

  if (summary.status === "fulfilled") {
    renderSummary(summary.value.data);
    latencies.push(`resumo ${summary.value.elapsedMs}ms`);
  } else {
    document.getElementById("headline-text").textContent = "Dados indisponíveis";
    document.getElementById("headline-caption").textContent = allFailed
      ? ""
      : summary.reason.message;
    renderState(document.getElementById("summary-cards"), sectionMessage(summary), "error");
  }

  if (qoe.status === "fulfilled") {
    renderQoeMetrics(qoe.value.data);
    latencies.push(`qoe ${qoe.value.elapsedMs}ms`);
  } else {
    renderState(document.getElementById("qoe-cards"), sectionMessage(qoe), "error");
  }

  if (timeseries.status === "fulfilled") {
    renderQoeTimeseries(timeseries.value.data.points);
    latencies.push(`série ${timeseries.value.elapsedMs}ms`);
  } else {
    renderState(document.getElementById("qoe-timeseries"), sectionMessage(timeseries), "error");
  }

  if (topErrors.status === "fulfilled") {
    renderErrorsList(topErrors.value.data.errors, selectError);
    latencies.push(`ranking ${topErrors.value.elapsedMs}ms`);
  } else {
    renderState(document.getElementById("errors-list"), sectionMessage(topErrors), "error");
  }

  if (allFailed) {
    setApiStatus("error");
    banner.hidden = false;
    document.getElementById("global-error-message").textContent = failures[0].reason.message;
  } else if (failures.length > 0) {
    setApiStatus("error", `${results.length - failures.length}/${results.length} endpoints`);
  } else {
    setApiStatus("ok");
  }

  document.getElementById("last-update").textContent =
    `Última atualização: ${new Date().toLocaleTimeString("pt-BR")}`;
  document.getElementById("endpoint-latency").textContent = latencies.join(" · ");

  button.disabled = false;
}

/**
 * Carrega e exibe o detalhamento de um código de erro selecionado na lista.
 *
 * @param {string} errorCode - Código do erro selecionado.
 * @returns {Promise<void>} Resolve quando o painel foi atualizado.
 */
async function selectError(errorCode) {
  const container = document.getElementById("error-details");
  renderState(container, "Carregando detalhes…");

  try {
    const { data } = await getErrorDetails(errorCode);
    renderErrorDetails(data);
  } catch (error) {
    renderState(container, error.message, "error");
  }
}

/**
 * Inicializa a página: liga o botão de atualizar, agenda a atualização
 * automática e dispara a primeira carga.
 *
 * @returns {void}
 */
function init() {
  document.getElementById("refresh").addEventListener("click", loadDashboard);

  if (REFRESH_INTERVAL_MS > 0) {
    setInterval(loadDashboard, REFRESH_INTERVAL_MS);
  }

  loadDashboard();
}

document.addEventListener("DOMContentLoaded", init);
