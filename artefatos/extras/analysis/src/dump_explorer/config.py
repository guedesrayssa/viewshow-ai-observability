"""Configuração do laboratório de exploração Argus."""

import os
from collections.abc import Mapping
from dataclasses import dataclass

from dotenv import load_dotenv

HARD_MAX_ROWS = 100_000


class ConfigurationError(ValueError):
    """Indica uma configuração inválida para o explorador."""


@dataclass(frozen=True)
class Settings:
    database_url: str
    max_rows: int = HARD_MAX_ROWS
    display_timezone: str = "America/Sao_Paulo"


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    if env is None:
        load_dotenv()
        values = os.environ
    else:
        values = env

    url = values.get("ARGUS_DATABASE_URL", "").strip()
    if not url:
        raise ConfigurationError("ARGUS_DATABASE_URL não configurada")

    try:
        max_rows = int(values.get("ARGUS_MAX_ROWS", str(HARD_MAX_ROWS)))
    except ValueError as exc:
        raise ConfigurationError("ARGUS_MAX_ROWS deve ser inteiro") from exc

    if not 1 <= max_rows <= HARD_MAX_ROWS:
        raise ConfigurationError("ARGUS_MAX_ROWS deve estar entre 1 e 100000")

    return Settings(url, max_rows, values.get("ARGUS_DISPLAY_TIMEZONE", "America/Sao_Paulo"))
