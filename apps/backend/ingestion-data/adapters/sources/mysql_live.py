"""Lê o MySQL live após a autorização dinâmica feita pela aplicação.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from __future__ import annotations

from adapters.sources.mysql_reader import (
    ConnectionFactory,
    MySqlConnectionSettings,
    MySqlSourceReader,
)
from contracts.registry import DatasetRegistry


class MySqlLiveReader(MySqlSourceReader):
    """Agrupa o estado e as operações de ``MySqlLiveReader`` neste módulo.

    A instância mantém juntas as validações e dependências necessárias para que estados
    incompletos não atravessem a fronteira da camada.
    """

    def __init__(
        self,
        registry: DatasetRegistry,
        settings: MySqlConnectionSettings,
        *,
        connection_factory: ConnectionFactory | None = None,
    ) -> None:
        """Inicializa a instância com as dependências e configurações fornecidas.

        Args:
            registry: Entrada ``registry``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            settings: Entrada ``settings``; a forma aceita é definida pela anotação de tipo e
            validada antes do uso.
            connection_factory: Fábrica injetada que cria a dependência somente quando
            necessária.

        Returns:
            Não produz valor de retorno; conclui após aplicar ou validar a operação.

        Raises:
            TypeError: Se um argumento não possuir o tipo exigido pelo contrato.
        """
        super().__init__(registry, settings, connection_factory=connection_factory)


__all__ = ["MySqlLiveReader"]
