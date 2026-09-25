"""Expõe os adaptadores seguros de logs, métricas e observação das portas.

Papel no fluxo:
    Como adaptador de infraestrutura, este arquivo traduz contratos internos para uma API ou
    formato externo e valida a resposta antes de devolvê-la à aplicação.

Garantias e limites:
    Erros externos são convertidos em falhas sanitizadas; dados inesperados nunca são aceitos
    por conveniência ou por fallback permissivo.
"""

from adapters.telemetry.cloudwatch_metrics import CloudWatchMetrics
from adapters.telemetry.json_logging import JsonLogger
from adapters.telemetry.runtime import observe_command, safe_error_message

__all__ = ["CloudWatchMetrics", "JsonLogger", "observe_command", "safe_error_message"]
