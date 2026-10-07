#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OBSERVABILITY_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
OUTPUT_PATH=${1:?Informe o caminho de saida do user data.}

: "${RENDER_AWS_ACCOUNT_ID:?Informe RENDER_AWS_ACCOUNT_ID.}"
: "${RENDER_AWS_REGION:?Informe RENDER_AWS_REGION.}"
: "${RENDER_GRAFANA_PASSWORD:?Informe RENDER_GRAFANA_PASSWORD.}"

command -v gzip >/dev/null || { echo "gzip nao encontrado." >&2; exit 1; }

encode_file() {
  gzip -9 -c "$1" | base64 | tr -d '\n'
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

RENDER_WORK_DIR=$(mktemp -d)
trap 'rm -rf -- "${RENDER_WORK_DIR}"' EXIT HUP INT TERM

sed \
  -e "s|\${account_id}|$(escape_sed_replacement "${RENDER_AWS_ACCOUNT_ID}")|g" \
  -e "s|\${aws_region}|$(escape_sed_replacement "${RENDER_AWS_REGION}")|g" \
  -e 's|${cluster_name}|view-show-iac-cluster|g' \
  -e 's|${namespace}|view-show|g' \
  -e 's|${service_name}|monitoracao-api-service|g' \
  -e 's|${load_balancer}|data-ingestion-alb|g' \
  -e 's|${target_group}|monitoracao-api-tg|g' \
  -e 's|${operational_table}|monitoracao-operacional|g' \
  -e 's|${log_group}|/aws/containerinsights/view-show-iac-cluster/application|g' \
  "${SCRIPT_DIR}/view-show-aws.json.tftpl" >"${RENDER_WORK_DIR}/view-show-aws.json"

sed \
  -e "s|\${account_id}|$(escape_sed_replacement "${RENDER_AWS_ACCOUNT_ID}")|g" \
  -e "s|\${aws_region}|$(escape_sed_replacement "${RENDER_AWS_REGION}")|g" \
  -e 's|${metrics_namespace}|view-show/Ingestion|g' \
  -e 's|${cluster_name}|view-show-iac-cluster|g' \
  -e 's|${backfill_task_family}|view-show-ingestion-backfill|g' \
  -e 's|${sync_task_family}|view-show-ingestion-sync|g' \
  -e 's|${incremental_export_task_family}|view-show-ingestion-incremental-export|g' \
  -e 's|${incremental_ingest_task_family}|view-show-ingestion-incremental-ingest|g' \
  -e 's|${analysis_queue}|view-show-ingestion-analysis|g' \
  -e 's|${analysis_dlq}|view-show-ingestion-analysis-dlq|g' \
  -e 's|${incremental_queue}|view-show-ingestion-incremental-batches.fifo|g' \
  -e 's|${incremental_dlq}|view-show-ingestion-incremental-batches-dlq.fifo|g' \
  -e 's|${backfill_log_group}|/ecs/view-show-ingestion-backfill|g' \
  -e 's|${sync_log_group}|/ecs/view-show-ingestion-sync|g' \
  -e 's|${incremental_export_log_group}|/ecs/view-show-ingestion-incremental-export|g' \
  -e 's|${incremental_ingest_log_group}|/ecs/view-show-ingestion-incremental-ingest|g' \
  -e 's/$${/${/g' \
  "${SCRIPT_DIR}/view-show-ingestion.json.tftpl" \
  >"${RENDER_WORK_DIR}/view-show-ingestion.json"

sed \
  -e "s|\${aws_account_id}|$(escape_sed_replacement "${RENDER_AWS_ACCOUNT_ID}")|g" \
  -e "s|\${aws_region}|$(escape_sed_replacement "${RENDER_AWS_REGION}")|g" \
  -e 's|${analysis_worker_log_group}|/ecs/view-show-analysis-worker|g' \
  "${SCRIPT_DIR}/view-show-agentic-aws.json.tftpl" >"${RENDER_WORK_DIR}/view-show-agentic-aws.json"

grep -Fq '"uid": "view-show-agentic-aws"' "${RENDER_WORK_DIR}/view-show-agentic-aws.json" || {
  echo "Dashboard Agentic AWS renderizado sem o UID esperado." >&2
  exit 1
}
grep -Fq '/ecs/view-show-analysis-worker' "${RENDER_WORK_DIR}/view-show-agentic-aws.json" || {
  echo "Dashboard Agentic AWS renderizado sem o log group do worker." >&2
  exit 1
}
if grep -Eq '\$\{(aws_region|aws_account_id|analysis_worker_log_group)\}' "${RENDER_WORK_DIR}/view-show-agentic-aws.json"; then
  echo "Dashboard Agentic AWS contem placeholder nao substituido." >&2
  exit 1
fi

COMPOSE_GZIP=$(encode_file "${SCRIPT_DIR}/docker-compose.yml")
PROMETHEUS_GZIP=$(encode_file "${SCRIPT_DIR}/prometheus.yml")
PROMETHEUS_RULES_GZIP=$(encode_file "${OBSERVABILITY_DIR}/prometheus/rules/view-show.yml")
ALLOY_GZIP=$(encode_file "${OBSERVABILITY_DIR}/alloy/config.alloy")
LOKI_GZIP=$(encode_file "${OBSERVABILITY_DIR}/loki/loki-config.yml")
TEMPO_GZIP=$(encode_file "${OBSERVABILITY_DIR}/tempo/tempo.yml")
DATASOURCES_GZIP=$(encode_file "${OBSERVABILITY_DIR}/grafana/provisioning/datasources/datasources.yml")
CLOUDWATCH_DATASOURCE_GZIP=$(encode_file "${SCRIPT_DIR}/cloudwatch-datasource.yml")
DASHBOARD_PROVIDER_GZIP=$(encode_file "${SCRIPT_DIR}/dashboard-provider.yml")
DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-aws.json")
INGESTION_DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-ingestion.json")
APPLICATION_DASHBOARD_GZIP=$(encode_file "${OBSERVABILITY_DIR}/grafana/provisioning/dashboards/json/view-show-overview.json")
API_DASHBOARD_GZIP=$(encode_file "${OBSERVABILITY_DIR}/grafana/provisioning/dashboards/json/view-show-api.json")
AGENTIC_DASHBOARD_GZIP=$(encode_file "${RENDER_WORK_DIR}/view-show-agentic-aws.json")
PASSWORD_BASE64=$(printf '%s' "${RENDER_GRAFANA_PASSWORD}" | base64 | tr -d '\n')

sed \
  -e "s|\${aws_region}|$(escape_sed_replacement "${RENDER_AWS_REGION}")|g" \
  -e "s|\${grafana_password_base64}|${PASSWORD_BASE64}|g" \
  -e "s|\${compose_gzip}|${COMPOSE_GZIP}|g" \
  -e "s|\${prometheus_gzip}|${PROMETHEUS_GZIP}|g" \
  -e "s|\${prometheus_rules_gzip}|${PROMETHEUS_RULES_GZIP}|g" \
  -e "s|\${alloy_gzip}|${ALLOY_GZIP}|g" \
  -e "s|\${loki_gzip}|${LOKI_GZIP}|g" \
  -e "s|\${tempo_gzip}|${TEMPO_GZIP}|g" \
  -e "s|\${datasources_gzip}|${DATASOURCES_GZIP}|g" \
  -e "s|\${cloudwatch_datasource_gzip}|${CLOUDWATCH_DATASOURCE_GZIP}|g" \
  -e "s|\${dashboard_provider_gzip}|${DASHBOARD_PROVIDER_GZIP}|g" \
  -e "s|\${dashboard_gzip}|${DASHBOARD_GZIP}|g" \
  -e "s|\${ingestion_dashboard_gzip}|${INGESTION_DASHBOARD_GZIP}|g" \
  -e "s|\${application_dashboard_gzip}|${APPLICATION_DASHBOARD_GZIP}|g" \
  -e "s|\${api_dashboard_gzip}|${API_DASHBOARD_GZIP}|g" \
  -e "s|\${agentic_dashboard_gzip}|${AGENTIC_DASHBOARD_GZIP}|g" \
  -e 's/$${/${/g' \
  "${SCRIPT_DIR}/user-data.sh.tftpl" >"${OUTPUT_PATH}"

sh -n "${OUTPUT_PATH}"

grep -Fq 'view-show-agentic-aws.json' "${OUTPUT_PATH}" || {
  echo "Dashboard Agentic AWS ausente do user data renderizado." >&2
  exit 1
}

TEMPLATE_PLACEHOLDERS=$(
  sed 's/\$\${[^}]*}//g' "${SCRIPT_DIR}/user-data.sh.tftpl" |
    grep -Eo '\$\{[a-z_][a-z0-9_]*\}' |
    sort -u
)
for placeholder in ${TEMPLATE_PLACEHOLDERS}; do
  if grep -Fq "${placeholder}" "${OUTPUT_PATH}"; then
    echo "Placeholder nao substituido no user data: ${placeholder}" >&2
    exit 1
  fi
done

gzip -9 -c "${OUTPUT_PATH}" >"${OUTPUT_PATH}.gz"

if [ "$(wc -c <"${OUTPUT_PATH}.gz")" -gt 16384 ]; then
  echo "User data comprimido excede o limite de 16 KiB da EC2." >&2
  exit 1
fi

echo "User data do deploy isolado renderizado e validado."
