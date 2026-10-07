#!/usr/bin/env bash
set -euo pipefail
LAB="${RNF_LAB_DIR:-$(cd "$(dirname "$0")" && pwd)}"
API="$(cd "$LAB/../.." && pwd)"
ROOT="$(cd "$API/../../.." && pwd)"
RESULTS_DIR="${RESULTS_DIR:-$ROOT/assets/testes-carga/2026-10-06-fechamento-local}"
mkdir -p "$RESULTS_DIR"
export DYNAMODB_ENDPOINT=http://127.0.0.1:18001 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_EC2_METADATA_DISABLED=true
export OPERATIONAL_TABLE_NAME=view-show-rnf-api AUTH_COOKIE_SECRET=local-rnf-session-secret-32-bytes-minimum CURSOR_SECRET=local-rnf-cursor-secret-32-bytes-minimum
export IMPORT_CURSOR_SECRET="$CURSOR_SECRET" IMPORT_BUCKET=local-rnf-imports IMPORT_EXPECTED_BUCKET_OWNER=000000000000
export IMPORT_KUBERNETES_NAMESPACE=view-show-imports IMPORT_KUBERNETES_TEMPLATE=ingestion-import IMPORT_INGESTION_CONTAINER_NAME=ingestion
export KUBERNETES_NAMESPACE=view-show INGESTION_CRONJOB_NAME=ingestion-sync
export METRICS_ENABLED=true HOST=0.0.0.0 PORT=13000 NODE_ENV=test RATE_LIMIT_PER_MINUTE=1000000 AUTH_LOGIN_RATE_LIMIT_PER_MINUTE=100 OTEL_EXPORTER_OTLP_ENDPOINT=""
cd "$API"
node --input-type=module - "$RESULTS_DIR" "$LAB/run-api.sh" <<'JS'
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const [out,source]=process.argv.slice(2);
writeFileSync(out+'/environment.json',JSON.stringify({startedAt:new Date().toISOString(),codeRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runnerSha256:createHash('sha256').update(readFileSync(source)).digest('hex'),node:process.version,scope:'host API against persistent DynamoDB Local; no Kubernetes control-plane calls validated',soakDuration:process.env.SOAK_DURATION||'30m',incidents:2500},null,2)+'\n');
JS
npm run build > "$RESULTS_DIR/api-build.txt" 2>&1
node loadtest/scripts/ensure-local-table.cjs
INCIDENTS_PER_HOUR=100 CLEAN=1 node scripts/seed-carga.cjs > "$RESULTS_DIR/api-seed.txt"
node dist/index.js > "$RESULTS_DIR/api-runtime.log" 2>&1 &
api_pid=$!
trap 'kill "$api_pid" 2>/dev/null || true; docker compose -f "$LAB/compose.yml" start dynamodb >/dev/null 2>&1 || true' EXIT INT TERM
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:13000/health >/dev/null; then break; fi
  sleep 1
done
export BASE_URL=http://127.0.0.1:13000
run() {
  local mode="$1" rate="$2" folder="$RESULTS_DIR/api-$1-$2"
  mkdir -p "$folder"
  date -u +%FT%TZ > "$folder/start.txt"
  k6 run -e BASE_URL="$BASE_URL" -e AUTH_COOKIE_SECRET="$AUTH_COOKIE_SECRET" -e INCIDENT_COUNT=2500 -e MAX_VUS=1500 -e RATE="$rate" -e MODE="$mode" -e RESULTS_DIR="$folder" -e DURATION="${SOAK_DURATION:-30m}" "$API/loadtest/k6/front-api.js" > "$folder/k6.txt" 2>&1 && status=0 || status=$?
  printf '%s\n' "$status" > "$folder/exit-code.txt"
  date -u +%FT%TZ > "$folder/end.txt"
  echo "$mode/$rate exit=$status"
}
run smoke 1
mv "$RESULTS_DIR/api-smoke-1" "$RESULTS_DIR/api-baseline"
run load 137
# Indisponibilidade real do destino; nenhuma resposta HTTP é falsificada.
docker compose -f "$LAB/compose.yml" stop dynamodb
run smoke 1
mv "$RESULTS_DIR/api-smoke-1" "$RESULTS_DIR/api-dynamodb-indisponivel"
docker compose -f "$LAB/compose.yml" start dynamodb
for attempt in $(seq 1 40); do
  if node loadtest/scripts/ensure-local-table.cjs >/dev/null 2>&1; then break; fi
  sleep 1
done
run smoke 1
mv "$RESULTS_DIR/api-smoke-1" "$RESULTS_DIR/api-recuperacao"
run soak 50
