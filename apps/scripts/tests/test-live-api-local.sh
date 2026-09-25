#!/usr/bin/env bash
# Sobe um DynamoDB Local efêmero para validar a API sem acessar recursos AWS.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "$script_dir/../../.." && pwd)"
api_dir="$repository_root/apps/backend/api"
image="amazon/dynamodb-local:2.6.1@sha256:990211fe3cbb507c52512522b5e71538802f086393f5b0d009d03a18c8bc04a6"
container_name="view-show-dynamodb-e2e-${CI_PIPELINE_ID:-local}-$$"

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
npm run build
npx vitest run tests/live-api.e2e.test.ts
