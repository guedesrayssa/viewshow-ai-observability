#!/usr/bin/env bash
# Bateria de rodadas de consultas.js contra a API de consulta atual.
#
# uso:  ./rodadas.sh                          # bateria completa
#       MODOS="smoke load breakpoint" ./rodadas.sh   # bateria menor
#
# Antes de rodar, semeie o ambiente da API (a partir de apps/backend/api):
#   CLEAN=1 node scripts/seed-carga.cjs             # local
#   ALLOW_REMOTE_SEED=1 node scripts/seed-carga.cjs # AWS real (sem CLEAN)
#
# Autenticação (ver README.md): informe AUTH_USERNAME + AUTH_PASSWORD para
# login real contra o Cognito, OU AUTH_COOKIE_SECRET para cookie forjado
# (mesmo segredo do processo da API sob teste, 32+ chars).
#
# Espera a API drenar entre as rodadas: depois de saturar, ela leva minutos
# para voltar, e medir em cima do backlog contamina a rodada seguinte.

set -u

BASE="${BASE_URL:?informe BASE_URL=http://<host>:3000}"
MODOS="${MODOS:-smoke load breakpoint estresse spike soak}"

AUTH_ARGS=()
if [ -n "${AUTH_USERNAME:-}" ] && [ -n "${AUTH_PASSWORD:-}" ]; then
  AUTH_ARGS=(-e "AUTH_USERNAME=$AUTH_USERNAME" -e "AUTH_PASSWORD=$AUTH_PASSWORD")
elif [ -n "${AUTH_COOKIE_SECRET:-}" ]; then
  AUTH_ARGS=(-e "AUTH_COOKIE_SECRET=$AUTH_COOKIE_SECRET")
else
  echo "erro: informe AUTH_USERNAME+AUTH_PASSWORD (login real) ou AUTH_COOKIE_SECRET (cookie forjado)." >&2
  exit 2
fi

if ! command -v k6 >/dev/null 2>&1; then
  echo "erro: k6 não encontrado." >&2
  exit 2
fi

if [ ! -f consultas.js ]; then
  echo "erro: consultas.js não está neste diretório." >&2
  exit 2
fi

esperar_api() {
  printf 'aguardando a API drenar'
  for _ in $(seq 1 90); do
    t=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "$BASE/health" 2>/dev/null || echo 99)
    if awk -v t="$t" 'BEGIN{exit !(t<1.0)}'; then
      printf ' — pronta (health em %ss)\n' "$t"
      return 0
    fi
    printf '.'
    sleep 10
  done
  printf ' — ainda lenta após 15 min; seguindo assim mesmo\n'
}

echo "############ bateria de consultas.js ############"
echo "alvo: $BASE"
echo "modos: $MODOS"
echo

status=0
for modo in $MODOS; do
  case "$modo" in
    smoke|load|breakpoint|estresse|spike|soak) ;;
    *) echo "erro: modo inválido em MODOS: '$modo'" >&2; exit 2 ;;
  esac

  esperar_api
  echo "──────── $modo ────────"
  if ! k6 run -e BASE_URL="$BASE" "${AUTH_ARGS[@]}" -e MODE="$modo" consultas.js; then
    status=1
    echo "aviso: $modo terminou com falha; a bateria continuará." >&2
  fi
  echo
done

echo "############ resumos gerados ############"
ls -la resumo-*.json || status=1
exit "$status"
