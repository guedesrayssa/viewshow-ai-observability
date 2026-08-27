#!/usr/bin/env bash
set -Eeuo pipefail
set +x

expected_account="248880318395"
region="us-east-1"
profile="${AWS_PROFILE:-default}"
dry_run=false

if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
if [[ "$#" -ne 0 ]]; then
  echo "usage: sync-aws-gitlab-credentials.sh [--dry-run]" >&2
  exit 64
fi

for command_name in aws jq glab git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command not found: $command_name" >&2
    exit 69
  fi
done

repository_url="$(git remote get-url origin)"
glab auth status --hostname git.inteli.edu.br >/dev/null 2>&1

account="$(aws --profile "$profile" sts get-caller-identity --query Account --output text)"
if [[ "$account" != "$expected_account" ]]; then
  echo "unexpected AWS account: $account (expected $expected_account)" >&2
  exit 77
fi

aws --profile "$profile" ecr describe-repositories \
  --region "$region" \
  --repository-names monitoracao-api \
  --query 'repositories[0].repositoryName' \
  --output text >/dev/null

aws --profile "$profile" ecs describe-services \
  --region "$region" \
  --cluster data-ingestion-cluster \
  --services monitoracao-api-service \
  --query 'services[0].status' \
  --output text >/dev/null

credentials_json="$(aws configure export-credentials --profile "$profile" --format process)"
access_key="$(jq -er '.AccessKeyId' <<<"$credentials_json")"
secret_key="$(jq -er '.SecretAccessKey' <<<"$credentials_json")"
session_token="$(jq -er '.SessionToken' <<<"$credentials_json")"
unset credentials_json

if [[ "$dry_run" == true ]]; then
  unset access_key secret_key session_token
  echo "dry-run validated AWS account, ECR, ECS, GitLab authentication, and variable targets"
  exit 0
fi

set_variable() {
  local key="$1"
  local value="$2"
  printf '%s' "$value" | glab variable set "$key" \
    --repo "$repository_url" \
    --protected \
    --masked \
    --hidden \
    --raw
}

set_variable AWS_ACCESS_KEY_ID "$access_key"
set_variable AWS_SECRET_ACCESS_KEY "$secret_key"
set_variable AWS_SESSION_TOKEN "$session_token"

unset access_key secret_key session_token
echo "updated protected AWS variables for $repository_url"
