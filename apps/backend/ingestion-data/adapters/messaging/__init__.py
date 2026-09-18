"""Agrupa os adaptadores de mensageria usados pelos eventos de análise.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from adapters.messaging.incremental_sqs import SqsIncrementalBatchQueue

__all__ = ["SqsIncrementalBatchQueue"]
