"""Expõe os leitores permitidos para snapshots e para a origem MySQL ao vivo.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from adapters.sources.mysql_incremental import MySqlIncrementalExportSource
from adapters.sources.mysql_live import MySqlLiveReader
from adapters.sources.mysql_reader import MySqlConnectionSettings, MySqlSourceReader

__all__ = [
    "MySqlConnectionSettings",
    "MySqlIncrementalExportSource",
    "MySqlLiveReader",
    "MySqlSourceReader",
]
