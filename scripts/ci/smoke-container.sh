#!/usr/bin/env bash
set -Eeuo pipefail

image="${1:?usage: smoke-container.sh IMAGE}"
attempts="${SMOKE_ATTEMPTS:-30}"
delay_seconds="${SMOKE_DELAY_SECONDS:-1}"
container_name="monitoracao-api-smoke-${CI_PIPELINE_ID:-local}-$$"

image_architecture="$(docker image inspect "$image" --format '{{.Architecture}}')"
if [[ "$image_architecture" != "amd64" ]]; then
  echo "container architecture must be amd64, got: $image_architecture" >&2
  exit 1
fi

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container_name" \
  --env NODE_ENV=test \
  --env AUTH_COOKIE_SECRET=ci-smoke-cookie-secret-at-least-32-bytes \
  --env CURSOR_SECRET=ci-smoke-cursor-secret-at-least-32-bytes \
  "$image" >/dev/null

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container_name" 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    configured_user="$(docker inspect --format '{{.Config.User}}' "$container_name")"
    if [[ "$configured_user" != "node" ]]; then
      echo "container user must be node, got: ${configured_user:-root}" >&2
      exit 1
    fi
    body="$(docker exec "$container_name" node -e \
      "fetch('http://127.0.0.1:3000/health',{signal:AbortSignal.timeout(5000)}).then(async response=>{if(response.status !== 200)process.exit(1);process.stdout.write(await response.text())}).catch(()=>process.exit(1))")"
    if ! jq -e -s 'length == 1 and .[0] == {"status":"ok"}' >/dev/null <<<"$body"; then
      echo "container returned an unexpected health payload" >&2
      exit 1
    fi
    auth_result="$(docker exec "$container_name" node -e \
      "fetch('http://127.0.0.1:3000/auth/login',{signal:AbortSignal.timeout(5000)}).then(async response=>{process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}))}).catch(()=>process.exit(1))")"
    if ! jq -e '.status == 503 and .body.error.code == "FEATURE_UNAVAILABLE" and (.body.error.requestId | type == "string")' >/dev/null <<<"$auth_result"; then
      echo "container public API smoke returned an unexpected auth envelope" >&2
      exit 1
    fi
    echo "container health check passed"
    exit 0
  fi
  if [[ "$status" == "unhealthy" ]]; then
    break
  fi
  sleep "$delay_seconds"
done

docker logs "$container_name" >&2 || true
echo "container did not become healthy after $attempts attempts" >&2
exit 1
