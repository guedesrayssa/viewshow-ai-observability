#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OBSERVABILITY_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

REGION="${AWS_REGION:-us-east-1}"
INSTANCE_NAME="${INSTANCE_NAME:-view-show-observabilidade}"
SECURITY_GROUP_NAME="${SECURITY_GROUP_NAME:-view-show-observabilidade-sg}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"
PASSWORD_FILE="${PASSWORD_FILE:-${HOME}/.view-show-grafana-admin-password}"

: "${GRAFANA_CIDR_ACESSO:?Defina GRAFANA_CIDR_ACESSO com o IPv4 autorizado, por exemplo 203.0.113.10/32}"

command -v aws >/dev/null || { echo "AWS CLI nao encontrado." >&2; exit 1; }
command -v gzip >/dev/null || { echo "gzip nao encontrado." >&2; exit 1; }

if [[ ! -f "${PASSWORD_FILE}" ]]; then
  umask 077
  openssl rand -hex 16 >"${PASSWORD_FILE}"
fi
GRAFANA_ADMIN_PASSWORD="$(<"${PASSWORD_FILE}")"

encode_file() {
  gzip -9 -c "$1" | base64 | tr -d '\n'
}

escape_sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf -- "${WORK_DIR}"' EXIT

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
VPC_ID="$(aws ec2 describe-vpcs --region "${REGION}" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)"
SUBNET_ID="$(aws ec2 describe-subnets --region "${REGION}" --filters Name=vpc-id,Values="${VPC_ID}" Name=default-for-az,Values=true --query 'sort_by(Subnets,&AvailabilityZone)[0].SubnetId' --output text)"
AMI_ID="$(aws ssm get-parameter --region "${REGION}" --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"

sed \
  -e "s|\${account_id}|$(escape_sed_replacement "${ACCOUNT_ID}")|g" \
  -e "s|\${aws_region}|$(escape_sed_replacement "${REGION}")|g" \
  -e 's|${cluster_name}|data-ingestion-cluster|g' \
  -e 's|${service_name}|monitoracao-api-service|g' \
  -e 's|${load_balancer}|data-ingestion-alb|g' \
  -e 's|${target_group}|monitoracao-api-tg|g' \
  -e 's|${operational_table}|monitoracao-operacional|g' \
  -e 's|${log_group}|/ecs/monitoracao-api|g' \
  "${SCRIPT_DIR}/view-show-aws.json.tftpl" >"${WORK_DIR}/view-show-aws.json"

COMPOSE_GZIP="$(encode_file "${SCRIPT_DIR}/docker-compose.yml")"
PROMETHEUS_GZIP="$(encode_file "${SCRIPT_DIR}/prometheus.yml")"
LOKI_GZIP="$(encode_file "${OBSERVABILITY_DIR}/loki/loki-config.yml")"
TEMPO_GZIP="$(encode_file "${OBSERVABILITY_DIR}/tempo/tempo.yml")"
DATASOURCES_GZIP="$(encode_file "${OBSERVABILITY_DIR}/grafana/provisioning/datasources/datasources.yml")"
CLOUDWATCH_DATASOURCE_GZIP="$(encode_file "${SCRIPT_DIR}/cloudwatch-datasource.yml")"
DASHBOARD_PROVIDER_GZIP="$(encode_file "${SCRIPT_DIR}/dashboard-provider.yml")"
DASHBOARD_GZIP="$(encode_file "${WORK_DIR}/view-show-aws.json")"
PASSWORD_BASE64="$(printf '%s' "${GRAFANA_ADMIN_PASSWORD}" | base64 | tr -d '\n')"

sed \
  -e "s|\${aws_region}|$(escape_sed_replacement "${REGION}")|g" \
  -e "s|\${grafana_password_base64}|${PASSWORD_BASE64}|g" \
  -e "s|\${compose_gzip}|${COMPOSE_GZIP}|g" \
  -e "s|\${prometheus_gzip}|${PROMETHEUS_GZIP}|g" \
  -e "s|\${loki_gzip}|${LOKI_GZIP}|g" \
  -e "s|\${tempo_gzip}|${TEMPO_GZIP}|g" \
  -e "s|\${datasources_gzip}|${DATASOURCES_GZIP}|g" \
  -e "s|\${cloudwatch_datasource_gzip}|${CLOUDWATCH_DATASOURCE_GZIP}|g" \
  -e "s|\${dashboard_provider_gzip}|${DASHBOARD_PROVIDER_GZIP}|g" \
  -e "s|\${dashboard_gzip}|${DASHBOARD_GZIP}|g" \
  -e 's/$${/${/g' \
  "${SCRIPT_DIR}/user-data.sh.tftpl" >"${WORK_DIR}/user-data.sh"

if (( $(wc -c <"${WORK_DIR}/user-data.sh") > 16384 )); then
  echo "User data excede o limite de 16 KiB da EC2." >&2
  exit 1
fi

SECURITY_GROUP_ID="$(aws ec2 describe-security-groups --region "${REGION}" --filters Name=vpc-id,Values="${VPC_ID}" Name=group-name,Values="${SECURITY_GROUP_NAME}" --query 'SecurityGroups[0].GroupId' --output text)"
if [[ -z "${SECURITY_GROUP_ID}" || "${SECURITY_GROUP_ID}" == "None" ]]; then
  SECURITY_GROUP_ID="$(aws ec2 create-security-group --region "${REGION}" --group-name "${SECURITY_GROUP_NAME}" --description 'Grafana do View Show; acesso web restrito' --vpc-id "${VPC_ID}" --query GroupId --output text)"
  aws ec2 create-tags --region "${REGION}" --resources "${SECURITY_GROUP_ID}" --tags Key=Name,Value="${SECURITY_GROUP_NAME}" Key=Projeto,Value=view-show Key=Camada,Value=observabilidade Key=ManagedBy,Value=deploy-learner-lab
fi

aws ec2 authorize-security-group-ingress \
  --region "${REGION}" \
  --group-id "${SECURITY_GROUP_ID}" \
  --ip-permissions "IpProtocol=tcp,FromPort=3000,ToPort=3000,IpRanges=[{CidrIp=${GRAFANA_CIDR_ACESSO},Description='Grafana View Show'}]" \
  >/dev/null 2>&1 || true

INSTANCE_ID="$(aws ec2 describe-instances --region "${REGION}" --filters Name=tag:Name,Values="${INSTANCE_NAME}" Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)"
if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  INSTANCE_ID="$(aws ec2 run-instances \
    --region "${REGION}" \
    --image-id "${AMI_ID}" \
    --instance-type "${INSTANCE_TYPE}" \
    --subnet-id "${SUBNET_ID}" \
    --security-group-ids "${SECURITY_GROUP_ID}" \
    --iam-instance-profile Name=LabInstanceProfile \
    --associate-public-ip-address \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=30,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}},{Key=Projeto,Value=view-show},{Key=Camada,Value=observabilidade},{Key=ManagedBy,Value=deploy-learner-lab}]" \
    --user-data "file://${WORK_DIR}/user-data.sh" \
    --query 'Instances[0].InstanceId' \
    --output text)"
else
  aws ec2 start-instances --region "${REGION}" --instance-ids "${INSTANCE_ID}" >/dev/null 2>&1 || true
fi

echo "Aguardando a instancia ${INSTANCE_ID}..."
aws ec2 wait instance-status-ok --region "${REGION}" --instance-ids "${INSTANCE_ID}"

PUBLIC_DNS="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${INSTANCE_ID}" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)"

for attempt in $(seq 1 36); do
  COMMAND_ID="$(aws ssm send-command --region "${REGION}" --instance-ids "${INSTANCE_ID}" --document-name AWS-RunShellScript --parameters 'commands=["curl --fail --silent http://127.0.0.1:3000/api/health"]' --query Command.CommandId --output text 2>/dev/null || true)"
  if [[ -n "${COMMAND_ID}" ]] && aws ssm wait command-executed --region "${REGION}" --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" 2>/dev/null; then
    HEALTH="$(aws ssm get-command-invocation --region "${REGION}" --command-id "${COMMAND_ID}" --instance-id "${INSTANCE_ID}" --query StandardOutputContent --output text)"
    if grep -Eq '"database"[[:space:]]*:[[:space:]]*"ok"' <<<"${HEALTH}"; then
      echo "Grafana saudavel: http://${PUBLIC_DNS}:3000"
      echo "Usuario: admin"
      echo "Senha: ${PASSWORD_FILE}"
      exit 0
    fi
  fi
  sleep 10
done

echo "A stack nao ficou saudavel no prazo. Instancia: ${INSTANCE_ID}" >&2
exit 1
