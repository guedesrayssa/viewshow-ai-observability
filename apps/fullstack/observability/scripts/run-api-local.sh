#!/usr/bin/env bash
# Sobe a API localmente ligada à pilha de observabilidade, para ver logs,
# traces e métricas no Grafana (http://localhost:3002).
#
# Pré-requisito: a pilha no ar
#   docker compose -f apps/fullstack/docker-compose.observability.yml up -d
#
# O script usa um DynamoDB Local descartável (porta 18000) com massa sintética:
# nada aqui toca a AWS, e as credenciais são fictícias. A API fica em primeiro
# plano; Ctrl+C a encerra e remove o contêiner. Em outro terminal:
#   AUTH_COOKIE_SECRET=local-obs-auth-cookie-secret-32-bytes-minimum \
#     node apps/fullstack/observability/scripts/verify-api-observability.mjs
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_dir="$(cd "$script_dir/../../../backend/api" && pwd)"
for command in docker npm node curl; do
  command -v "$command" >/dev/null || { echo "Dependência ausente: $command" >&2; exit 2; }
done
curl --silent --fail "http://localhost:${LOKI_PORT:-3100}/ready" >/dev/null 2>&1 \
  || echo "Aviso: o Loki não respondeu em :${LOKI_PORT:-3100}; suba a pilha antes para ver os logs no Grafana." >&2

container_name="vs-obs-ddb-$$"
cleanup() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

export DYNAMODB_ENDPOINT="http://127.0.0.1:${DYNAMODB_LOCAL_PORT:-18000}"
export AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_EC2_METADATA_DISABLED=true
unset AWS_PROFILE AWS_SESSION_TOKEN
export OPERATIONAL_TABLE_NAME="view-show-obs-local"
export AUTH_COOKIE_SECRET="${AUTH_COOKIE_SECRET:-local-obs-auth-cookie-secret-32-bytes-minimum}"
export CURSOR_SECRET="local-obs-cursor-secret-32-bytes-minimum"
export IMPORT_CURSOR_SECRET="$CURSOR_SECRET"
export IMPORT_BUCKET="local-obs-imports"
export IMPORT_EXPECTED_BUCKET_OWNER=000000000000
# Bootstrap atual: o verificador HTTP não lança Jobs nem modifica CronJobs.
export IMPORT_KUBERNETES_NAMESPACE=view-show-local-imports
export IMPORT_KUBERNETES_TEMPLATE=ingestion-import
export IMPORT_INGESTION_CONTAINER_NAME=ingestion
export KUBERNETES_NAMESPACE=view-show-local
export INGESTION_CRONJOB_NAME=ingestion-sync
export METRICS_ENABLED=true
# 0.0.0.0: o Prometheus (em contêiner) coleta /metrics via host.docker.internal.
export HOST=0.0.0.0 PORT="${API_PORT:-3000}" NODE_ENV=development
export FRONTEND_ORIGIN=http://localhost:3001
export RATE_LIMIT_PER_MINUTE=30000 AUTH_LOGIN_RATE_LIMIT_PER_MINUTE=100
# Telemetria: traces ao Tempo (OTLP/HTTP) e logs ao Loki (envio em lote).
export OTEL_SERVICE_NAME=view-show-api OTEL_DEPLOYMENT_ENVIRONMENT=local
export SERVICE_VERSION="${SERVICE_VERSION:-local-$(git -C "$api_dir" rev-parse --short HEAD 2>/dev/null || echo dev)}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT-http://localhost:4318}"
export LOKI_PUSH_URL="${LOKI_PUSH_URL-http://localhost:3100/loki/api/v1/push}"

docker run --detach --rm --name "$container_name" \
  -p "127.0.0.1:${DYNAMODB_LOCAL_PORT:-18000}:8000" \
  "amazon/dynamodb-local:2.6.1@sha256:990211fe3cbb507c52512522b5e71538802f086393f5b0d009d03a18c8bc04a6" >/dev/null

cd "$api_dir"
npm run build
node loadtest/scripts/ensure-local-table.cjs
CLEAN=1 node scripts/seed-carga.cjs >/dev/null
echo "API em http://127.0.0.1:${PORT} | traces -> ${OTEL_EXPORTER_OTLP_ENDPOINT:-desligado} | logs -> ${LOKI_PUSH_URL:-desligado}"
node dist/index.js
