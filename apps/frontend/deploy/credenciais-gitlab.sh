#!/usr/bin/env bash
#
# Atualiza no GitLab as credenciais da sessão do laboratório da AWS Academy.
#
# Uso:
#
#     ./credenciais-gitlab.sh                 # cola o bloco e encerra com Ctrl-D
#     pbpaste | ./credenciais-gitlab.sh       # macOS
#     wl-paste | ./credenciais-gitlab.sh      # Linux/Wayland
#
# O laboratório encerra a sessão a cada quatro horas e emite credenciais novas,
# o que apagaria a graça de ter pipeline: sem isto, publicar exige abrir as
# configurações do projeto e reeditar três variáveis à mão antes de cada deploy.
#
# Espera na entrada o bloco exibido em "AWS Details" -> "AWS CLI", no formato:
#
#     [default]
#     aws_access_key_id=ASIA...
#     aws_secret_access_key=...
#     aws_session_token=...
#
# Requer as variáveis de ambiente:
#
#     GITLAB_TOKEN       token pessoal com escopo `api`
#     GITLAB_PROJECT_ID  identificador numérico do projeto no GitLab

set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://git.inteli.edu.br}"

: "${GITLAB_TOKEN:?defina GITLAB_TOKEN com um token de escopo api}"
: "${GITLAB_PROJECT_ID:?defina GITLAB_PROJECT_ID (Configurações -> Geral)}"

if [[ -t 0 ]]; then
    echo "Cole o bloco de 'AWS Details' -> 'AWS CLI' e encerre com Ctrl-D:" >&2
fi

BLOCO="$(cat)"

# O valor pode vir com aspas ou espaços em volta do '=' dependendo de onde foi
# copiado; a extração tolera as duas formas para evitar gravar uma credencial
# truncada, que falharia no CI com um erro de assinatura difícil de ligar à causa.
extrair() {
    printf '%s\n' "$BLOCO" \
        | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([^\"']*\).*/\1/p" \
        | head -1
}

ACCESS_KEY="$(extrair aws_access_key_id)"
SECRET_KEY="$(extrair aws_secret_access_key)"
SESSION_TOKEN="$(extrair aws_session_token)"

if [[ -z "$ACCESS_KEY" || -z "$SECRET_KEY" || -z "$SESSION_TOKEN" ]]; then
    echo "erro: não encontrei as três credenciais no texto informado." >&2
    exit 1
fi

# O GitLab não tem um "cria ou atualiza": o PUT falha com 404 quando a variável
# ainda não existe, e é nesse caso que o POST entra.
gravar() {
    local chave="$1" valor="$2" codigo

    codigo="$(
        curl --silent --output /dev/null --write-out '%{http_code}' \
            --request PUT \
            --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
            --form "value=$valor" \
            --form "masked=true" \
            --form "protected=false" \
            "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_ID/variables/$chave"
    )"

    if [[ "$codigo" == "404" ]]; then
        codigo="$(
            curl --silent --output /dev/null --write-out '%{http_code}' \
                --request POST \
                --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
                --form "key=$chave" \
                --form "value=$valor" \
                --form "masked=true" \
                --form "protected=false" \
                "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_ID/variables"
        )"
    fi

    if [[ "$codigo" != "200" && "$codigo" != "201" ]]; then
        echo "erro: GitLab respondeu $codigo ao gravar $chave" >&2
        exit 1
    fi

    echo "  $chave atualizada"
}

echo "Atualizando variáveis em $GITLAB_URL (projeto $GITLAB_PROJECT_ID):"
gravar AWS_ACCESS_KEY_ID "$ACCESS_KEY"
gravar AWS_SECRET_ACCESS_KEY "$SECRET_KEY"
gravar AWS_SESSION_TOKEN "$SESSION_TOKEN"

echo "Pronto. O pipeline volta a publicar até o fim desta sessão do laboratório."
