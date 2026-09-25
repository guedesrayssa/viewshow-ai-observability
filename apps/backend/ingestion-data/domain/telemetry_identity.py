"""Dono único da identidade de telemetria do serviço de ingestão.

A cadeia de observabilidade exige IGUALDADE EXATA entre o rótulo `service_name`
dos logs no Loki, o `service.name` dos spans e o valor usado nos alarmes
(`apps/fullstack/observability/documentation/mapeamento-traces-observabilidade.md`).
Três lugares, um valor. Quando o nome é digitado mais de uma vez, a divergência
não gera erro: o salto span->logs volta vazio e o alarme fica sem dados.

Por isso o nome e o namespace moram aqui, e não em cada camada que os usa.
Os valores derivam de `deployment_namespace`, que o Terraform fixa em `view-show`
(`apps/fullstack/variables.tf`).
"""

from __future__ import annotations

METRICS_NAMESPACE_PREFIX = "view-show"
SERVICE_NAME = f"{METRICS_NAMESPACE_PREFIX}-ingestion"
METRICS_NAMESPACE = f"{METRICS_NAMESPACE_PREFIX}/Ingestion"

__all__ = ["METRICS_NAMESPACE", "METRICS_NAMESPACE_PREFIX", "SERVICE_NAME"]
