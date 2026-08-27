#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly expected_account="248880318395"
readonly expected_region="us-east-1"
readonly expected_repository="monitoracao-api"

required_variables=(AWS_ACCOUNT_ID AWS_DEFAULT_REGION ECR_REPOSITORY CI_COMMIT_SHA)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "required environment variable is missing: $variable_name" >&2
    exit 64
  fi
done

if [[ "$AWS_ACCOUNT_ID" != "$expected_account" ]]; then
  echo "unexpected publication binding: AWS_ACCOUNT_ID" >&2
  exit 64
fi
if [[ "$AWS_DEFAULT_REGION" != "$expected_region" ]]; then
  echo "unexpected publication binding: AWS_DEFAULT_REGION" >&2
  exit 64
fi
if [[ "$ECR_REPOSITORY" != "$expected_repository" ]]; then
  echo "unexpected publication binding: ECR_REPOSITORY" >&2
  exit 64
fi
if ! [[ "$CI_COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CI_COMMIT_SHA must be exactly 40 hexadecimal characters" >&2
  exit 64
fi

endpoint_override_names=()
while IFS= read -r variable_name; do
  endpoint_override_names+=("$variable_name")
done < <(compgen -A variable AWS_ENDPOINT_URL || true)
if ((${#endpoint_override_names[@]} != 0)); then
  echo "AWS endpoint overrides are not allowed: ${endpoint_override_names[*]}" >&2
  exit 64
fi
unset endpoint_override_names
export AWS_PAGER=""
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true

for command_name in aws docker jq mktemp mv rm dirname git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command is unavailable: $command_name" >&2
    exit 69
  fi
done

repository_head="$(git rev-parse --verify HEAD)"
if [[ "$repository_head" != "$CI_COMMIT_SHA" ]]; then
  echo "CI_COMMIT_SHA does not match checked-out HEAD" >&2
  exit 64
fi
unset repository_head

identity_json="$(aws sts get-caller-identity --output json)"
actual_account="$(jq -r '.Account' <<<"$identity_json")"
caller_arn="$(jq -r '.Arn' <<<"$identity_json")"
if [[ "$actual_account" != "$expected_account" ]]; then
  echo "unexpected AWS account: $actual_account (expected $expected_account)" >&2
  exit 77
fi
if ! [[ "$caller_arn" =~ ^arn:aws:sts::248880318395:assumed-role/voclabs/[^/]+$ ]]; then
  echo "unexpected AWS caller; expected the voclabs assumed role" >&2
  exit 77
fi
unset identity_json actual_account caller_arn

readonly registry="${expected_account}.dkr.ecr.${expected_region}.amazonaws.com"
readonly image_uri="${registry}/${expected_repository}:${CI_COMMIT_SHA}"
readonly cache_uri="${registry}/${expected_repository}:buildcache"
dotenv_file="${BACKEND_IMAGE_ENV_FILE:-backend-image.env}"
dotenv_temp=""
cleanup() {
  if [[ -n "$dotenv_temp" ]]; then
    rm -f "$dotenv_temp"
  fi
}
trap cleanup EXIT

aws ecr get-login-password --region "$expected_region" |
  docker login --username AWS --password-stdin "$registry"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --cache-from "type=registry,ref=$cache_uri" \
  --cache-to "type=registry,ref=$cache_uri,mode=max,image-manifest=true,oci-mediatypes=true" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --tag "$image_uri" \
  apps/backend/api

push_output="$(docker push "$image_uri")"
pushed_digests=()
while IFS= read -r push_line; do
  if [[ "$push_line" =~ ^${CI_COMMIT_SHA}:\ digest:\ (sha256:[0-9a-f]{64})\ size:\ [0-9]+$ ]]; then
    pushed_digests+=("${BASH_REMATCH[1]}")
  fi
done <<<"$push_output"
unset push_output push_line
if ((${#pushed_digests[@]} != 1)); then
  echo "docker push did not report exactly one valid digest" >&2
  exit 78
fi
readonly image_digest="${pushed_digests[0]}"
unset pushed_digests

live_image_digest="$(aws ecr describe-images \
  --region "$expected_region" \
  --repository-name "$expected_repository" \
  --image-ids "imageTag=$CI_COMMIT_SHA" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
if ! [[ "$live_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "invalid ECR image digest for CI_COMMIT_SHA" >&2
  exit 78
fi
if [[ "$live_image_digest" != "$image_digest" ]]; then
  echo "ECR digest does not match docker push digest" >&2
  exit 78
fi
unset live_image_digest

readonly digest_image_uri="${registry}/${expected_repository}@${image_digest}"
docker pull "$digest_image_uri"
image_revision="$(docker image inspect "$digest_image_uri" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
if [[ "$image_revision" != "$CI_COMMIT_SHA" ]]; then
  echo "immutable image has unexpected source revision: $image_revision" >&2
  exit 1
fi
unset image_revision

dotenv_directory="$(dirname "$dotenv_file")"
dotenv_temp="$(mktemp "$dotenv_directory/.backend-image.env.tmp.XXXXXX")"
printf 'BACKEND_IMAGE_DIGEST=%s\n' "$image_digest" >"$dotenv_temp"
mv "$dotenv_temp" "$dotenv_file"
dotenv_temp=""
echo "published immutable image metadata for $CI_COMMIT_SHA"
