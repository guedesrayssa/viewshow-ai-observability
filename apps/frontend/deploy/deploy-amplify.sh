#!/usr/bin/env bash
#
# Publica a exportação estática do painel em uma branch do AWS Amplify.
#
# Uso:
#
#     ./deploy-amplify.sh [diretorio]
#     ./deploy-amplify.sh ../out
#
# O Amplify só conecta em GitHub, Bitbucket, GitLab.com e CodeCommit. Como este
# repositório vive em um GitLab auto-hospedado (git.inteli.edu.br), não existe
# build automático do lado da AWS: quem compila é o GitLab CI, e este script
# entrega o resultado pronto pela API de deployment manual.
#
# Roda igual na máquina de qualquer pessoa do grupo e dentro do CI, de propósito:
# quando o pipeline falha, dá para reproduzir o passo exato localmente em vez de
# depurar às cegas pelo log do runner.
#
# Requer o AWS CLI autenticado. No laboratório da AWS Academy as credenciais
# expiram ao fim da sessão: recopie-as de "AWS Details" -> "AWS CLI".

set -Eeuo pipefail
set +x

readonly EXPECTED_ACCOUNT_ID="248880318395"
readonly EXPECTED_REGION="us-east-1"
readonly EXPECTED_APP_NAME="g05-s3-painel"
readonly EXPECTED_BRANCH="producao"
readonly EXPECTED_STACK_TAG="g05-sprint3-entrega"
readonly EXPECTED_MANAGED_BY_TAG="terraform"
DIRETORIO="${1:-out}"

if (($# > 1)); then
    echo "uso: $0 [diretorio]" >&2
    exit 1
fi

for REGION_VARIABLE in AWS_DEFAULT_REGION AWS_REGION; do
    if [[ -n "${!REGION_VARIABLE:-}" && "${!REGION_VARIABLE}" != "$EXPECTED_REGION" ]]; then
        echo "erro: região AWS conflitante em $REGION_VARIABLE." >&2
        exit 64
    fi
done

ENDPOINT_OVERRIDE_NAMES=()
while IFS= read -r VARIABLE_NAME; do
    ENDPOINT_OVERRIDE_NAMES+=("$VARIABLE_NAME")
done < <(compgen -A variable AWS_ENDPOINT_URL || true)
if ((${#ENDPOINT_OVERRIDE_NAMES[@]} != 0)); then
    echo "AWS endpoint overrides are not allowed: ${ENDPOINT_OVERRIDE_NAMES[*]}" >&2
    exit 64
fi
unset ENDPOINT_OVERRIDE_NAMES REGION_VARIABLE VARIABLE_NAME
export AWS_PAGER=""
export AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true

for COMMAND_NAME in aws curl zip mktemp rm dirname du cut sleep; do
    if ! command -v "$COMMAND_NAME" >/dev/null 2>&1; then
        echo "erro: comando obrigatório indisponível: $COMMAND_NAME" >&2
        exit 69
    fi
done
unset COMMAND_NAME

if [[ ! -d "$DIRETORIO" ]]; then
    echo "erro: '$DIRETORIO' não existe. Rode 'npm run build' antes." >&2
    exit 1
fi

# O index.html é o sinal mais barato de que o diretório é mesmo uma exportação
# concluída, e não um 'out/' pela metade de um build interrompido.
if [[ ! -f "$DIRETORIO/index.html" ]]; then
    echo "erro: '$DIRETORIO' não parece uma exportação do Next (sem index.html)." >&2
    exit 1
fi

read -r CALLER_ACCOUNT CALLER_ARN <<< "$(
    aws sts get-caller-identity \
        --region "$EXPECTED_REGION" \
        --query '[Account,Arn]' \
        --output text
)"

if [[ "$CALLER_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]]; then
    echo "erro: a conta AWS ativa não é a conta isolada esperada." >&2
    exit 1
fi

if [[ ! "$CALLER_ARN" =~ ^arn:aws:sts::248880318395:assumed-role/voclabs/[^/]+$ ]]; then
    echo "erro: o caller AWS ativo não usa a role voclabs esperada." >&2
    exit 1
fi

APPS_OUTPUT="$(
    aws amplify list-apps \
        --region "$EXPECTED_REGION" \
        --query 'apps[?name==`g05-s3-painel`].[appId,appArn,defaultDomain]' \
        --output text
)"
APP_ROWS=()
if [[ -n "$APPS_OUTPUT" ]]; then
    mapfile -t APP_ROWS <<< "$APPS_OUTPUT"
fi
unset APPS_OUTPUT

if ((${#APP_ROWS[@]} != 1)); then
    echo "erro: esperava exatamente um app Amplify chamado '$EXPECTED_APP_NAME'." >&2
    exit 1
fi

read -r APP_ID APP_ARN DOMINIO EXTRA_FIELD <<< "${APP_ROWS[0]}"
unset APP_ROWS
if [[ -z "$APP_ID" || -z "$APP_ARN" || -z "$DOMINIO" || -n "$EXTRA_FIELD" ]]; then
    echo "erro: resposta inválida ao resolver o app Amplify isolado." >&2
    exit 1
fi
if [[ "$APP_ARN" != "arn:aws:amplify:${EXPECTED_REGION}:${EXPECTED_ACCOUNT_ID}:apps/${APP_ID}" ]]; then
    echo "erro: ARN inesperado para o app Amplify isolado." >&2
    exit 1
fi

read -r STACK_TAG MANAGED_BY_TAG EXTRA_TAG <<< "$(
    aws amplify list-tags-for-resource \
        --region "$EXPECTED_REGION" \
        --resource-arn "$APP_ARN" \
        --query '[tags.Stack,tags.ManagedBy]' \
        --output text
)"
if [[ "$STACK_TAG" != "$EXPECTED_STACK_TAG" || "$MANAGED_BY_TAG" != "$EXPECTED_MANAGED_BY_TAG" || -n "$EXTRA_TAG" ]]; then
    echo "erro: tags de propriedade do app Amplify não correspondem à stack isolada." >&2
    exit 1
fi
unset STACK_TAG MANAGED_BY_TAG EXTRA_TAG

ZIP="$(mktemp -d)/painel.zip"
trap 'rm -rf "$(dirname "$ZIP")"' EXIT

# O Amplify espera os arquivos na raiz do zip, não dentro de uma pasta. Compactar
# de dentro do diretório é o que garante isso; compactar o diretório inteiro
# publicaria um site cujas páginas ficam todas sob '/out/'.
( cd "$DIRETORIO" && zip -q -r "$ZIP" . )

echo "Enviando $(du -h "$ZIP" | cut -f1) para $EXPECTED_APP_NAME / $EXPECTED_BRANCH"

# 'create-deployment' devolve o identificador do job e uma URL S3 pré-assinada de
# uso único. A URL carrega a autenticação na própria query string, por isso o
# upload é um PUT simples, sem assinatura do AWS CLI.
read -r JOB_ID UPLOAD_URL <<< "$(
    aws amplify create-deployment \
        --region "$EXPECTED_REGION" \
        --app-id "$APP_ID" \
        --branch-name "$EXPECTED_BRANCH" \
        --query '[jobId,zipUploadUrl]' \
        --output text
)"

if [[ -z "$JOB_ID" || ! "$UPLOAD_URL" =~ ^https://[^[:space:]]+$ ]]; then
    echo "erro: o Amplify retornou dados inválidos para o deployment." >&2
    exit 1
fi

if ! curl --disable --silent --show-error --fail \
    --output /dev/null \
    --request PUT \
    --header "Content-Type: application/zip" \
    --upload-file "$ZIP" \
    "$UPLOAD_URL" 2>/dev/null; then
    echo "erro: upload do artefato falhou." >&2
    exit 1
fi
unset UPLOAD_URL

aws amplify start-deployment \
    --region "$EXPECTED_REGION" \
    --app-id "$APP_ID" \
    --branch-name "$EXPECTED_BRANCH" \
    --job-id "$JOB_ID" \
    --output text --query 'jobSummary.status' > /dev/null

echo "Deployment $JOB_ID iniciado. Aguardando conclusão..."

# Sem esta espera o job do CI terminaria em verde assim que a AWS aceitasse o
# pedido, mesmo que a publicação falhasse segundos depois: o pipeline diria
# "sucesso" enquanto o site continuaria na versão anterior.
LIMITE=$((SECONDS + 600))
while true; do
    STATUS="$(
        aws amplify get-job \
            --region "$EXPECTED_REGION" \
            --app-id "$APP_ID" \
            --branch-name "$EXPECTED_BRANCH" \
            --job-id "$JOB_ID" \
            --query 'job.summary.status' \
            --output text
    )"

    case "$STATUS" in
        SUCCEED)
            break
            ;;
        FAILED|CANCELLED)
            echo "erro: deployment terminou como $STATUS" >&2
            exit 1
            ;;
    esac

    if (( SECONDS > LIMITE )); then
        echo "erro: deployment ainda em '$STATUS' após 10 minutos." >&2
        exit 1
    fi

    sleep 5
done

echo "Publicado: https://${EXPECTED_BRANCH}.${DOMINIO}"
