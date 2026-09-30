#!/usr/bin/env bash
# Executa uma rodada isolada: API + DynamoDB Local + massa sintética.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api_dir="$(cd "$script_dir/.." && pwd)"
mode="${1:-${MODE:-smoke}}"
case "$mode" in
  smoke|load|breakpoint|spike|stress|soak) ;;
  *) echo "Modo inválido: $mode (use smoke, load, breakpoint, spike, stress ou soak)." >&2; exit 2 ;;
esac
for command in docker npm node k6 curl; do
  command -v "$command" >/dev/null || { echo "Dependência ausente: $command" >&2; exit 2; }
done

container_name="view-show-loadtest-local-$$"
api_pid=""
cleanup() {
  if [[ -n "$api_pid" ]]; then kill "$api_pid" >/dev/null 2>&1 || true; wait "$api_pid" 2>/dev/null || true; fi
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

export DYNAMODB_ENDPOINT="http://127.0.0.1:${DYNAMODB_LOCAL_PORT:-18000}"
export AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_EC2_METADATA_DISABLED=true
export OPERATIONAL_TABLE_NAME="view-show-loadtest-local"
export AUTH_COOKIE_SECRET="local-loadtest-auth-cookie-secret-32-bytes-minimum"
export CURSOR_SECRET="local-loadtest-cursor-secret-32-bytes-minimum"
export IMPORT_CURSOR_SECRET="$CURSOR_SECRET"
export IMPORT_BUCKET="local-loadtest-imports"
export IMPORT_EXPECTED_BUCKET_OWNER=000000000000
export IMPORT_INGESTION_CLUSTER_ARN="arn:aws:ecs:us-east-1:000000000000:cluster/local"
export IMPORT_INGESTION_TASK_DEFINITION_ARN="arn:aws:ecs:us-east-1:000000000000:task-definition/local:1"
export IMPORT_INGESTION_SUBNET_IDS=subnet-local
export IMPORT_INGESTION_SECURITY_GROUP_ID=sg-local
export IMPORT_INGESTION_CONTAINER_NAME=ingestion
export INGESTION_SCHEDULER_GROUP_NAME=view-show-ingestion
export INGESTION_SCHEDULER_NAME=view-show-ingestion-sync
export METRICS_ENABLED=true
export HOST=127.0.0.1 PORT="${API_PORT:-3000}" NODE_ENV=test
export RATE_LIMIT_PER_MINUTE="${API_RATE_LIMIT_PER_MINUTE:-30000}"
export AUTH_LOGIN_RATE_LIMIT_PER_MINUTE=100
export OTEL_EXPORTER_OTLP_ENDPOINT=""

docker run --detach --rm --name "$container_name" \
  -p "127.0.0.1:${DYNAMODB_LOCAL_PORT:-18000}:8000" \
  "amazon/dynamodb-local:2.6.1@sha256:990211fe3cbb507c52512522b5e71538802f086393f5b0d009d03a18c8bc04a6" >/dev/null

cd "$api_dir"
npm run build
node loadtest/scripts/ensure-local-table.cjs
CLEAN=1 node scripts/seed-carga.cjs
node dist/index.js >"${TMPDIR:-/tmp}/view-show-loadtest-api-$$.log" 2>&1 &
api_pid=$!

ready=0
for _ in $(seq 1 60); do
  if curl --silent --fail "http://127.0.0.1:${API_PORT:-3000}/health" >/dev/null; then ready=1; break; fi
  if ! kill -0 "$api_pid" >/dev/null 2>&1; then break; fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  cat "${TMPDIR:-/tmp}/view-show-loadtest-api-$$.log" >&2
  echo "API local não iniciou; veja a saída acima." >&2
  exit 1
fi

echo "Alvo local: http://127.0.0.1:${API_PORT:-3000} | modo: $mode | taxa: ${RATE:-50} req/s"
mkdir -p "$script_dir/results"
export BASE_URL="http://127.0.0.1:${API_PORT:-3000}"
k6 run \
  -e BASE_URL="$BASE_URL" \
  -e AUTH_COOKIE_SECRET="$AUTH_COOKIE_SECRET" \
  -e INCIDENT_COUNT="${INCIDENT_COUNT:-300}" \
  -e RATE="${RATE:-50}" \
  -e DURATION="${DURATION:-30m}" \
  -e RESULTS_DIR="$script_dir/results" \
  -e MODE="$mode" \
  "$script_dir/k6/front-api.js"
