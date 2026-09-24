#!/usr/bin/env bash
# IT02 (artefatos/sprint4/testes-funcionais.md, Seção 2): mesma ideia de
# test-live-api-local.sh (DynamoDB Local efêmero via Docker), mas para
# tests/dynamodb-real.integration.test.ts — IncidentUseCases contra Query()
# genuíno, sem precisar compilar nem subir o processo HTTP da API.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
api_dir="$repository_root/apps/backend/api"
image="amazon/dynamodb-local:2.6.1@sha256:990211fe3cbb507c52512522b5e71538802f086393f5b0d009d03a18c8bc04a6"
container_name="view-show-dynamodb-it02-${CI_PIPELINE_ID:-local}-$$"

cleanup() { docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --detach --name "$container_name" -p 127.0.0.1::8000 "$image" >/dev/null
host_port="$(docker port "$container_name" 8000/tcp)"

export RUN_LIVE_E2E=true
export DYNAMODB_ENDPOINT="http://$host_port"
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=local
export AWS_SECRET_ACCESS_KEY=local

cd "$api_dir"
npm test -- tests/dynamodb-real.integration.test.ts --reporter=verbose
