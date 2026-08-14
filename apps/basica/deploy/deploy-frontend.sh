#!/usr/bin/env bash
#
# Publica a página estática no bucket S3, apontada para a API indicada.
#
# Uso:
#
#     ./deploy-frontend.sh <nome-do-bucket> <url-da-api>
#     ./deploy-frontend.sh g05-telemetria-front http://54.90.12.34
#
# O endereço da API entra em `config.js` no momento da publicação, sobre uma
# cópia temporária — o arquivo versionado no repositório nunca é alterado, então
# o IP da instância não vaza para o histórico do git nem gera diff sujo.
#
# Esse é também o conserto rápido caso a instância suba com outro IP: basta
# rodar o script de novo com o endereço novo. Com um Elastic IP associado o
# endereço não muda, e o script só precisa ser executado uma vez.
#
# Requer o AWS CLI autenticado. No laboratório da AWS Academy as credenciais
# expiram a cada sessão: recopie-as de "AWS Details" → "AWS CLI" antes de rodar.

set -euo pipefail

BUCKET="${1:-}"
API_URL="${2:-}"

if [[ -z "$BUCKET" || -z "$API_URL" ]]; then
    echo "uso: $0 <nome-do-bucket> <url-da-api>" >&2
    echo "exemplo: $0 g05-telemetria-front http://54.90.12.34" >&2
    exit 1
fi

# Barra no final quebraria as URLs montadas pelo `api.js`, que já começam com
# barra. Removida aqui para que o erro não dependa de o usuário lembrar disso.
API_URL="${API_URL%/}"

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")/../frontend" && pwd)"
DESTINO="$(mktemp -d)"
trap 'rm -rf "$DESTINO"' EXIT

cp -r "$ORIGEM"/. "$DESTINO"/
sed -i "s|^const API_BASE_URL = .*|const API_BASE_URL = \"${API_URL}\";|" "$DESTINO/config.js"

echo "API configurada como: $(grep '^const API_BASE_URL' "$DESTINO/config.js")"

# `--delete` remove do bucket o que saiu do repositório, evitando que sobras de
# publicações anteriores continuem sendo servidas.
aws s3 sync "$DESTINO" "s3://${BUCKET}/" --delete

# Sem isso, o navegador pode continuar servindo do cache um `config.js` com o IP
# antigo depois de uma republicação — falha silenciosa e difícil de diagnosticar.
aws s3 cp "$DESTINO/config.js" "s3://${BUCKET}/config.js" \
    --content-type "application/javascript" \
    --cache-control "no-cache"
aws s3 cp "$DESTINO/index.html" "s3://${BUCKET}/index.html" \
    --content-type "text/html" \
    --cache-control "no-cache"

REGIAO="$(aws s3api get-bucket-location --bucket "$BUCKET" --query LocationConstraint --output text)"
[[ "$REGIAO" == "None" ]] && REGIAO="us-east-1"

echo
echo "Publicado. Site: http://${BUCKET}.s3-website-${REGIAO}.amazonaws.com"
echo "Lembre-se de que essa URL precisa estar em CORS_ORIGINS na EC2."
