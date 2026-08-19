"""Acesso limitado ao MySQL local do Argus."""

import pandas as pd
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine

from dump_explorer.config import HARD_MAX_ROWS, Settings


class ResultLimitError(RuntimeError):
    """Indica que uma consulta ultrapassou o limite permitido."""


def create_db_engine(settings: Settings) -> Engine:
    return create_engine(settings.database_url, pool_pre_ping=True, pool_recycle=1800)


def read_frame(engine, statement, params=None, max_rows=100_000) -> pd.DataFrame:
    if not 1 <= max_rows <= HARD_MAX_ROWS:
        raise ResultLimitError(f"max_rows deve estar entre 1 e {HARD_MAX_ROWS}")

    chunks = pd.read_sql_query(
        statement,
        engine,
        params=params or {},
        chunksize=max_rows + 1,
    )
    first = next(chunks, pd.DataFrame())
    if len(first) > max_rows or next(chunks, None) is not None:
        raise ResultLimitError(f"consulta excedeu o limite de {max_rows} linhas")
    return first
