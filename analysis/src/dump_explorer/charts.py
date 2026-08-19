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

    figure = go.Figure(
        go.Bar(x=frame["table_name"], y=frame["estimated_rows"], name="estimativa")
    )
    figure.update_layout(
        title="Volume por tabela (estimativa do MySQL)",
        xaxis_title="Tabela",
        yaxis_title="Linhas (estimativa do MySQL)",
    )
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


def qos_small_multiples(frame: pd.DataFrame) -> go.Figure:
    """Mostra cada entidade/métrica de QoS em painel próprio, sem misturar unidades."""
    _assert_frame_cap(frame)
    if frame.empty:
        return empty_figure("Sem sinais de QoS no período selecionado")
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
