#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly expected_account="248880318395"
readonly expected_region="us-east-1"
readonly expected_repository="g05-s3-api"

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
work_directory=""
cleanup() {
  if [[ -n "$dotenv_temp" ]]; then
    rm -f "$dotenv_temp"
  fi
  if [[ -n "$work_directory" ]]; then
    rm -rf "$work_directory"
  fi
}
trap cleanup EXIT
umask 077
work_directory="$(mktemp -d)"
readonly build_iid_file="$work_directory/build.iid"

aws ecr get-login-password --region "$expected_region" |
  docker login --username AWS --password-stdin "$registry"

docker buildx build \
  --platform linux/amd64 \
  --load \
  --iidfile "$build_iid_file" \
  --cache-from "type=registry,ref=$cache_uri" \
  --cache-to "type=registry,ref=$cache_uri,mode=max,image-manifest=true,oci-mediatypes=true" \
  --label "org.opencontainers.image.revision=$CI_COMMIT_SHA" \
  --tag "$image_uri" \
  apps/backend/api

build_image_ids=()
mapfile -t build_image_ids <"$build_iid_file"
if ((${#build_image_ids[@]} != 1)) \
  || ! [[ "${build_image_ids[0]}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "docker build did not report exactly one valid local image ID" >&2
  exit 78
fi
readonly local_image_id="${build_image_ids[0]}"
unset build_image_ids

describe_sha_tag_digest() {
  local describe_error_file="$work_directory/ecr-describe.stderr"
  local describe_error=""
  local describe_output=""
  local describe_status=0
  local image_digest=""
  local image_media_type=""
  if describe_output="$(aws ecr describe-images \
    --region "$expected_region" \
    --repository-name "$expected_repository" \
    --image-ids "imageTag=$CI_COMMIT_SHA" \
    --query 'imageDetails[0].{digest:imageDigest,mediaType:imageManifestMediaType}' \
    --output json 2>"$describe_error_file")"; then
    if ! image_digest="$(jq -er '.digest | select(type == "string")' <<<"$describe_output")" \
      || ! [[ "$image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "invalid ECR image digest for CI_COMMIT_SHA" >&2
      return 78
    fi
    if ! image_media_type="$(jq -er '.mediaType | select(type == "string")' <<<"$describe_output")"; then
      echo "ECR digest is not a supported single-platform image manifest" >&2
      return 78
    fi
    case "$image_media_type" in
      application/vnd.docker.distribution.manifest.v2+json | application/vnd.oci.image.manifest.v1+json)
        ;;
      *)
        echo "ECR digest is not a supported single-platform image manifest: $image_media_type" >&2
        return 78
        ;;
    esac
    printf '%s\n' "$image_digest"
    return 0
  else
    describe_status=$?
  fi
  if [[ -f "$describe_error_file" ]]; then
    describe_error="$(<"$describe_error_file")"
  fi
  if [[ "$describe_error" == *ImageNotFoundException* ]]; then
    return 3
  fi
  printf '%s\n' "$describe_error" >&2
  return "$describe_status"
}

verify_digest_matches_local_build() {
  local candidate_digest="$1"
  local candidate_description="$2"
  local digest_image_uri="${registry}/${expected_repository}@${candidate_digest}"
  local local_identity=""
  local remote_identity=""
  local remote_platform=""
  local image_revision=""
  docker pull "$digest_image_uri" >/dev/null
  remote_platform="$(docker image inspect "$digest_image_uri" --format '{{.Os}}/{{.Architecture}}')"
  if [[ "$remote_platform" != "linux/amd64" ]]; then
    echo "immutable image platform is $remote_platform; expected linux/amd64" >&2
    return 78
  fi
  local_identity="$(docker image inspect "$local_image_id" --format '{{.Id}} {{json .RootFS.Layers}}')"
  remote_identity="$(docker image inspect "$digest_image_uri" --format '{{.Id}} {{json .RootFS.Layers}}')"
  if [[ -z "$local_identity" || "$remote_identity" != "$local_identity" ]]; then
    echo "$candidate_description does not identify the local build" >&2
    return 78
  fi
  image_revision="$(docker image inspect "$digest_image_uri" --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
  if [[ "$image_revision" != "$CI_COMMIT_SHA" ]]; then
    echo "immutable image has unexpected source revision: $image_revision" >&2
    return 1
  fi
}

verified_image_digest=""
verify_existing_sha_tag() {
  local candidate_digest="$1"
  local current_digest=""
  local describe_status=0
  verify_digest_matches_local_build "$candidate_digest" "existing SHA tag"
  if current_digest="$(describe_sha_tag_digest)"; then
    :
  else
    describe_status=$?
    echo "SHA tag changed during verification" >&2
    return "$describe_status"
  fi
  if [[ "$current_digest" != "$candidate_digest" ]]; then
    echo "SHA tag changed during verification" >&2
    return 78
  fi
  verified_image_digest="$candidate_digest"
}

existing_digest=""
describe_status=0
if existing_digest="$(describe_sha_tag_digest)"; then
  verify_existing_sha_tag "$existing_digest"
else
  describe_status=$?
  if ((describe_status != 3)); then
    exit "$describe_status"
  fi
fi

if [[ -z "$verified_image_digest" ]]; then
  if existing_digest="$(describe_sha_tag_digest)"; then
    verify_existing_sha_tag "$existing_digest"
  else
    describe_status=$?
    if ((describe_status != 3)); then
      exit "$describe_status"
    fi
  fi
fi

if [[ -z "$verified_image_digest" ]]; then
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
  pushed_digest="${pushed_digests[0]}"
  unset pushed_digests

  if ! live_image_digest="$(describe_sha_tag_digest)"; then
    echo "ECR did not resolve the SHA tag after docker push" >&2
    exit 78
  fi
  if [[ "$live_image_digest" != "$pushed_digest" ]]; then
    echo "ECR digest does not match docker push digest" >&2
    exit 78
  fi
  verify_digest_matches_local_build "$pushed_digest" "pushed digest"
  verified_image_digest="$pushed_digest"
fi
readonly image_digest="$verified_image_digest"

dotenv_directory="$(dirname "$dotenv_file")"
dotenv_temp="$(mktemp "$dotenv_directory/.backend-image.env.tmp.XXXXXX")"
printf 'BACKEND_IMAGE_DIGEST=%s\n' "$image_digest" >"$dotenv_temp"
mv "$dotenv_temp" "$dotenv_file"
dotenv_temp=""
echo "published immutable image metadata for $CI_COMMIT_SHA"
