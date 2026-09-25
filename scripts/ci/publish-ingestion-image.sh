#!/usr/bin/env bash
set -Eeuo pipefail
set +x

# This publisher has fixed ingestion bindings. It deliberately does not share
# the API publisher: its repository, build context and dotenv contract are
# distinct delivery boundaries.
# A conta não é literal: ela vem de quem declara o alvo. A verificação que
# importa é a credencial em vigor pertencer à MESMA conta do alvo declarado, o
# que vale em qualquer conta do Learner Lab. A exigência do papel voclabs fica.
readonly expected_region="us-east-1"
readonly expected_repository="view-show-ingestion"

required_variables=(AWS_ACCOUNT_ID AWS_DEFAULT_REGION ECR_REPOSITORY CI_COMMIT_SHA)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "required environment variable is missing: $variable_name" >&2
    exit 64
  fi
done

if [[ "$AWS_DEFAULT_REGION" != "$expected_region" || "$ECR_REPOSITORY" != "$expected_repository" ]]; then
  echo "unexpected ingestion publication binding" >&2
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

if [[ "$(git rev-parse --verify HEAD)" != "$CI_COMMIT_SHA" ]]; then
  echo "CI_COMMIT_SHA does not match checked-out HEAD" >&2
  exit 64
fi

identity_json="$(aws sts get-caller-identity --output json)"
actual_account="$(jq -r '.Account' <<<"$identity_json")"
caller_arn="$(jq -r '.Arn' <<<"$identity_json")"
if [[ "$actual_account" != "$AWS_ACCOUNT_ID" ]] || ! [[ "$caller_arn" =~ ^arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/voclabs/[^/]+$ ]]; then
  echo "unexpected AWS caller for ingestion publication" >&2
  exit 77
fi
unset identity_json actual_account caller_arn

readonly registry="${AWS_ACCOUNT_ID}.dkr.ecr.${expected_region}.amazonaws.com"
readonly image_uri="${registry}/${expected_repository}:${CI_COMMIT_SHA}"
dotenv_file="${INGESTION_IMAGE_ENV_FILE:-ingestion-image.env}"
dotenv_temp=""
work_directory=""
cleanup() {
  [[ -z "$dotenv_temp" ]] || rm -f "$dotenv_temp"
  [[ -z "$work_directory" ]] || rm -rf "$work_directory"
}
trap cleanup EXIT
umask 077
work_directory="$(mktemp -d)"
readonly build_iid_file="$work_directory/build.iid"

aws ecr get-login-password --region "$expected_region" |
  docker login --username AWS --password-stdin "$registry"

# The repository is immutable, so an immutable SHA tag is the idempotency
# key; do not try to publish a mutable registry cache to it.
docker buildx build \
  --platform linux/amd64 \
  --load \
  --iidfile "$build_iid_file" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --tag "$image_uri" \
  apps/backend/ingestion-data

mapfile -t build_image_ids <"$build_iid_file"
if ((${#build_image_ids[@]} != 1)) || ! [[ "${build_image_ids[0]}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "docker build did not report exactly one valid local image ID" >&2
  exit 78
fi
readonly local_image_id="${build_image_ids[0]}"
unset build_image_ids

describe_sha_tag_digest() {
  local stderr_file="$work_directory/ecr-describe.stderr"
  local result=""
  local digest=""
  local media_type=""
  local status=0
  if result="$(aws ecr describe-images \
    --region "$expected_region" \
    --repository-name "$expected_repository" \
    --image-ids "imageTag=$CI_COMMIT_SHA" \
    --query 'imageDetails[0].{digest:imageDigest,mediaType:imageManifestMediaType}' \
    --output json 2>"$stderr_file")"; then
    digest="$(jq -er '.digest | select(type == "string")' <<<"$result")" || return 78
    media_type="$(jq -er '.mediaType | select(type == "string")' <<<"$result")" || return 78
    if ! [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || [[ "$media_type" != "application/vnd.docker.distribution.manifest.v2+json" && "$media_type" != "application/vnd.oci.image.manifest.v1+json" ]]; then
      echo "invalid immutable ingestion image manifest" >&2
      return 78
    fi
    printf '%s\n' "$digest"
    return 0
  else
    status=$?
  fi
  if [[ "$(<"$stderr_file")" == *ImageNotFoundException* ]]; then
    return 3
  fi
  if [[ -r "$stderr_file" ]]; then
    printf '%s\n' "$(<"$stderr_file")" >&2
  fi
  return "$status"
}

verify_digest_matches_local_build() {
  local candidate_digest="$1"
  local digest_image_uri="${registry}/${expected_repository}@${candidate_digest}"
  local local_identity=""
  local remote_identity=""
  local platform=""
  local revision=""
  docker pull "$digest_image_uri" >/dev/null
  platform="$(docker image inspect "$digest_image_uri" --format '{{.Os}}/{{.Architecture}}')"
  local_identity="$(docker image inspect "$local_image_id" --format '{{.Id}} {{json .RootFS.Layers}}')"
  remote_identity="$(docker image inspect "$digest_image_uri" --format '{{.Id}} {{json .RootFS.Layers}}')"
  revision="$(docker image inspect "$digest_image_uri" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  if [[ "$platform" != "linux/amd64" || -z "$local_identity" || "$remote_identity" != "$local_identity" || "$revision" != "$CI_COMMIT_SHA" ]]; then
    echo "immutable ingestion SHA tag does not identify the local build" >&2
    return 78
  fi
}

verify_stable_existing_digest() {
  local candidate_digest="$1"
  local current_digest=""
  verify_digest_matches_local_build "$candidate_digest"
  current_digest="$(describe_sha_tag_digest)" || return $?
  if [[ "$current_digest" != "$candidate_digest" ]]; then
    echo "ingestion SHA tag changed during verification" >&2
    return 78
  fi
}

verified_digest=""
if existing_digest="$(describe_sha_tag_digest)"; then
  verify_stable_existing_digest "$existing_digest"
  verified_digest="$existing_digest"
else
  describe_status=$?
  if ((describe_status != 3)); then
    exit "$describe_status"
  fi
fi

if [[ -z "$verified_digest" ]]; then
  # Recheck just before push: another runner may have produced this immutable tag.
  if existing_digest="$(describe_sha_tag_digest)"; then
    verify_stable_existing_digest "$existing_digest"
    verified_digest="$existing_digest"
  else
    describe_status=$?
    if ((describe_status != 3)); then
      exit "$describe_status"
    fi
  fi
fi

if [[ -z "$verified_digest" ]]; then
  push_output="$(docker push "$image_uri")"
  pushed_digests=()
  while IFS= read -r push_line; do
    if [[ "$push_line" =~ ^${CI_COMMIT_SHA}:\ digest:\ (sha256:[0-9a-f]{64})\ size:\ [0-9]+$ ]]; then
      pushed_digests+=("${BASH_REMATCH[1]}")
    fi
  done <<<"$push_output"
  if ((${#pushed_digests[@]} != 1)); then
    echo "docker push did not report exactly one valid digest" >&2
    exit 78
  fi
  verified_digest="${pushed_digests[0]}"
  live_digest="$(describe_sha_tag_digest)" || {
    echo "ECR did not resolve the ingestion SHA tag after docker push" >&2
    exit 78
  }
  if [[ "$live_digest" != "$verified_digest" ]]; then
    echo "ECR digest does not match docker push digest" >&2
    exit 78
  fi
  verify_digest_matches_local_build "$verified_digest"
fi

dotenv_directory="$(dirname "$dotenv_file")"
dotenv_temp="$(mktemp "$dotenv_directory/.ingestion-image.env.tmp.XXXXXX")"
printf 'INGESTION_IMAGE_DIGEST=%s\n' "$verified_digest" >"$dotenv_temp"
mv "$dotenv_temp" "$dotenv_file"
dotenv_temp=""
echo "published immutable ingestion image metadata for $CI_COMMIT_SHA"
