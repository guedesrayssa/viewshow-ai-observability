#!/usr/bin/env bash
set -Eeuo pipefail
set +x

image="${1:?usage: smoke-ingestion-container.sh IMAGE}"
script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

architecture="$(docker image inspect "$image" --format '{{.Architecture}}')"
user="$(docker image inspect "$image" --format '{{.Config.User}}')"
entrypoint="$(docker image inspect "$image" --format '{{json .Config.Entrypoint}}')"
ports="$(docker image inspect "$image" --format '{{json .Config.ExposedPorts}}')"
if [[ "$architecture" != "amd64" || "$user" != "ingestion" ]]; then
  echo "ingestion image must be linux/amd64 and run as ingestion" >&2
  exit 1
fi
if [[ "$entrypoint" != '["python","-m","bootstrap"]' || "$ports" != "null" ]]; then
  echo "ingestion image has an invalid batch runtime contract" >&2
  exit 1
fi

smoke_program="$(<"$script_directory/ingestion-container-smoke.py")"
output="$(docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 --network none --cap-drop ALL --security-opt no-new-privileges --env INGESTION_SMOKE_EXPECT_UID=10001 --env INGESTION_SMOKE_EXPECT_WORKDIR=/tmp/ingestion --entrypoint python "$image" -c "$smoke_program")"
if [[ "$output" != "record-spool-create-cleanup-ok" ]]; then
  echo "ingestion spool smoke returned unexpected output" >&2
  exit 1
fi
