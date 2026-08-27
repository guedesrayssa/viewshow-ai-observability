#!/usr/bin/env bash
set -Eeuo pipefail
set +x

readonly account_id="248880318395"
readonly region="us-east-1"
readonly repository="monitoracao-api"
readonly cluster="data-ingestion-cluster"
readonly service="monitoracao-api-service"
readonly task_family="monitoracao-api-task"
readonly container_name="monitoracao-api-container"
readonly alb_name="data-ingestion-alb"

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
  "$account_id" "$region" "$repository" "$cluster" "$service"
  "$task_family" "$container_name" "$alb_name"
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
readonly image_metadata_file="backend-image.env"
if [[ ! -f "$image_metadata_file" || -L "$image_metadata_file" ]]; then
  echo "backend-image.env must be a regular non-symlink file" >&2
  exit 64
fi
mapfile -t image_metadata_lines <"$image_metadata_file"
if ((${#image_metadata_lines[@]} != 1)) \
  || ! [[ "${image_metadata_lines[0]}" =~ ^BACKEND_IMAGE_DIGEST=(sha256:[0-9a-f]{64})$ ]]; then
  echo "backend-image.env must contain exactly one valid digest line" >&2
  exit 64
fi
readonly backend_image_digest="${BASH_REMATCH[1]}"
unset image_metadata_lines
if [[ -n "${BACKEND_IMAGE_DIGEST+x}" && "$BACKEND_IMAGE_DIGEST" != "$backend_image_digest" ]]; then
  echo "BACKEND_IMAGE_DIGEST conflicts with backend-image.env" >&2
  exit 64
fi
unset BACKEND_IMAGE_DIGEST

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

for command_name in aws jq curl git mktemp rm sleep dirname mv bash cat; do
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

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ ! -x "$script_directory/render-task-definition.sh" ]]; then
  echo "task definition renderer is unavailable or not executable" >&2
  exit 69
fi
readonly registry="${account_id}.dkr.ecr.${region}.amazonaws.com"
readonly image_uri="${registry}/${repository}@${backend_image_digest}"
smoke_attempts="${SMOKE_ATTEMPTS:-12}"
smoke_delay_seconds="${SMOKE_DELAY_SECONDS:-5}"
waiter_grace_attempts="${WAITER_TERM_GRACE_ATTEMPTS:-5}"
waiter_grace_delay_seconds="${WAITER_TERM_GRACE_DELAY_SECONDS:-1}"
if ! [[ "$smoke_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "SMOKE_ATTEMPTS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$smoke_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "SMOKE_DELAY_SECONDS must be a non-negative integer" >&2
  exit 64
fi
if ! [[ "$waiter_grace_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "WAITER_TERM_GRACE_ATTEMPTS must be a positive integer" >&2
  exit 64
fi
if ! [[ "$waiter_grace_delay_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "WAITER_TERM_GRACE_DELAY_SECONDS must be a non-negative number" >&2
  exit 64
fi

temporary_directory=""
cleanup_temporary_directory() {
  if [[ -n "$temporary_directory" ]]; then
    rm -rf "$temporary_directory"
  fi
}
umask 077
temporary_directory="$(mktemp -d)"
trap cleanup_temporary_directory EXIT
previous_task_definition=""
new_task_definition=""
rollback_required=false
managed_waiter_pid=""

terminate_managed_waiter() {
  local waiter_pid="${managed_waiter_pid:-}"
  local attempt
  if [[ -z "$waiter_pid" ]]; then
    return 0
  fi
  kill -TERM "$waiter_pid" 2>/dev/null || true
  for ((attempt = 1; attempt <= waiter_grace_attempts; attempt += 1)); do
    if ! kill -0 "$waiter_pid" 2>/dev/null; then
      wait "$waiter_pid" 2>/dev/null || true
      managed_waiter_pid=""
      return 0
    fi
    sleep "$waiter_grace_delay_seconds"
  done
  kill -KILL "$waiter_pid" 2>/dev/null || true
  wait "$waiter_pid" 2>/dev/null || true
  managed_waiter_pid=""
}

wait_for_service_stability() {
  local waiter_status=0
  aws ecs wait services-stable \
    --region "$region" \
    --cluster "$cluster" \
    --services "$service" &
  managed_waiter_pid=$!
  if wait "$managed_waiter_pid"; then
    waiter_status=0
  else
    waiter_status=$?
  fi
  managed_waiter_pid=""
  return "$waiter_status"
}

handle_termination() {
  local exit_status="$1"
  trap - INT TERM
  terminate_managed_waiter
  exit "$exit_status"
}

cleanup_and_rollback() {
  local exit_status=$?
  local restored_task_definition=""
  local rollback_confirmed=true
  trap - EXIT
  set +e
  trap 'terminate_managed_waiter' INT TERM
  if ((exit_status != 0)) && [[ "$rollback_required" == true && -n "$previous_task_definition" ]]; then
    echo "deployment failed; restoring previous task definition $previous_task_definition" >&2
    if ! aws ecs update-service \
      --region "$region" \
      --cluster "$cluster" \
      --service "$service" \
      --task-definition "$previous_task_definition" >/dev/null; then
      rollback_confirmed=false
    elif ! wait_for_service_stability; then
      rollback_confirmed=false
    elif ! restored_task_definition="$(aws ecs describe-services \
      --region "$region" \
      --cluster "$cluster" \
      --services "$service" \
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
trap cleanup_and_rollback EXIT
trap 'handle_termination 130' INT
trap 'handle_termination 143' TERM

identity_json="$(aws sts get-caller-identity --output json)"
actual_account="$(jq -r '.Account' <<<"$identity_json")"
caller_arn="$(jq -r '.Arn' <<<"$identity_json")"
if [[ "$actual_account" != "$account_id" ]]; then
  echo "unexpected AWS account: $actual_account (expected $account_id)" >&2
  exit 77
fi
if ! [[ "$caller_arn" =~ ^arn:aws:sts::248880318395:assumed-role/voclabs/[^/]+$ ]]; then
  echo "unexpected AWS caller; expected the voclabs assumed role" >&2
  exit 77
fi
readonly principal_policy_arn="arn:aws:iam::${account_id}:role/voclabs"

if ! wait_for_service_stability; then
  echo "ECS service did not stabilize before rollback-base inspection" >&2
  exit 78
fi

service_json="$temporary_directory/service.json"
aws ecs describe-services \
  --region "$region" \
  --cluster "$cluster" \
  --services "$service" \
  --query 'services[0]' \
  --output json >"$service_json"

if ! jq -e '
  .status == "ACTIVE"
  and .deploymentController.type == "ECS"
  and (.desiredCount | type) == "number"
  and .desiredCount > 0
  and .pendingCount == 0
  and .runningCount == .desiredCount
  and .deploymentConfiguration.minimumHealthyPercent == 100
  and .deploymentConfiguration.maximumPercent == 200
  and (.deployments | length) == 1
  and .deployments[0].status == "PRIMARY"
  and .deployments[0].rolloutState == "COMPLETED"
  and .deployments[0].taskDefinition == .taskDefinition
' "$service_json" >/dev/null; then
  echo "ECS service is not a safe rollback base" >&2
  exit 78
fi
previous_task_definition="$(jq -r '.taskDefinition' "$service_json")"
if [[ -z "$previous_task_definition" || "$previous_task_definition" == "null" || "$previous_task_definition" == "None" ]]; then
  echo "ECS service is not a safe rollback base" >&2
  exit 78
fi

live_image_digest="$(aws ecr describe-images \
  --region "$region" \
  --repository-name "$repository" \
  --image-ids "imageTag=$CI_COMMIT_SHA" \
  --query 'imageDetails[0].imageDigest' \
  --output text)"
if ! [[ "$live_image_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "ECR image digest is missing or invalid for CI_COMMIT_SHA" >&2
  exit 78
fi
if [[ "$live_image_digest" != "$backend_image_digest" ]]; then
  echo "ECR digest does not match publication artifact" >&2
  exit 78
fi

live_json="$temporary_directory/live.json"
register_json="$temporary_directory/register.json"
aws ecs describe-task-definition \
  --region "$region" \
  --task-definition "$previous_task_definition" \
  --query taskDefinition \
  --output json >"$live_json"

live_family="$(jq -r '.family' "$live_json")"
if [[ "$live_family" != "$task_family" ]]; then
  echo "unexpected task definition family: $live_family" >&2
  exit 78
fi

target_group_count="$(jq --arg container "$container_name" '[.loadBalancers[]? | select(.containerName == $container)] | length' "$service_json")"
if [[ "$target_group_count" != "1" ]]; then
  echo "expected exactly one target group for container $container_name" >&2
  exit 78
fi
if ! jq -e --arg container "$container_name" '
  [.loadBalancers[]? | select(.containerName == $container)] as $matches
  | ($matches | length) == 1
    and ($matches[0].targetGroupArn | type) == "string"
    and ($matches[0].targetGroupArn | length) > 0
    and ($matches[0].containerPort | type) == "number"
    and $matches[0].containerPort > 0
' "$service_json" >/dev/null; then
  echo "service load-balancer tuple is incomplete or invalid" >&2
  exit 78
fi
baseline_load_balancers="$(jq -c '[.loadBalancers[]? | {targetGroupArn, containerName, containerPort}]' "$service_json")"
readonly baseline_load_balancers
target_group_arn="$(jq -r --arg container "$container_name" '.loadBalancers[] | select(.containerName == $container) | .targetGroupArn' "$service_json")"
target_group_json="$(aws elbv2 describe-target-groups \
  --region "$region" \
  --target-group-arns "$target_group_arn" \
  --query 'TargetGroups[0]' \
  --output json)"
resolved_target_group_arn="$(jq -r '.TargetGroupArn' <<<"$target_group_json")"
if [[ "$resolved_target_group_arn" != "$target_group_arn" ]]; then
  echo "target group could not be resolved: $target_group_arn" >&2
  exit 78
fi

alb_json="$(aws elbv2 describe-load-balancers \
  --region "$region" \
  --names "$alb_name" \
  --query 'LoadBalancers[0]' \
  --output json)"
alb_arn="$(jq -r '.LoadBalancerArn' <<<"$alb_json")"
alb_dns="$(jq -r '.DNSName' <<<"$alb_json")"
if [[ -z "$alb_arn" || "$alb_arn" == "null" || -z "$alb_dns" || "$alb_dns" == "null" ]]; then
  echo "ALB could not be resolved: $alb_name" >&2
  exit 78
fi
if ! jq -e '.State.Code == "active" and .Type == "application" and .Scheme == "internet-facing"' <<<"$alb_json" >/dev/null; then
  echo "ALB must be active, application, and internet-facing" >&2
  exit 78
fi
target_group_alb_count="$(jq --arg alb "$alb_arn" '[.LoadBalancerArns[]? | select(. == $alb)] | length' <<<"$target_group_json")"
if [[ "$target_group_alb_count" != "1" ]]; then
  echo "target group is not attached to ALB $alb_name" >&2
  exit 78
fi

listeners_json="$temporary_directory/listeners.json"
aws elbv2 describe-listeners \
  --region "$region" \
  --load-balancer-arn "$alb_arn" \
  --query Listeners \
  --output json >"$listeners_json"
mapfile -t http_listener_arns < <(jq -r '.[] | select(.Protocol == "HTTP" and .Port == 80) | .ListenerArn' "$listeners_json")
if ((${#http_listener_arns[@]} != 1)); then
  echo "ALB HTTP port 80 listener does not route /health to the service target group" >&2
  exit 78
fi
listener_arn="${http_listener_arns[0]}"
rules_json="$(aws elbv2 describe-rules \
  --region "$region" \
  --listener-arn "$listener_arn" \
  --query Rules \
  --output json)"
if ! jq -e --arg target "$target_group_arn" '
  def path_value_is_accepted_health:
    . == "/health" or . == "/health*" or . == "/*";
  def path_value_is_provably_not_health:
    if path_value_is_accepted_health then
      false
    elif (contains("*") or contains("?")) then
      (split("*")[0] | split("?")[0]) as $prefix
      | ("/health" | startswith($prefix) | not)
    else
      . != "/health"
    end;
  def path_value_may_match_health:
    path_value_is_provably_not_health | not;
  def may_intercept_health:
    .IsDefault == true
    or (
      [.Conditions[]? | select(.Field == "path-pattern")] as $path_conditions
      | ($path_conditions | length) == 0
      or all($path_conditions[];
        any((.Values // .PathPatternConfig.Values // [])[]?; path_value_may_match_health)
      )
    );
  def provably_matches_health:
    .IsDefault == true
    or (
      [.Conditions[]? | select(.Field == "path-pattern")] as $path_conditions
      | ($path_conditions | length) > 0
        and all(.Conditions[]?; .Field == "path-pattern")
        and all($path_conditions[];
          (.Values // .PathPatternConfig.Values // []) as $values
          | any($values[]?; path_value_is_accepted_health)
            and all($values[]?;
              path_value_is_accepted_health or path_value_is_provably_not_health
            )
        )
    );
  def forwards_exclusively_to_target:
    (.Actions | type) == "array"
    and (.Actions | length) == 1
    and .Actions[0].Type == "forward"
    and (
      (
        .Actions[0].TargetGroupArn == $target
        and ((.Actions[0].ForwardConfig.TargetGroups // []) | length) == 0
      )
      or (
        (.Actions[0].TargetGroupArn // "") == ""
        and (.Actions[0].ForwardConfig.TargetGroups | length) == 1
        and .Actions[0].ForwardConfig.TargetGroups[0].TargetGroupArn == $target
        and ((.Actions[0].ForwardConfig.TargetGroups[0].Weight // 1) > 0)
      )
    );
  (sort_by(if .IsDefault == true then 2147483647 else (.Priority | tonumber) end)
    | map(select(may_intercept_health))) as $effective_candidates
  | ($effective_candidates | length) > 0
    and ($effective_candidates[0] | provably_matches_health and forwards_exclusively_to_target)
' <<<"$rules_json" >/dev/null; then
  echo "effective ALB HTTP port 80 route is unsafe; ALB HTTP listener does not route /health exclusively to the service target group" >&2
  exit 78
fi

mapfile -t pass_role_arns < <(jq -r '[.taskRoleArn, .executionRoleArn] | map(select(. != null and . != "")) | unique[]' "$live_json")
for role_arn in "${pass_role_arns[@]}"; do
  decision="$(aws iam simulate-principal-policy \
    --policy-source-arn "$principal_policy_arn" \
    --action-names iam:PassRole \
    --resource-arns "$role_arn" \
    --context-entries 'ContextKeyName=iam:PassedToService,ContextKeyValues=ecs-tasks.amazonaws.com,ContextKeyType=string' \
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
  "$container_name"

revalidated_service_json="$temporary_directory/revalidated-service.json"
aws ecs describe-services \
  --region "$region" \
  --cluster "$cluster" \
  --services "$service" \
  --query 'services[0]' \
  --output json >"$revalidated_service_json"
if ! jq -e \
  --arg baseline "$previous_task_definition" \
  --argjson baseline_load_balancers "$baseline_load_balancers" '
  .status == "ACTIVE"
  and .deploymentController.type == "ECS"
  and (.desiredCount | type) == "number"
  and .desiredCount > 0
  and .pendingCount == 0
  and .runningCount == .desiredCount
  and .deploymentConfiguration.minimumHealthyPercent == 100
  and .deploymentConfiguration.maximumPercent == 200
  and .taskDefinition == $baseline
  and ([.loadBalancers[]? | {targetGroupArn, containerName, containerPort}] == $baseline_load_balancers)
  and (.deployments | length) == 1
  and .deployments[0].status == "PRIMARY"
  and .deployments[0].rolloutState == "COMPLETED"
  and .deployments[0].taskDefinition == $baseline
' "$revalidated_service_json" >/dev/null; then
  echo "rollback baseline changed before deployment mutation" >&2
  exit 78
fi

new_task_definition="$(aws ecs register-task-definition \
  --region "$region" \
  --cli-input-json "file://$register_json" \
  --query 'taskDefinition.taskDefinitionArn' \
  --output text)"

rollback_required=true

aws ecs update-service \
  --region "$region" \
  --cluster "$cluster" \
  --service "$service" \
  --task-definition "$new_task_definition" \
  --deployment-configuration 'deploymentCircuitBreaker={enable=true,rollback=true},maximumPercent=200,minimumHealthyPercent=100' >/dev/null

waiter_status=0
wait_for_service_stability || waiter_status=$?
if ((waiter_status != 0)); then
  exit "$waiter_status"
fi

deployed_task_definition="$(aws ecs describe-services \
  --region "$region" \
  --cluster "$cluster" \
  --services "$service" \
  --query 'services[0].taskDefinition' \
  --output text)"
if [[ "$deployed_task_definition" != "$new_task_definition" ]]; then
  echo "ECS stabilized on $deployed_task_definition instead of $new_task_definition" >&2
  false
fi

for ((attempt = 1; attempt <= smoke_attempts; attempt += 1)); do
  if response="$(curl --fail --silent --show-error --max-time 10 --write-out $'\n%{http_code}' "http://${alb_dns}/health")"; then
    http_status="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if [[ "$http_status" == "200" ]] && jq -e -s 'length == 1 and .[0] == {"status":"ok"}' >/dev/null <<<"$body"; then
      echo "deployment healthy: $new_task_definition (commit $CI_COMMIT_SHA, image $image_uri)"
      exit 0
    fi
  fi
  if ((attempt < smoke_attempts)); then
    sleep "$smoke_delay_seconds"
  fi
done

echo "public health check failed after $smoke_attempts attempts" >&2
false
