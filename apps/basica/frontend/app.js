/**
 * @file app.js
 * Renderização da página e orquestração das chamadas à API.
 *
 * Carrega os quatro endpoints de visão geral em paralelo e desenha cada seção
 * de forma independente: uma seção que falha exibe seu próprio estado de erro
 * sem derrubar o restante da página.
 *
 * Depende de `config.js` e `api.js`, carregados antes deste arquivo.
 */

/* ========================== Formatação de valores ========================== */

/**
 * Formata um número no padrão brasileiro, com separador de milhar.
 *
 * @param {number} value - Valor a formatar.
 * @param {number} [decimals=0] - Casas decimais exibidas.
 * @returns {string} Número formatado, ou `"—"` quando não há valor.
 *
 * @example
 * formatNumber(48213); // "48.213"
 */
function formatNumber(value, decimals = 0) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Converte uma proporção de 0 a 1 em percentual legível.
 *
 * A API devolve `null` quando a métrica não teve base de cálculo — caso
 * diferente de zero, e por isso exibido como `"—"`.
 *
 * @param {number|null} value - Proporção entre 0 e 1, ou `null`.
 * @param {number} [decimals=2] - Casas decimais exibidas.
 * @returns {string} Percentual formatado, ou `"—"` quando não há amostra.
 *
 * @example
 * formatPercent(0.0142); // "1,42%"
 */
function formatPercent(value, decimals = 2) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${formatNumber(value * 100, decimals)}%`;
}

/**
 * Formata um instante ISO-8601 como data e hora local abreviada.
 *
 * @param {string} iso - Instante no formato ISO-8601.
 * @returns {string} Data e hora legíveis, ou `"—"` se a entrada for inválida.
 */
function formatDateTime(iso) {
  const moment = new Date(iso);
  if (Number.isNaN(moment.getTime())) return "—";
  return moment.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
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
 * Escolhe a cor do marcador de um erro no ranking.
 *
 * Erros com ocorrências fatais recebem o tom mais crítico da rampa; os demais
 * seguem a posição no ranking, em tons progressivamente mais brandos.
 *
 * @param {{fatal_occurrences: number}} error - Entrada do ranking.
 * @param {number} position - Índice no ranking, começando em zero.
 * @returns {string} Variável CSS da cor correspondente.
 */
function severityColor(error, position) {
  if (error.fatal_occurrences > 0) return "var(--sev-1)";
  const ramp = ["--sev-3", "--sev-4", "--sev-5"];
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
 * A manchete distingue três situações: sem base de cálculo, saudável e
 * degradada. `crash_free_rate` mede apenas falhas **fatais**, então uma taxa
 * alta não significa ausência de erros.
 *
 * @param {{total_errors: number, fatal_errors: number, unique_error_codes: number,
 *   affected_sessions: number, total_sessions: number, error_rate: number|null,
 *   crash_free_rate: number|null}} summary - Bloco `summary` devolvido por
 *   `GET /v1/analytics/errors/summary`.
 * @returns {void}
 */
function renderSummary(summary) {
  const headline = document.getElementById("headline-text");
  const caption = document.getElementById("headline-caption");
  const crashFree = summary.crash_free_rate;

  if (typeof crashFree !== "number") {
    headline.textContent = "Sem dados na janela";
    caption.textContent = "Nenhuma sessão observada no período consultado.";
  } else if (crashFree >= 0.99) {
    headline.textContent = "Tudo bem por aqui!";
    caption.textContent = "Nenhuma sessão relevante afetada por falha fatal.";
  } else {
    headline.textContent = "Atenção necessária";
    caption.textContent = `${formatPercent(1 - crashFree)} das sessões sofreram falha fatal.`;
  }

  document.getElementById("summary-cards").innerHTML = [
    cardTemplate({
      label: "Erros no período",
      value: formatNumber(summary.total_errors),
      note: `${formatNumber(summary.unique_error_codes)} código(s) distinto(s)`,
    }),
    cardTemplate({
      label: "Erros fatais",
      value: formatNumber(summary.fatal_errors),
      note: "Falhas que encerram a sessão",
    }),
    cardTemplate({
      label: "Taxa de erro",
      value: formatPercent(summary.error_rate),
      note: "Erros sobre eventos de reprodução",
    }),
    cardTemplate({
      label: "Sessões sem falha",
      value: formatPercent(summary.crash_free_rate),
      note: `${formatNumber(summary.affected_sessions)} de ${formatNumber(
        summary.total_sessions,
      )} sessões com erro`,
    }),
  ].join("");
}

/**
 * Desenha os cartões de qualidade de experiência.
 *
 * O tempo de início do vídeo chega em percentis. A mediana (p50) representa a
 * experiência típica e o p95 a cauda ruim, que é onde o problema aparece.
 *
 * @param {{events: number, sessions: number, playback_hours: number,
 *   startup_time_ms: {samples: number, p50: number|null, p95: number|null,
 *   average: number|null}, rebuffer: {rate: number|null, count: number},
 *   average_bitrate_kbps: number|null}} metrics - Bloco `metrics` devolvido
 *   por `GET /v1/analytics/qoe/metrics`.
 * @returns {void}
 */
function renderQoeMetrics(metrics) {
  const startup = metrics.startup_time_ms;

  document.getElementById("qoe-cards").innerHTML = [
    cardTemplate({
      label: "Início do vídeo (p50)",
      value: formatNumber(startup.p50),
      unit: "ms",
      note: `p95 em ${formatNumber(startup.p95)} ms · ${formatNumber(
        startup.samples,
      )} amostra(s)`,
    }),
    cardTemplate({
      label: "Taxa de rebuffer",
      value: formatPercent(metrics.rebuffer.rate),
      note: `${formatNumber(metrics.rebuffer.count)} travamento(s)`,
    }),
    cardTemplate({
      label: "Bitrate médio",
      value: formatNumber(metrics.average_bitrate_kbps),
      unit: "kbps",
      note: "Ponderado pelo tempo de reprodução",
    }),
    cardTemplate({
      label: "Volume observado",
      value: formatNumber(metrics.events),
      note: `${formatNumber(metrics.sessions)} sessão(ões) · ${formatNumber(
        metrics.playback_hours,
        1,
      )} h de reprodução`,
    }),
  ].join("");
}

/**
 * Desenha a evolução do tempo de início do vídeo como barras.
 *
 * Cada ponto da série carrega o mesmo bloco de métricas do endpoint de QoE,
 * agregado sobre o seu intervalo. O gráfico usa a mediana do tempo de início,
 * que é a métrica de QoE mais legível em barras.
 *
 * @param {Array<{start: string, end: string, metrics: Object}>} points - Pontos
 *   devolvidos por `GET /v1/analytics/qoe/timeseries`.
 * @param {number} intervalSeconds - Duração de cada intervalo, em segundos.
 * @returns {void}
 */
function renderQoeTimeseries(points, intervalSeconds) {
  const container = document.getElementById("qoe-timeseries");

  if (!Array.isArray(points) || points.length === 0) {
    renderState(container, "Ainda não há pontos suficientes para desenhar a série.");
    return;
  }

  const values = points.map((point) => point.metrics?.startup_time_ms?.p50 ?? null);

  if (values.every((value) => value === null)) {
    renderState(container, "Nenhuma amostra de tempo de início do vídeo na janela.");
    return;
  }

  const max = Math.max(...values.filter((value) => value !== null), 1);
  const bars = values
    .map((value, index) => {
      const height = value === null ? 0 : Math.max((value / max) * 100, 2);
      const label =
        value === null
          ? `${formatDateTime(points[index].start)} — sem amostra`
          : `${formatDateTime(points[index].start)} — ${formatNumber(value)} ms`;
      return `<div class="spark__bar${
        value === null ? " spark__bar--empty" : ""
      }" style="height:${height}%" title="${escapeHtml(label)}"></div>`;
    })
    .join("");

  const minutes = Math.round(intervalSeconds / 60);
  container.innerHTML = `
    <p class="panel__caption">Mediana do tempo de início do vídeo, em intervalos de ${escapeHtml(
      minutes >= 1 ? `${minutes} min` : `${intervalSeconds} s`,
    )}. Pico de ${escapeHtml(formatNumber(max))} ms.</p>
    <div class="spark">${bars}</div>`;
}

/**
 * Desenha o ranking de erros como uma lista de botões selecionáveis.
 *
 * @param {Array<{error_code: string, occurrences: number, share: number|null,
 *   affected_sessions: number, fatal_occurrences: number, top_module: string}>} errors
 *   Lista devolvida por `GET /v1/analytics/errors/top`.
 * @param {function(string): void} onSelect - Função chamada com o código do
 *   erro quando uma linha é acionada.
 * @returns {void}
 */
function renderErrorsList(errors, onSelect) {
  const container = document.getElementById("errors-list");

  if (!Array.isArray(errors) || errors.length === 0) {
    renderState(container, "Nenhum erro registrado na janela consultada.");
    return;
  }

  container.innerHTML = errors
    .map((error, index) => {
      const meta = [
        error.top_module,
        `${formatNumber(error.affected_sessions)} sessão(ões)`,
        error.fatal_occurrences > 0 ? `${formatNumber(error.fatal_occurrences)} fatal(is)` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      return `
        <button class="error-row" type="button" data-code="${escapeHtml(error.error_code)}">
          <span class="error-row__dot" style="background:${severityColor(error, index)}"></span>
          <span class="error-row__main">
            <span class="error-row__code">${escapeHtml(error.error_code)}</span>
            <span class="error-row__meta">${escapeHtml(meta)}</span>
          </span>
          <span class="error-row__count">${formatNumber(
            error.occurrences,
          )}<small>${escapeHtml(formatPercent(error.share, 1))}</small></span>
        </button>`;
    })
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
 * Monta uma lista compacta de uma das segmentações do detalhe do erro.
 *
 * Cada item da segmentação vem com uma chave própria, nomeada conforme a
 * dimensão (`device_model`, `app_version`, `cdn`, `module`, `service`).
 *
 * @param {string} title - Título exibido acima da lista.
 * @param {Array<Object>} entries - Itens da segmentação.
 * @param {string} key - Nome da chave que carrega o valor da dimensão.
 * @returns {string} Marcação HTML, ou string vazia se não houver itens.
 */
function breakdownTemplate(title, entries, key) {
  if (!Array.isArray(entries) || entries.length === 0) return "";

  const rows = entries
    .slice(0, 4)
    .map(
      (entry) => `
        <span class="kv__key">${escapeHtml(entry[key] ?? "—")}</span>
        <span class="kv__value">${escapeHtml(formatNumber(entry.occurrences))} · ${escapeHtml(
          formatPercent(entry.share, 0),
        )}</span>`,
    )
    .join("");

  return `
    <div class="breakdown">
      <div class="breakdown__title">${escapeHtml(title)}</div>
      <div class="kv">${rows}</div>
    </div>`;
}

/**
 * Desenha o painel de detalhe de um erro: impacto, segmentações e amostras
 * de mensagem.
 *
 * @param {{error_code: string, occurrences: number, share_of_errors: number|null,
 *   affected_sessions: number, fatal_occurrences: number, first_seen: string,
 *   last_seen: string, breakdown: Object<string, Array<Object>>,
 *   sample_messages: Array<string>}} details - Resposta de
 *   `GET /v1/analytics/errors/{error_code}/details`.
 * @returns {void}
 */
function renderErrorDetails(details) {
  const container = document.getElementById("error-details");
  const breakdown = details.breakdown || {};

  const impact = [
    `${formatNumber(details.occurrences)} ocorrência(s)`,
    `${formatNumber(details.affected_sessions)} sessão(ões) afetada(s)`,
    `${formatPercent(details.share_of_errors, 1)} dos erros`,
  ].join(" · ");

  const fatal =
    details.fatal_occurrences > 0
      ? `<p class="detail__fatal">${formatNumber(details.fatal_occurrences)} ocorrência(s) fatal(is)</p>`
      : "";

  const messages =
    Array.isArray(details.sample_messages) && details.sample_messages.length > 0
      ? `<div class="breakdown">
           <div class="breakdown__title">Mensagens</div>
           ${details.sample_messages
             .map((message) => `<p class="detail__message">${escapeHtml(message)}</p>`)
             .join("")}
         </div>`
      : "";

  container.innerHTML = `
    <p class="detail__code">${escapeHtml(details.error_code)}</p>
    <p class="detail__meta">${escapeHtml(impact)}</p>
    ${fatal}
    <p class="detail__meta">Entre ${escapeHtml(formatDateTime(details.first_seen))} e ${escapeHtml(
      formatDateTime(details.last_seen),
    )}</p>
    ${breakdownTemplate("Dispositivos", breakdown.devices, "device_model")}
    ${breakdownTemplate("Versões do app", breakdown.app_versions, "app_version")}
    ${breakdownTemplate("Módulos", breakdown.modules, "module")}
    ${breakdownTemplate("CDNs", breakdown.cdns, "cdn")}
    ${messages}`;
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
 * Carrega os endpoints da visão geral em paralelo e redesenha a página.
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

  renderSkeleton(document.getElementById("summary-cards"), 4);
  renderSkeleton(document.getElementById("qoe-cards"), 4);
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
  const sectionMessage = (result) => (allFailed ? "Indisponível" : result.reason.message);

  const latencies = [];

  if (summary.status === "fulfilled") {
    renderSummary(summary.value.data.summary);
    latencies.push(`resumo ${summary.value.elapsedMs}ms`);
  } else {
    document.getElementById("headline-text").textContent = "Dados indisponíveis";
    document.getElementById("headline-caption").textContent = allFailed
      ? ""
      : summary.reason.message;
    renderState(document.getElementById("summary-cards"), sectionMessage(summary), "error");
  }

  if (qoe.status === "fulfilled") {
    renderQoeMetrics(qoe.value.data.metrics);
    latencies.push(`qoe ${qoe.value.elapsedMs}ms`);
  } else {
    renderState(document.getElementById("qoe-cards"), sectionMessage(qoe), "error");
  }

  if (timeseries.status === "fulfilled") {
    renderQoeTimeseries(
      timeseries.value.data.points,
      timeseries.value.data.interval_seconds,
    );
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
    `Janela de ${ANALYTICS_WINDOW} · atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
  document.getElementById("endpoint-latency").textContent = latencies.join(" · ");

  button.disabled = false;
}

/**
 * Carrega e exibe o detalhamento de um código de erro selecionado na lista.
 *
 * A API responde 404 quando o código não tem ocorrências na janela — situação
 * possível se os dados mudarem entre a carga do ranking e o clique. Esse caso
 * recebe uma mensagem própria, em vez do texto genérico de erro.
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
    const message =
      error.status === 404
        ? "Este erro não tem mais ocorrências na janela consultada."
        : error.message;
    renderState(container, message, "error");
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
