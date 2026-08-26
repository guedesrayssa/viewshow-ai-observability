#!/usr/bin/env bash
#
# Publica a exportação estática do painel em uma branch do AWS Amplify.
#
# Uso:
#
#     ./deploy-amplify.sh <app-id> <branch> [diretorio]
#     ./deploy-amplify.sh d1a2b3c4e5f6g7 develop ../out
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

set -euo pipefail

APP_ID="${1:-}"
BRANCH="${2:-}"
DIRETORIO="${3:-out}"

if [[ -z "$APP_ID" || -z "$BRANCH" ]]; then
    echo "uso: $0 <app-id> <branch> [diretorio]" >&2
    echo "exemplo: $0 d1a2b3c4e5f6g7 develop out" >&2
    exit 1
fi

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

ZIP="$(mktemp -d)/painel.zip"
trap 'rm -rf "$(dirname "$ZIP")"' EXIT

# O Amplify espera os arquivos na raiz do zip, não dentro de uma pasta. Compactar
# de dentro do diretório é o que garante isso; compactar o diretório inteiro
# publicaria um site cujas páginas ficam todas sob '/out/'.
( cd "$DIRETORIO" && zip -q -r "$ZIP" . )

echo "Enviando $(du -h "$ZIP" | cut -f1) para $APP_ID / $BRANCH"

# 'create-deployment' devolve o identificador do job e uma URL S3 pré-assinada de
# uso único. A URL carrega a autenticação na própria query string, por isso o
# upload é um PUT simples, sem assinatura do AWS CLI.
read -r JOB_ID UPLOAD_URL <<< "$(
    aws amplify create-deployment \
        --app-id "$APP_ID" \
        --branch-name "$BRANCH" \
        --query '[jobId,zipUploadUrl]' \
        --output text
)"

curl --silent --show-error --fail \
    --request PUT \
    --header "Content-Type: application/zip" \
    --upload-file "$ZIP" \
    "$UPLOAD_URL"

aws amplify start-deployment \
    --app-id "$APP_ID" \
    --branch-name "$BRANCH" \
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
            --app-id "$APP_ID" \
            --branch-name "$BRANCH" \
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

DOMINIO="$(aws amplify get-app --app-id "$APP_ID" --query 'app.defaultDomain' --output text)"

echo "Publicado: https://${BRANCH}.${DOMINIO}"
