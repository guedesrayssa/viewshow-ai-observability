#!/usr/bin/env bash
# Injeção e reversão das falhas dos testes RS-01 a RS-05 e coleta das
# métricas de fila — ver artefatos/sprint5/testes-carga-ingestao.md.
#
# uso:  ./ingestao-falhas.sh <comando> [argumentos]
#
#   recursos                         nomes resolvidos e variáveis para o publicador
#   agenda <export|ingest> <ligar|desligar>
#                                    liga/desliga o agendamento incremental (RS-01)
#   rodar-ingestao                   dispara uma execução de ingest-incremental agora
#   parar-tasks <import|ingest>      interrompe as tasks em execução (RS-02b, RS-04)
#   s3-negar | s3-restaurar          nega/restaura o upload no staging de importação (RS-02a)
#   filas                            profundidade atual da FIFO incremental e da DLQ
#   dlq-espiar                       lê a mensagem da DLQ sem removê-la (RS-05)
#   metricas-fila <inicio> <fim> <saida.json>
#                                    exporta as métricas SQS da janela (ISO 8601 UTC)
#   m07 <dump-valido> <saida>        gera o dump corrompido M-07 (GZIP truncado)
#
# Os nomes vêm de `terraform output -json ingestion_runbook` (TF_DIR, padrão
# apps/fullstack). Exige AWS CLI com sessão válida do Learner Lab e python.
# Toda falha injetada tem um comando de reversão; rode-o antes do teste seguinte.

set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../../../../.." && pwd)"
TF_DIR="${TF_DIR:-$RAIZ/apps/fullstack}"
REGIAO="${AWS_REGION:-us-east-1}"
ESTADO="${ESTADO_FALHAS:-$RAIZ/.artifacts/falhas-ingestao}"
SID_NEGACAO="CargaSprint5NegaUploadImportacao"

erro() { echo "erro: $*" >&2; exit 2; }

runbook_json() {
  if [ -z "${RUNBOOK:-}" ]; then
    RUNBOOK="$(terraform -chdir="$TF_DIR" output -json ingestion_runbook)" ||
      erro "não foi possível ler o output ingestion_runbook em $TF_DIR"
  fi
  printf '%s' "$RUNBOOK"
}

# rb messaging.incremental_queue_url → valor do runbook (listas saem separadas por vírgula)
rb() {
  runbook_json | python -c '
import json, sys
valor = json.load(sys.stdin)
for parte in sys.argv[1].split("."):
    valor = valor[parte]
print(",".join(valor) if isinstance(valor, list) else valor)' "$1"
}

rede() {
  local publico="DISABLED"
  [ "$(rb imports.assign_public_ip)" = "True" ] && publico="ENABLED"
  printf 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=%s}' \
    "$(rb imports.subnet_ids)" "$(rb imports.security_group_id)" "$publico"
}

nome_fila() { basename "$1"; }

# file:// que a AWS CLI consiga abrir: no Git Bash (Windows) ela não entende
# /c/..., só C:/...
uri_arquivo() {
  if command -v cygpath >/dev/null 2>&1; then
    printf 'file://%s' "$(cygpath -m "$1")"
  else
    printf 'file://%s' "$1"
  fi
}

cmd_recursos() {
  cat <<EOF
cluster              $(rb runtime.cluster_name)
bucket               $(rb storage.bucket)
fila incremental     $(rb messaging.incremental_queue_url)
DLQ incremental      $(rb messaging.incremental_dlq_url)
task import          $(rb runtime.import_task_family)
task ingest          $(rb incremental.ingest_task_family)
agenda ingest        $(rb incremental.ingest_schedule_state) ($(rb incremental.ingest_schedule_expression))
agenda export        $(rb incremental.export_schedule_state) ($(rb incremental.export_schedule_expression))
dashboard CloudWatch $(rb observability.dashboard_name)

# variáveis para apps/backend/ingestion-data/scripts/publish_incremental_batch.py
export INCREMENTAL_BATCH_BUCKET=$(rb storage.bucket)
export INCREMENTAL_BATCH_EXPECTED_BUCKET_OWNER=$(rb imports.expected_bucket_owner)
export INCREMENTAL_BATCH_QUEUE_URL=$(rb messaging.incremental_queue_url)
EOF
}

cmd_agenda() {
  local qual="${1:-}" acao="${2:-}" arn estado
  case "$qual" in
    export) arn="$(rb incremental.export_schedule_arn)" ;;
    ingest) arn="$(rb incremental.ingest_schedule_arn)" ;;
    *) erro "use: agenda <export|ingest> <ligar|desligar>" ;;
  esac
  case "$acao" in
    ligar) estado=ENABLED ;;
    desligar) estado=DISABLED ;;
    *) erro "use: agenda <export|ingest> <ligar|desligar>" ;;
  esac
  local nome="${arn##*/}" grupo
  grupo="$(rb scheduler.group_name)"
  # update-schedule substitui a definição inteira: reenvia a atual trocando só o State.
  aws scheduler get-schedule --region "$REGIAO" --group-name "$grupo" --name "$nome" --output json |
    python -c '
import json, sys
atual = json.load(sys.stdin)
campos = ("Name", "GroupName", "Description", "ScheduleExpression", "ScheduleExpressionTimezone",
          "StartDate", "EndDate", "FlexibleTimeWindow", "Target", "KmsKeyArn", "ActionAfterCompletion")
novo = {campo: atual[campo] for campo in campos if campo in atual}
novo["State"] = sys.argv[1]
print(json.dumps(novo, default=str))' "$estado" > "$ESTADO.agenda.json"
  aws scheduler update-schedule --region "$REGIAO" --cli-input-json "$(uri_arquivo "$ESTADO.agenda.json")" >/dev/null
  rm -f "$ESTADO.agenda.json"
  echo "agenda $qual ($nome): $estado"
}

cmd_rodar_ingestao() {
  aws ecs run-task --region "$REGIAO" \
    --cluster "$(rb runtime.cluster_name)" \
    --task-definition "$(rb incremental.ingest_task_arn)" \
    --launch-type FARGATE --platform-version 1.4.0 \
    --network-configuration "$(rede)" \
    --started-by carga-sprint5 \
    --query 'tasks[0].taskArn' --output text
}

cmd_parar_tasks() {
  local familia
  case "${1:-}" in
    import) familia="$(rb runtime.import_task_family)" ;;
    ingest) familia="$(rb incremental.ingest_task_family)" ;;
    *) erro "use: parar-tasks <import|ingest>" ;;
  esac
  local cluster tasks
  cluster="$(rb runtime.cluster_name)"
  tasks="$(aws ecs list-tasks --region "$REGIAO" --cluster "$cluster" --family "$familia" \
    --desired-status RUNNING --query 'taskArns' --output text)"
  if [ -z "$tasks" ] || [ "$tasks" = "None" ]; then
    echo "nenhuma task $familia em execução"
    return 0
  fi
  for task in $tasks; do
    aws ecs stop-task --region "$REGIAO" --cluster "$cluster" --task "$task" \
      --reason "teste de resiliência da Sprint 5" --query 'task.[taskArn,lastStatus]' --output text
  done
}

cmd_s3_negar() {
  local bucket
  bucket="$(rb storage.bucket)"
  mkdir -p "$(dirname "$ESTADO")"
  # Repetir a injeção não pode substituir o backup pela política já negada.
  if [ -f "$ESTADO.politica-original.json" ]; then
    [ -f "$ESTADO.bucket" ] && [ "$(cat "$ESTADO.bucket")" = "$bucket" ] ||
      erro "backup pertence a outro bucket ou não possui identidade; confira ESTADO_FALHAS antes de injetar"
    echo "reutilizando política original salva em $ESTADO.politica-original.json"
  elif aws s3api get-bucket-policy --region "$REGIAO" --bucket "$bucket" --query Policy --output text \
      > "$ESTADO.politica-lida.json" 2> "$ESTADO.politica-erro.txt"; then
    mv "$ESTADO.politica-lida.json" "$ESTADO.politica-original.json"
    printf '%s\n' "$bucket" > "$ESTADO.bucket"
    rm -f "$ESTADO.politica-erro.txt"
    echo "política original salva em $ESTADO.politica-original.json"
  else
    case "$(cat "$ESTADO.politica-erro.txt")" in
      *'(NoSuchBucketPolicy)'*) ;;
      *) rm -f "$ESTADO.politica-lida.json"
         erro "não foi possível ler a política original; nenhuma política foi alterada (detalhe em $ESTADO.politica-erro.txt)" ;;
    esac
    rm -f "$ESTADO.politica-lida.json" "$ESTADO.politica-erro.txt"
    echo '' > "$ESTADO.politica-original.json"
    printf '%s\n' "$bucket" > "$ESTADO.bucket"
    echo "bucket sem política; s3-restaurar vai removê-la"
  fi
  python - "$ESTADO.politica-original.json" "$bucket" "$SID_NEGACAO" > "$ESTADO.politica-negada.json" <<'PY'
import json, sys
caminho, bucket, sid = sys.argv[1:]
texto = open(caminho, encoding="utf-8").read().strip()
politica = json.loads(texto) if texto else {"Version": "2012-10-17", "Statement": []}
politica["Statement"] = [s for s in politica["Statement"] if s.get("Sid") != sid]
politica["Statement"].append({
    "Sid": sid,
    "Effect": "Deny",
    "Principal": "*",
    # CreateMultipartUpload e UploadPart são autorizados por s3:PutObject.
    "Action": "s3:PutObject",
    "Resource": f"arn:aws:s3:::{bucket}/staging/imports/*",
})
print(json.dumps(politica))
PY
  aws s3api put-bucket-policy --region "$REGIAO" --bucket "$bucket" \
    --policy "$(uri_arquivo "$ESTADO.politica-negada.json")"
  echo "upload em s3://$bucket/staging/imports/ NEGADO — reverta com: $0 s3-restaurar"
}

cmd_s3_restaurar() {
  local bucket
  bucket="$(rb storage.bucket)"
  [ -f "$ESTADO.politica-original.json" ] || erro "nada a restaurar ($ESTADO.politica-original.json ausente)"
  [ -f "$ESTADO.bucket" ] && [ "$(cat "$ESTADO.bucket")" = "$bucket" ] ||
    erro "backup pertence a outro bucket ou não possui identidade; nenhuma política foi alterada"
  if [ -n "$(tr -d '[:space:]' < "$ESTADO.politica-original.json")" ]; then
    aws s3api put-bucket-policy --region "$REGIAO" --bucket "$bucket" \
      --policy "$(uri_arquivo "$ESTADO.politica-original.json")"
  else
    aws s3api delete-bucket-policy --region "$REGIAO" --bucket "$bucket"
  fi
  rm -f "$ESTADO.politica-original.json" "$ESTADO.politica-negada.json" "$ESTADO.bucket"
  echo "política do bucket $bucket restaurada"
}

cmd_filas() {
  local url
  for url in "$(rb messaging.incremental_queue_url)" "$(rb messaging.incremental_dlq_url)"; do
    printf '%-60s ' "$(nome_fila "$url")"
    aws sqs get-queue-attributes --region "$REGIAO" --queue-url "$url" \
      --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
      --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' \
      --output text | awk '{printf "visíveis=%s em processamento=%s\n", $1, $2}'
  done
}

cmd_dlq_espiar() {
  # VisibilityTimeout 0: a mensagem continua disponível na DLQ depois da leitura.
  aws sqs receive-message --region "$REGIAO" --queue-url "$(rb messaging.incremental_dlq_url)" \
    --max-number-of-messages 10 --visibility-timeout 0 --attribute-names All \
    --query 'Messages[].{id:MessageId,recebimentos:Attributes.ApproximateReceiveCount,corpo:Body}' \
    --output json
}

cmd_metricas_fila() {
  local inicio="${1:-}" fim="${2:-}" saida="${3:-}"
  [ -n "$inicio" ] && [ -n "$fim" ] && [ -n "$saida" ] || erro "use: metricas-fila <inicio> <fim> <saida.json>"
  local fila dlq
  fila="$(nome_fila "$(rb messaging.incremental_queue_url)")"
  dlq="$(nome_fila "$(rb messaging.incremental_dlq_url)")"
  python - "$fila" "$dlq" > "$ESTADO.consultas.json" <<'PY'
import json, sys
fila, dlq = sys.argv[1:]
def consulta(ident, fila, metrica, estatistica="Maximum"):
    return {"Id": ident, "MetricStat": {"Metric": {"Namespace": "AWS/SQS", "MetricName": metrica,
            "Dimensions": [{"Name": "QueueName", "Value": fila}]}, "Period": 60, "Stat": estatistica}}
print(json.dumps([
    consulta("fila_visiveis", fila, "ApproximateNumberOfMessagesVisible"),
    consulta("fila_em_processamento", fila, "ApproximateNumberOfMessagesNotVisible"),
    consulta("fila_idade_mais_antiga", fila, "ApproximateAgeOfOldestMessage"),
    consulta("fila_recebidas", fila, "NumberOfMessagesReceived", "Sum"),
    consulta("fila_removidas", fila, "NumberOfMessagesDeleted", "Sum"),
    consulta("dlq_visiveis", dlq, "ApproximateNumberOfMessagesVisible"),
]))
PY
  mkdir -p "$(dirname "$saida")"
  aws cloudwatch get-metric-data --region "$REGIAO" --start-time "$inicio" --end-time "$fim" \
    --metric-data-queries "$(uri_arquivo "$ESTADO.consultas.json")" --output json > "$saida"
  rm -f "$ESTADO.consultas.json"
  echo "métricas SQS de $inicio a $fim gravadas em $saida"
}

cmd_m07() {
  local origem="${1:-}" saida="${2:-}"
  [ -f "$origem" ] && [ -n "$saida" ] || erro "use: m07 <dump-valido.sql.gz> <saida>"
  local tamanho
  tamanho="$(wc -c < "$origem" | tr -d ' ')"
  mkdir -p "$(dirname "$saida")"
  # Metade do arquivo: cabeçalho GZIP válido, fluxo interrompido no meio.
  head -c "$((tamanho / 2))" "$origem" > "$saida"
  echo "M-07: $saida ($((tamanho / 2)) de $tamanho bytes); sha256 $(sha256sum "$saida" | cut -d' ' -f1)"
}

mkdir -p "$(dirname "$ESTADO")"
comando="${1:-}"
shift || true
case "$comando" in
  recursos) cmd_recursos ;;
  agenda) cmd_agenda "$@" ;;
  rodar-ingestao) cmd_rodar_ingestao ;;
  parar-tasks) cmd_parar_tasks "$@" ;;
  s3-negar) cmd_s3_negar ;;
  s3-restaurar) cmd_s3_restaurar ;;
  filas) cmd_filas ;;
  dlq-espiar) cmd_dlq_espiar ;;
  metricas-fila) cmd_metricas_fila "$@" ;;
  m07) cmd_m07 "$@" ;;
  *) sed -n '2,24p' "$0"; exit 2 ;;
esac
