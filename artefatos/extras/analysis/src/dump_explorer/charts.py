"""Gráficos Plotly reutilizáveis para os notebooks de exploração."""

import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError

METRIC_DIRECTION = {
    "apdex_score": "lower_is_worse",
    "sessions": "lower_is_worse",
    "error_rate": "higher_is_worse",
    "error_rate_pct": "higher_is_worse",
    "errors": "higher_is_worse",
    "latency": "higher_is_worse",
    "latency_p50": "higher_is_worse",
    "latency_p95": "higher_is_worse",
    "latency_p99": "higher_is_worse",
    "buffering": "higher_is_worse",
    "buffering_rate": "higher_is_worse",
    "rebuffer_rate": "higher_is_worse",
    "rebuffer_duration_ms": "higher_is_worse",
}
MAX_QOS_SMALL_MULTIPLES = 20
MAX_QOE_TRACE_GROUPS = 20
MAX_RCA_TRACE_GROUPS = 20
MAX_EVENT_TRACE_GROUPS = 20
TICKET_OPEN_UNCERTAINTY_MS = 40 * 60 * 1_000


def _assert_frame_cap(frame: pd.DataFrame) -> None:
    if len(frame) > HARD_MAX_ROWS:
        raise ResultLimitError(f"gráfico excede o limite de {HARD_MAX_ROWS} linhas")


def empty_figure(message: str) -> go.Figure:
    """Cria um estado vazio legível sem eixos ou traços."""
    figure = go.Figure()
    figure.add_annotation(
        text=message,
        showarrow=False,
        x=0.5,
        y=0.5,
        xref="paper",
        yref="paper",
    )
    figure.update_xaxes(visible=False)
    figure.update_yaxes(visible=False)
    return figure


def volume_bar(frame: pd.DataFrame) -> go.Figure:
    """Exibe estimativas de volume MySQL agrupadas por tabela."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem dados de volume")
    # Accept either the catalog form (estimated_rows) or a coverage form (rows).
    if "estimated_rows" in frame.columns:
        y = frame["estimated_rows"]
        y_title = "Linhas (estimativa do MySQL)"
        title = "Volume por tabela (estimativa do MySQL)"
    elif "rows" in frame.columns:
        y = frame["rows"]
        y_title = "Linhas"
        title = "Volume por tabela"
    else:
        raise KeyError("expected column 'estimated_rows' or 'rows' not found in frame")

    figure = go.Figure(go.Bar(x=frame["table_name"], y=y, name="volume"))
    figure.update_layout(title=title, xaxis_title="Tabela", yaxis_title=y_title)
    return figure


def coverage_heatmap(frame: pd.DataFrame, *, x: str, y: str, value: str) -> go.Figure:
    """Exibe cobertura agregada por duas dimensões."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem dados de cobertura")

    x_values = frame[x].nunique()
    y_values = frame[y].nunique()
    if x_values * y_values > HARD_MAX_ROWS:
        raise ResultLimitError(f"matriz excede o limite de {HARD_MAX_ROWS} células")
    matrix = frame.pivot_table(index=y, columns=x, values=value, aggfunc="sum")
    figure = go.Figure(
        go.Heatmap(
            x=matrix.columns.tolist(),
            y=matrix.index.tolist(),
            z=matrix.to_numpy(),
            colorbar={"title": value},
            colorscale=[[0, "#0b3d91"], [1, "#76c893"]],
            hoverongaps=False,
        )
    )
    # NaN é ausência de bucket; a cor do fundo não é a cor do valor zero da escala.
    figure.update_layout(plot_bgcolor="#d9d9d9")
    return figure


def missingness_bar(frame: pd.DataFrame) -> go.Figure:
    """Compara percentuais de nulos por coluna sem expor seus valores."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem resumo de nulos")
    figure = go.Figure(go.Bar(x=frame["column_name"], y=frame["null_pct"], name="nulos"))
    figure.update_layout(xaxis_title="Coluna", yaxis_title="Valores nulos (%)")
    return figure


def cadence_histogram(frame: pd.DataFrame) -> go.Figure:
    """Mostra a distribuição de intervalos em segundos entre pontos observados."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem cadência no período selecionado")
    figure = go.Figure(go.Histogram(x=frame["cadence_s"], name="cadência"))
    figure.update_layout(xaxis_title="Cadência entre pontos (s)", yaxis_title="Frequência")
    return figure


def collector_timeline(frame: pd.DataFrame) -> go.Figure:
    """Exibe execuções completas e incompletas por coletor em tempo UTC."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem execuções de coletor")
    colors = frame["status"].map({"complete": "#2a9d8f", "incomplete": "#e76f51"})
    figure = go.Figure(
        go.Scatter(
            x=frame["started_at"],
            y=frame["collector"],
            mode="markers",
            marker={"color": colors, "size": 10},
            text=frame["status"],
            name="execução",
        )
    )
    figure.update_layout(xaxis_title="Início da execução (UTC)", yaxis_title="Coletor")
    return figure


def metric_timeline(frame: pd.DataFrame, *, metric: str) -> go.Figure:
    """Exibe valores observados sem alterar a escala da métrica."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem observações para a série selecionada")
    direction = METRIC_DIRECTION.get(metric, "context_dependent")
    figure = go.Figure(
        go.Scatter(x=frame["timestamp"], y=frame["value"], mode="lines+markers", name=metric)
    )
    figure.update_layout(
        title=f"Timeline: {metric}<br><sup>Direção de degradação: {direction}</sup>",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Valor observado",
    )
    return figure


def source_metric_heatmap(frame: pd.DataFrame) -> go.Figure:
    """Mostra a distribuição de observações por origem e métrica."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem distribuição de source e metric")
    figure = coverage_heatmap(frame, x="metric", y="source", value="rows")
    figure.update_layout(title="Distribuição de observações por source e metric")
    return figure


def correlation_heatmap(frame: pd.DataFrame) -> go.Figure:
    """Calcula Pearson em pares observados, sem preencher lacunas com zero."""
    _assert_frame_cap(frame)
    value_frame = frame.drop(columns="timestamp", errors="ignore")
    matrix = value_frame.corr(numeric_only=True)
    if matrix.empty:
        return empty_figure("Sem séries numéricas para correlação")
    figure = go.Figure(
        go.Heatmap(
            x=matrix.columns.tolist(),
            y=matrix.index.tolist(),
            z=matrix.to_numpy(),
            zmin=-1,
            zmax=1,
            colorscale="RdBu",
            reversescale=True,
            hoverongaps=False,
        )
    )
    figure.update_layout(
        title="Correlação de Pearson (somente pares de observações presentes)",
        plot_bgcolor="#d9d9d9",
    )
    return figure


def qos_small_multiples(
    frame: pd.DataFrame, *, max_groups: int = MAX_QOS_SMALL_MULTIPLES
) -> go.Figure:
    """Mostra cada entidade/métrica de QoS em painel próprio, sem misturar unidades."""
    _assert_frame_cap(frame)
    if (
        isinstance(max_groups, bool)
        or not isinstance(max_groups, int)
        or not 1 <= max_groups <= MAX_QOS_SMALL_MULTIPLES
    ):
        raise ValueError(f"max_groups deve estar entre 1 e {MAX_QOS_SMALL_MULTIPLES}")
    if frame.empty:
        return empty_figure("Sem sinais de QoS no período selecionado")
    selected_groups = set()
    for entity, metric in frame.loc[:, ["entity", "metric"]].itertuples(index=False, name=None):
        selected_groups.add((entity, metric))
        if len(selected_groups) > max_groups:
            raise ResultLimitError(
                f"small multiples excede o limite de {max_groups} grupos; refine a seleção"
            )
    grouped = list(frame.groupby(["entity", "metric"], sort=True))
    figure = make_subplots(
        rows=len(grouped),
        cols=1,
        shared_xaxes=True,
        subplot_titles=[f"{entity} | {metric}" for (entity, metric), _ in grouped],
    )
    for row, ((entity, metric), series) in enumerate(grouped, start=1):
        unit = series["unit"].iloc[0] if "unit" in series else "valor"
        figure.add_trace(
            go.Scatter(
                x=series["timestamp"],
                y=series["value"],
                mode="lines+markers",
                name=f"{entity} | {metric}",
            ),
            row=row,
            col=1,
        )
        figure.update_yaxes(title_text=unit, row=row, col=1)
    figure.update_layout(height=max(300, 240 * len(grouped)), title="QoS por série")
    figure.update_xaxes(title_text="Timestamp (UTC)", row=len(grouped), col=1)
    return figure


def event_overlay_timeline(technical: pd.DataFrame, events: pd.DataFrame) -> go.Figure:
    """Sobrepõe eventos Tsuru à série técnica sem inferir causalidade a partir da coincidência."""
    _assert_frame_cap(technical)
    _assert_frame_cap(events)
    if technical.empty and events.empty:
        return empty_figure("Sem sinais técnicos ou eventos Tsuru no período selecionado")
    figure = go.Figure()
    for (entity, metric), series in technical.groupby(["entity", "metric"], sort=True):
        figure.add_trace(
            go.Scatter(
                x=series["timestamp"],
                y=series["value"],
                mode="lines+markers",
                name=f"{entity} | {metric}",
            )
        )
    if not events.empty:
        anchor = technical["value"].max() if not technical.empty else 1
        figure.add_trace(
            go.Scatter(
                x=events["timestamp"],
                y=[anchor] * len(events),
                mode="markers",
                marker={"symbol": "x", "size": 11, "color": "#e76f51"},
                text=(events["entity"] + " | " + events["event_label"]),
                hovertemplate="%{text}<extra>Evento Tsuru</extra>",
                name="Eventos Tsuru",
            )
        )
    figure.update_layout(
        title="Série técnica com eventos Tsuru (sobreposição temporal, não causalidade)",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Valor observado",
    )
    return figure


def impact_scatter(frame: pd.DataFrame, *, dimension: str = "player") -> go.Figure:
    """Mostra impacto agregado: volume, taxa de erro e erros absolutos em eixos distintos."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem dados de impacto de QoE")
    figure = go.Figure(
        go.Scatter(
            x=frame["sessions"],
            y=frame["error_rate_pct"],
            mode="markers",
            marker={"size": frame["errors"], "sizemode": "area", "sizemin": 5},
            text=frame.get(dimension, None),
            hovertemplate=(
                f"{dimension}: %{{text}}<br>sessões: %{{x}}<br>taxa de erro: %{{y:.2f}}%"
                "<extra></extra>"
            ),
            name="dimensão de QoE",
        )
    )
    figure.update_layout(
        title="Impacto de QoE por dimensão agregada",
        xaxis_title="Sessões",
        yaxis_title="Taxa de erro (%)",
    )
    return figure


def event_audience_timeline(frame: pd.DataFrame) -> go.Figure:
    """Exibe audiência concorrente por feed sem inventar pontos sem telemetria."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem confrontos EPG ou telemetria de audiência")
    observed = frame.loc[frame["telemetry_available"] & frame["timestamp"].notna()]
    if observed.empty:
        return empty_figure("Confrontos EPG sem telemetria de audiência disponível")
    groups = list(observed.groupby(["event_key", "tid"], sort=True))
    if len(groups) > MAX_EVENT_TRACE_GROUPS:
        raise ResultLimitError(
            f"timeline de eventos excede o limite de {MAX_EVENT_TRACE_GROUPS} feeds; "
            "refine a seleção"
        )
    figure = go.Figure()
    for (event_key, tid), series in groups:
        figure.add_trace(
            go.Scatter(
                x=series["timestamp"],
                y=series["active_sessions"],
                mode="lines+markers",
                name=f"{event_key} | tid {tid}",
            )
        )
    approximate = int((observed["mapping_scope"] == "national_family_approximation").sum())
    if approximate:
        figure.add_annotation(
            text="Globo usa correspondência aproximada da família nacional (globo%).",
            showarrow=False,
            x=0,
            y=1.12,
            xref="paper",
            yref="paper",
            align="left",
        )
    figure.update_layout(
        title="Audiência concorrente em janelas de 15 minutos por confronto/feed",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Sessões ativas concorrentes",
    )
    return figure


def event_impact_scatter(frame: pd.DataFrame) -> go.Figure:
    """Compara audiência de pico e QoE, mantendo slots sem telemetria explícitos."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem confrontos para comparar")
    observed = frame.loc[frame["telemetry_available"]].copy()
    if observed.empty:
        return empty_figure("Confrontos EPG sem telemetria de QoE disponível")
    figure = go.Figure(
        go.Scatter(
            x=observed["peak_audience"],
            y=observed["error_rate_pct"],
            mode="markers",
            marker={
                "size": observed["bufferratio_avg"].fillna(0).mul(100).add(8),
                "sizemode": "diameter",
                "sizemin": 6,
            },
            text=observed.apply(lambda row: f"{row['event_key']} | tid {row['tid']}", axis=1),
            hovertemplate=(
                "%{text}<br>audiência de pico: %{x}<br>sessões ativas com erro: %{y:.2f}%"
                "<extra></extra>"
            ),
            name="confronto com telemetria",
        )
    )
    unavailable = int((~frame["telemetry_available"]).sum())
    if unavailable:
        figure.add_annotation(
            text=(
                f"{unavailable} confronto(s) EPG sem telemetria disponível; não é incidente de QoE."
            ),
            showarrow=False,
            x=0,
            y=-0.2,
            xref="paper",
            yref="paper",
            align="left",
        )
    figure.update_layout(
        title="Impacto de audiência e QoE por confronto/feed",
        xaxis_title="Audiência concorrente de pico",
        yaxis_title="Sessões ativas com erro (%)",
    )
    return figure


def category_stack(frame: pd.DataFrame) -> go.Figure:
    """Empilha categorias sem misturar o significado de erros live e VOD."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem categorias de erro no período selecionado")
    groups = list(frame.groupby(["kind", "category"], sort=True))
    if len(groups) > MAX_QOE_TRACE_GROUPS:
        raise ResultLimitError(
            f"stack de categorias excede o limite de {MAX_QOE_TRACE_GROUPS} grupos; "
            "refine a seleção"
        )
    figure = go.Figure()
    for (kind, category), series in groups:
        figure.add_trace(
            go.Bar(
                x=series["timestamp"],
                y=series["errors"],
                name=f"{kind} | {category}",
            )
        )
    figure.update_layout(
        title="Categorias semânticas de erro por tipo de conteúdo",
        barmode="stack",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Erros",
    )
    return figure


def geo_heatmap(frame: pd.DataFrame) -> go.Figure:
    """Exibe UF x ISP localmente, sem carregar mapas, tiles ou outros ativos externos."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem dados geográficos de QoE")
    grouped = frame.groupby(["state_province", "isp"], as_index=False).agg(
        sessions=("sessions", "sum"), errors=("errors", "sum")
    )
    grouped["error_rate_pct"] = (
        grouped["errors"].div(grouped["sessions"].where(grouped["sessions"] > 0)).mul(100)
    )
    figure = coverage_heatmap(grouped, x="isp", y="state_province", value="error_rate_pct")
    figure.update_layout(
        title="Taxa de erro por UF x ISP (heatmap local)",
        xaxis_title="ISP",
        yaxis_title="UF",
    )
    figure.data[0].colorbar.title.text = "taxa de erro (%)"
    return figure


def qoe_timeline(frame: pd.DataFrame, *, metric: str = "active_sessions") -> go.Figure:
    """Traça uma métrica QoE por sinal sem fundir unidades ou canais distintos."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem dados de QoE no período selecionado")
    if metric not in frame:
        raise ValueError(f"métrica de QoE ausente: {metric}")
    grouping = "sinal" if "sinal" in frame else None
    groups = [] if grouping is None else list(frame.groupby(grouping, sort=True))
    if len(groups) > MAX_QOE_TRACE_GROUPS:
        raise ResultLimitError(
            f"timeline de QoE excede o limite de {MAX_QOE_TRACE_GROUPS} grupos; refine a seleção"
        )
    figure = go.Figure()
    if grouping is None:
        figure.add_trace(go.Scatter(x=frame["timestamp"], y=frame[metric], mode="lines+markers"))
    else:
        for signal, series in groups:
            figure.add_trace(
                go.Scatter(
                    x=series["timestamp"], y=series[metric], mode="lines+markers", name=signal
                )
            )
    figure.update_layout(
        title=f"Timeline de QoE: {metric}",
        xaxis_title="Timestamp (UTC)",
        yaxis_title=metric,
    )
    return figure


def incident_timeline(
    incidents: pd.DataFrame, deploys: pd.DataFrame, attribution: pd.DataFrame
) -> go.Figure:
    """Sobrepõe evidência temporal sem expor texto sanitizado ou alegar causalidade."""
    _assert_frame_cap(incidents)
    _assert_frame_cap(deploys)
    _assert_frame_cap(attribution)
    if incidents.empty and deploys.empty and attribution.empty:
        return empty_figure("Sem incidentes, deploys ou atribuição no período selecionado")

    figure = go.Figure()
    if not incidents.empty:
        safe_incidents = incidents.loc[:, ["priority", "state", "duration_ms"]].copy()
        safe_incidents["priority"] = safe_incidents["priority"].fillna("não informado")
        safe_incidents["state"] = safe_incidents["state"].fillna("não informado")
        figure.add_trace(
            go.Scatter(
                x=incidents["opened_at"],
                y=["ticket aberto"] * len(incidents),
                mode="markers",
                marker={"symbol": "diamond", "size": 11, "color": "#e76f51"},
                error_x={
                    "type": "data",
                    "array": [TICKET_OPEN_UNCERTAINTY_MS] * len(incidents),
                    "arrayminus": [TICKET_OPEN_UNCERTAINTY_MS] * len(incidents),
                    "visible": True,
                    "color": "#e76f51",
                },
                customdata=safe_incidents.to_numpy(),
                hovertemplate=(
                    "prioridade: %{customdata[0]}<br>estado: %{customdata[1]}"
                    "<br>duração registrada (ms): %{customdata[2]}"
                    "<br>abertura do ticket; início do incidente não é conhecido"
                    "<extra>Ticket (banda visual ±40 min)</extra>"
                ),
                name="Tickets",
            )
        )
    if not deploys.empty:
        safe_deploys = deploys.loc[:, ["entity", "event_label"]].fillna("não informado")
        figure.add_trace(
            go.Scatter(
                x=deploys["timestamp"],
                y=["deploy"] * len(deploys),
                mode="markers",
                marker={"symbol": "x", "size": 10, "color": "#457b9d"},
                customdata=safe_deploys.to_numpy(),
                hovertemplate=(
                    "alvo: %{customdata[0]}<br>evento: %{customdata[1]}<extra>Deploy</extra>"
                ),
                name="Deploys",
            )
        )
    if not attribution.empty:
        safe_attribution = attribution.loc[:, ["tier", "errors"]].fillna("não informado")
        figure.add_trace(
            go.Scatter(
                x=attribution["timestamp"],
                y=["erro atribuído"] * len(attribution),
                mode="markers",
                marker={"symbol": "circle", "size": 8, "color": "#2a9d8f"},
                customdata=safe_attribution.to_numpy(),
                hovertemplate=(
                    "camada: %{customdata[0]}<br>erros: %{customdata[1]}<extra>Atribuição</extra>"
                ),
                name="Erros atribuídos",
            )
        )
    figure.update_layout(
        title="Ticket, deploy e telemetria no tempo (sobreposição não prova causalidade)",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Tipo de evidência",
    )
    return figure


def provenance_bar(labels: pd.DataFrame) -> go.Figure:
    """Mostra a proveniência do golden set, distinguindo explicitamente rótulos circulares."""
    _assert_frame_cap(labels)
    if labels.empty:
        return empty_figure("Sem rótulos de proveniência no período selecionado")
    grouped = (
        labels.groupby(["provenance", "circular"], dropna=False).size().reset_index(name="rows")
    )
    figure = go.Figure()
    for circular, subset in grouped.groupby("circular", sort=True, dropna=False):
        is_circular = bool(circular) if pd.notna(circular) else False
        figure.add_trace(
            go.Bar(
                x=subset["provenance"],
                y=subset["rows"],
                name="circular" if is_circular else "confirmado / não circular",
                marker_color="#e76f51" if is_circular else "#2a9d8f",
            )
        )
    figure.update_layout(
        title="Proveniência dos rótulos (detector-derived é circular)",
        barmode="stack",
        xaxis_title="Proveniência",
        yaxis_title="Rótulos",
    )
    return figure


def attribution_stack(frame: pd.DataFrame) -> go.Figure:
    """Empilha erros por camada sem expor nomes de erro livres ou identificadores individuais."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem atribuição de erro no período selecionado")
    groups = list(frame.groupby("tier", sort=True))
    if len(groups) > MAX_RCA_TRACE_GROUPS:
        raise ResultLimitError(
            "stack de atribuição excede o limite de "
            f"{MAX_RCA_TRACE_GROUPS} camadas; refine a seleção"
        )
    figure = go.Figure()
    for tier, series in groups:
        figure.add_trace(go.Bar(x=series["timestamp"], y=series["errors"], name=tier))
    figure.update_layout(
        title="Erros live por camada de atribuição",
        barmode="stack",
        xaxis_title="Timestamp (UTC)",
        yaxis_title="Erros",
    )
    return figure
