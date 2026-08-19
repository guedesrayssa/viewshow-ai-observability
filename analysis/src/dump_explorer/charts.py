"""Gráficos Plotly reutilizáveis para os notebooks de exploração."""

import pandas as pd
import plotly.graph_objects as go


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
    if frame.empty:
        return empty_figure("Sem dados de cobertura")

    matrix = frame.pivot_table(index=y, columns=x, values=value, aggfunc="sum", fill_value=0)
    return go.Figure(
        go.Heatmap(
            x=matrix.columns.tolist(),
            y=matrix.index.tolist(),
            z=matrix.to_numpy(),
            colorbar={"title": value},
        )
    )
