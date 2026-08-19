"""Gráficos Plotly reutilizáveis para os notebooks de exploração."""

import pandas as pd
import plotly.graph_objects as go

from dump_explorer.config import HARD_MAX_ROWS
from dump_explorer.database import ResultLimitError


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
