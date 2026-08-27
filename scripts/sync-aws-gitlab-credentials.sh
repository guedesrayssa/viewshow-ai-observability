#!/usr/bin/env bash
set -Eeuo pipefail
set +x

expected_account="248880318395"
region="us-east-1"
profile="${AWS_PROFILE:-default}"
gitlab_host="git.inteli.edu.br"
dry_run=false
target_keys=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN)
credentials_json=""
access_key=""
secret_key=""
session_token=""

cleanup_credentials() {
  unset credentials_json access_key secret_key session_token
}
trap cleanup_credentials EXIT

fail() {
  echo "$1" >&2
  exit "${2:-1}"
}

glab_safe() {
  GLAB_DEBUG=false GLAB_DEBUG_HTTP=false glab "$@"
}

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
if [[ "$#" -ne 0 ]]; then
  fail "usage: sync-aws-gitlab-credentials.sh [--dry-run]" 64
fi

for command_name in aws jq glab git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    fail "required command not found: $command_name" 69
  fi
done

origin_url="$(git remote get-url origin)"
if [[ "$origin_url" != "https://$gitlab_host/"* || "$origin_url" == *"@"* || "$origin_url" == *"?"* || "$origin_url" == *"#"* ]]; then
  fail "unsafe Git origin URL; use a credential-free HTTPS origin for $gitlab_host"
fi
unset origin_url

glab_safe auth status --hostname "$gitlab_host" >/dev/null 2>&1

repository_json="$(glab_safe repo view --output json)"
project_id="$(jq -er '.id | tostring | select(test("^[0-9]+$"))' <<<"$repository_json")"
repository_path="$(jq -er '.path_with_namespace | select(type == "string")' <<<"$repository_json")"
repository_web_url="$(jq -er '.web_url | select(type == "string")' <<<"$repository_json")"
unset repository_json

if [[ -z "$repository_path" || "$repository_path" == /* || "$repository_path" == *"//"* || "$repository_path" == *".."* || "$repository_path" == *"@"* || "$repository_path" == *"?"* || "$repository_path" == *"#"* ]]; then
  fail "invalid GitLab repository path"
fi
repository_url="https://$gitlab_host/$repository_path"
if [[ "$repository_web_url" != "$repository_url" ]]; then
  fail "GitLab repository URL does not match the required host"
fi
unset repository_web_url repository_path

variable_metadata="$(
  glab_safe api "projects/$project_id/variables?per_page=100" |
    jq -r '
      if type != "array" then
        error("GitLab variable metadata must be an array")
      else
        .[]
        | select(.key == "AWS_ACCESS_KEY_ID" or .key == "AWS_SECRET_ACCESS_KEY" or .key == "AWS_SESSION_TOKEN")
        | if ((.environment_scope | type) != "string" or (.hidden | type) != "boolean") then
            error("GitLab variable metadata is incomplete")
          else
            [.key, .environment_scope, (.hidden | tostring)] | @tsv
          end
      end
    '
)"

declare -A variable_modes
for key in "${target_keys[@]}"; do
  mapfile -t matching_metadata < <(awk -F '\t' -v key="$key" '$1 == key { print }' <<<"$variable_metadata")
  if [[ "${#matching_metadata[@]}" -eq 0 ]]; then
    variable_modes["$key"]="set"
    continue
  fi
  if [[ "${#matching_metadata[@]}" -ne 1 ]]; then
    fail "ambiguous GitLab variable metadata for $key"
  fi

  IFS=$'\t' read -r metadata_key metadata_scope metadata_hidden <<<"${matching_metadata[0]}"
  if [[ "$metadata_key" != "$key" || "$metadata_scope" != "*" ]]; then
    fail "ambiguous GitLab variable metadata for $key"
  fi
  if [[ "$metadata_hidden" != "true" ]]; then
    fail "$key must already be hidden before it can be updated"
  fi
  variable_modes["$key"]="update"
done
unset variable_metadata matching_metadata metadata_key metadata_scope metadata_hidden

account="$(aws --profile "$profile" sts get-caller-identity --query Account --output text)"
if [[ "$account" != "$expected_account" ]]; then
  fail "unexpected AWS account: $account (expected $expected_account)" 77
fi
unset account

ecr_repository="$(aws --profile "$profile" ecr describe-repositories \
  --region "$region" \
  --repository-names monitoracao-api \
  --query 'repositories[0].repositoryName' \
  --output text)"
if [[ "$ecr_repository" != "monitoracao-api" ]]; then
  fail "unexpected ECR repository result"
fi
unset ecr_repository

ecs_result="$(aws --profile "$profile" ecs describe-services \
  --region "$region" \
  --cluster data-ingestion-cluster \
  --services monitoracao-api-service \
  --query 'services[0].[status,length(failures)]' \
  --output text)"
if [[ "$ecs_result" != $'ACTIVE\t0' ]]; then
  fail "ECS service is not exactly ACTIVE with zero failures"
fi
unset ecs_result

credentials_json="$(aws configure export-credentials --profile "$profile" --format process)"
access_key="$(jq -er '.AccessKeyId' <<<"$credentials_json")"
secret_key="$(jq -er '.SecretAccessKey' <<<"$credentials_json")"
session_token="$(jq -er '.SessionToken' <<<"$credentials_json")"
unset credentials_json

if [[ "$dry_run" == true ]]; then
  cleanup_credentials
  echo "dry-run validated AWS account, ECR, ECS, GitLab authentication, and variable targets"
  exit 0
fi

set_variable() {
  local key="$1"
  local value="$2"

  if [[ "${variable_modes[$key]}" == "set" ]]; then
    printf '%s' "$value" | glab_safe variable set "$key" \
      --repo "$repository_url" \
      --protected \
      --masked \
      --hidden \
      --raw
  else
    printf '%s' "$value" | glab_safe variable update "$key" \
      --repo "$repository_url" \
      --protected \
      --masked \
      --raw
  fi
}

completed_keys=()
for key in "${target_keys[@]}"; do
  case "$key" in
    AWS_ACCESS_KEY_ID) value="$access_key" ;;
    AWS_SECRET_ACCESS_KEY) value="$secret_key" ;;
    AWS_SESSION_TOKEN) value="$session_token" ;;
  esac

  if set_variable "$key" "$value"; then
    completed_keys+=("$key")
    continue
  fi

  if [[ "${#completed_keys[@]}" -eq 0 ]]; then
    fail "GitLab variable update failed before any updates; failed: $key. Resolve the failure and re-run the synchronizer."
  fi
  completed_list="$(printf '%s, ' "${completed_keys[@]}")"
  completed_list="${completed_list%, }"
  fail "partial GitLab variable update; completed: $completed_list; failed: $key. Resolve the failure and re-run the synchronizer."
done
unset value completed_list completed_keys

echo "updated protected AWS variables"
