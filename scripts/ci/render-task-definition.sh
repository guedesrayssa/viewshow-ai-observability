#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$#" -ne 4 ]]; then
  echo "usage: render-task-definition.sh INPUT_JSON OUTPUT_JSON IMAGE_URI CONTAINER_NAME" >&2
  exit 64
fi

input_json="$1"
output_json="$2"
image_uri="$3"
container_name="$4"

if [[ ! -s "$input_json" ]]; then
  echo "task definition input does not exist or is empty: $input_json" >&2
  exit 66
fi

umask 077
temporary_output="$(mktemp "${output_json}.tmp.XXXXXX")"
cleanup() { rm -f "$temporary_output"; }
trap cleanup EXIT

health_command="node -e \"const http=require('node:http');const request=http.get('http://127.0.0.1:3000/health',response=>{response.resume();process.exit(response.statusCode===200?0:1)});request.on('error',()=>process.exit(1));request.setTimeout(4000,()=>{request.destroy();process.exit(1)})\""

jq -e \
  --arg image "$image_uri" \
  --arg container "$container_name" \
  --arg health "$health_command" \
  '
    (.containerDefinitions // []) as $containers
    | ([$containers[] | select(.name == $container)] | length) as $matches
    | if $matches != 1
      then error("expected exactly one container named " + $container)
      else .
      end
    | del(
        .taskDefinitionArn,
        .revision,
        .status,
        .requiresAttributes,
        .compatibilities,
        .registeredAt,
        .registeredBy,
        .deregisteredAt
      )
    | .containerDefinitions |= map(
        if .name == $container
        then .image = $image
          | .healthCheck = {
              command: ["CMD-SHELL", $health],
              interval: 30,
              timeout: 5,
              retries: 3,
              startPeriod: 10
            }
        else .
        end
      )
  ' "$input_json" >"$temporary_output"

mv "$temporary_output" "$output_json"
