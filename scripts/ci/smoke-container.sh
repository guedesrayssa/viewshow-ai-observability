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

docker run --detach --name "$container_name" "$image" >/dev/null

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$container_name" 2>/dev/null || true)"
  if [[ "$status" == "healthy" ]]; then
    configured_user="$(docker inspect --format '{{.Config.User}}' "$container_name")"
    if [[ "$configured_user" != "node" ]]; then
      echo "container user must be node, got: ${configured_user:-root}" >&2
      exit 1
    fi
    body="$(docker exec "$container_name" node -e \
      "fetch('http://127.0.0.1:3000/health').then(async response=>{if(response.status !== 200)process.exit(1);process.stdout.write(await response.text())}).catch(()=>process.exit(1))")"
    if ! jq -e -s 'length == 1 and .[0] == {"status":"ok"}' >/dev/null <<<"$body"; then
      echo "container returned an unexpected health payload" >&2
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
