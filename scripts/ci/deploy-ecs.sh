#!/usr/bin/env bash
set -Eeuo pipefail
set +x

required_variables=(
  AWS_ACCOUNT_ID AWS_DEFAULT_REGION ECR_REPOSITORY ECS_CLUSTER ECS_SERVICE
  ECS_TASK_FAMILY ECS_CONTAINER_NAME ALB_NAME CI_COMMIT_SHA
)
for variable_name in "${required_variables[@]}"; do
  if [[ -z "${!variable_name:-}" ]]; then
    echo "required environment variable is missing: $variable_name" >&2
    exit 64
  fi
done

binding_names=(
  AWS_ACCOUNT_ID AWS_DEFAULT_REGION ECR_REPOSITORY ECS_CLUSTER ECS_SERVICE
  ECS_TASK_FAMILY ECS_CONTAINER_NAME ALB_NAME
)
binding_values=(
  248880318395 us-east-1 monitoracao-api data-ingestion-cluster monitoracao-api-service
  monitoracao-api-task monitoracao-api-container data-ingestion-alb
)
for ((binding_index = 0; binding_index < ${#binding_names[@]}; binding_index += 1)); do
  variable_name="${binding_names[$binding_index]}"
  expected_value="${binding_values[$binding_index]}"
  if [[ "${!variable_name}" != "$expected_value" ]]; then
    echo "unexpected deployment binding: $variable_name" >&2
    exit 64
  fi
done
if ! [[ "$CI_COMMIT_SHA" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "CI_COMMIT_SHA must be exactly 40 hexadecimal characters" >&2
  exit 64
fi

for command_name in aws jq curl mktemp rm sleep dirname mv bash; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "required command is unavailable: $command_name" >&2
    exit 69
  fi
done

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ ! -x "$script_directory/render-task-definition.sh" ]]; then
  echo "task definition renderer is unavailable or not executable" >&2
  exit 69
fi
image_uri="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_DEFAULT_REGION}.amazonaws.com/${ECR_REPOSITORY}:${CI_COMMIT_SHA}"
smoke_attempts="${SMOKE_ATTEMPTS:-12}"
smoke_delay_seconds="${SMOKE_DELAY_SECONDS:-5}"
if ! [[ "$smoke_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "SMOKE_ATTEMPTS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$smoke_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "SMOKE_DELAY_SECONDS must be a non-negative integer" >&2
  exit 64
fi

temporary_directory=""
cleanup_temporary_directory() {
  if [[ -n "$temporary_directory" ]]; then
    rm -rf "$temporary_directory"
  fi
}
temporary_directory="$(mktemp -d)"
trap cleanup_temporary_directory EXIT
umask 077
previous_task_definition=""
new_task_definition=""
rollback_required=false
forward_waiter_pid=""

cleanup_and_rollback() {
  local exit_status=$?
  local restored_task_definition=""
  local rollback_confirmed=true
  trap - EXIT INT TERM
  set +e
  if ((exit_status != 0)) && [[ "$rollback_required" == true && -n "$previous_task_definition" ]]; then
    echo "deployment failed; restoring previous task definition $previous_task_definition" >&2
    if ! aws ecs update-service \
      --region "$AWS_DEFAULT_REGION" \
      --cluster "$ECS_CLUSTER" \
      --service "$ECS_SERVICE" \
      --task-definition "$previous_task_definition" >/dev/null; then
      rollback_confirmed=false
    elif ! aws ecs wait services-stable \
      --region "$AWS_DEFAULT_REGION" \
      --cluster "$ECS_CLUSTER" \
      --services "$ECS_SERVICE"; then
      rollback_confirmed=false
    elif ! restored_task_definition="$(aws ecs describe-services \
      --region "$AWS_DEFAULT_REGION" \
      --cluster "$ECS_CLUSTER" \
      --services "$ECS_SERVICE" \
      --query 'services[0].taskDefinition' \
      --output text)"; then
      rollback_confirmed=false
    elif [[ "$restored_task_definition" != "$previous_task_definition" ]]; then
      rollback_confirmed=false
    fi
    if [[ "$rollback_confirmed" != true ]]; then
      echo "rollback could not be confirmed; expected stable task definition $previous_task_definition" >&2
    fi
  fi
  rm -rf "$temporary_directory"
  exit "$exit_status"
}
terminate_forward_waiter() {
  local exit_status="$1"
  trap - INT TERM
  if [[ -n "$forward_waiter_pid" ]]; then
    kill -TERM "$forward_waiter_pid" 2>/dev/null || true
    wait "$forward_waiter_pid" 2>/dev/null || true
    forward_waiter_pid=""
  fi
  exit "$exit_status"
}
trap cleanup_and_rollback EXIT
trap 'terminate_forward_waiter 130' INT
trap 'terminate_forward_waiter 143' TERM

identity_json="$(aws sts get-caller-identity --output json)"
actual_account="$(jq -r '.Account' <<<"$identity_json")"
caller_arn="$(jq -r '.Arn' <<<"$identity_json")"
if [[ "$actual_account" != "248880318395" ]]; then
  echo "unexpected AWS account: $actual_account (expected 248880318395)" >&2
  exit 77
fi

if [[ "$caller_arn" =~ ^arn:aws:sts::([0-9]{12}):assumed-role/(.+)/[^/]+$ ]]; then
  principal_policy_arn="arn:aws:iam::${BASH_REMATCH[1]}:role/${BASH_REMATCH[2]}"
elif [[ "$caller_arn" == arn:aws:iam::*:role/* || "$caller_arn" == arn:aws:iam::*:user/* ]]; then
  principal_policy_arn="$caller_arn"
else
  echo "unsupported AWS caller ARN for policy simulation: $caller_arn" >&2
  exit 77
fi

service_json="$temporary_directory/service.json"
aws ecs describe-services \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" \
  --query 'services[0]' \
  --output json >"$service_json"

service_status="$(jq -r '.status' "$service_json")"
controller="$(jq -r '.deploymentController.type' "$service_json")"
previous_task_definition="$(jq -r '.taskDefinition' "$service_json")"

if [[ "$service_status" != "ACTIVE" || "$controller" != "ECS" || "$previous_task_definition" == "None" ]]; then
  echo "ECS service is not an active rolling-deployment service" >&2
  exit 78
fi

image_digest="$(aws ecr describe-images \
  --region "$AWS_DEFAULT_REGION" \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids "imageTag=$CI_COMMIT_SHA" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
if [[ -z "$image_digest" || "$image_digest" == "None" ]]; then
  echo "ECR image could not be resolved for CI_COMMIT_SHA" >&2
  exit 78
fi

live_json="$temporary_directory/live.json"
register_json="$temporary_directory/register.json"
aws ecs describe-task-definition \
  --region "$AWS_DEFAULT_REGION" \
  --task-definition "$previous_task_definition" \
  --query taskDefinition \
  --output json >"$live_json"

live_family="$(jq -r '.family' "$live_json")"
if [[ "$live_family" != "$ECS_TASK_FAMILY" ]]; then
  echo "unexpected task definition family: $live_family" >&2
  exit 78
fi

target_group_count="$(jq --arg container "$ECS_CONTAINER_NAME" '[.loadBalancers[]? | select(.containerName == $container)] | length' "$service_json")"
if [[ "$target_group_count" != "1" ]]; then
  echo "expected exactly one target group for container $ECS_CONTAINER_NAME" >&2
  exit 78
fi
target_group_arn="$(jq -r --arg container "$ECS_CONTAINER_NAME" '.loadBalancers[] | select(.containerName == $container) | .targetGroupArn' "$service_json")"
target_group_json="$(aws elbv2 describe-target-groups \
  --region "$AWS_DEFAULT_REGION" \
  --target-group-arns "$target_group_arn" \
  --query 'TargetGroups[0]' \
  --output json)"
resolved_target_group_arn="$(jq -r '.TargetGroupArn' <<<"$target_group_json")"
if [[ "$resolved_target_group_arn" != "$target_group_arn" ]]; then
  echo "target group could not be resolved: $target_group_arn" >&2
  exit 78
fi

alb_json="$(aws elbv2 describe-load-balancers \
  --region "$AWS_DEFAULT_REGION" \
  --names "$ALB_NAME" \
  --query 'LoadBalancers[0]' \
  --output json)"
alb_arn="$(jq -r '.LoadBalancerArn' <<<"$alb_json")"
alb_dns="$(jq -r '.DNSName' <<<"$alb_json")"
if [[ -z "$alb_arn" || "$alb_arn" == "null" || -z "$alb_dns" || "$alb_dns" == "null" ]]; then
  echo "ALB could not be resolved: $ALB_NAME" >&2
  exit 78
fi
target_group_alb_count="$(jq --arg alb "$alb_arn" '[.LoadBalancerArns[]? | select(. == $alb)] | length' <<<"$target_group_json")"
if [[ "$target_group_alb_count" != "1" ]]; then
  echo "target group is not attached to ALB $ALB_NAME" >&2
  exit 78
fi

mapfile -t pass_role_arns < <(jq -r '[.taskRoleArn, .executionRoleArn] | map(select(. != null and . != "")) | unique[]' "$live_json")
for role_arn in "${pass_role_arns[@]}"; do
  decision="$(aws iam simulate-principal-policy \
    --policy-source-arn "$principal_policy_arn" \
    --action-names iam:PassRole \
    --resource-arns "$role_arn" \
    --query 'EvaluationResults[0].EvalDecision' \
    --output text)"
  if [[ "$decision" != "allowed" ]]; then
    echo "iam:PassRole is not allowed for required task role $role_arn" >&2
    exit 77
  fi
done

"$script_directory/render-task-definition.sh" \
  "$live_json" \
  "$register_json" \
  "$image_uri" \
  "$ECS_CONTAINER_NAME"

new_task_definition="$(aws ecs register-task-definition \
  --region "$AWS_DEFAULT_REGION" \
  --cli-input-json "file://$register_json" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

rollback_required=true

aws ecs update-service \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER" \
  --service "$ECS_SERVICE" \
  --task-definition "$new_task_definition" \
  --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100' >/dev/null

aws ecs wait services-stable \
  --region "$AWS_DEFAULT_REGION" \
  --cluster "$ECS_CLUSTER" \
  --services "$ECS_SERVICE" &
forward_waiter_pid=$!
if wait "$forward_waiter_pid"; then
  forward_waiter_pid=""
else
  waiter_status=$?
  forward_waiter_pid=""
  exit "$waiter_status"
fi

deployed_task_definition="$(aws ecs describe-services --region "$AWS_DEFAULT_REGION" --cluster "$ECS_CLUSTER" --services "$ECS_SERVICE" --query 'services[0].taskDefinition' --output text)"
if [[ "$deployed_task_definition" != "$new_task_definition" ]]; then
  echo "ECS stabilized on $deployed_task_definition instead of $new_task_definition" >&2
  false
fi

for ((attempt = 1; attempt <= smoke_attempts; attempt += 1)); do
  if response="$(curl --fail --silent --show-error --max-time 10 --write-out $'\n%{http_code}' "http://${alb_dns}/health")"; then
    http_status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if [[ "$http_status" == "200" ]] && jq -e -s 'length == 1 and .[0] == {"status":"ok"}' >/dev/null <<<"$body"; then
      echo "deployment healthy: $new_task_definition ($image_uri)"
      exit 0
    fi
  fi
  if ((attempt < smoke_attempts)); then
    sleep "$smoke_delay_seconds"
  fi
done

echo "public health check failed after $smoke_attempts attempts" >&2
false
