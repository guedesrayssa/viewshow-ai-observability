#!/usr/bin/env bash
# Bateria de rodadas de consultas.js contra a API de consulta atual.
#
# uso:  ./rodadas.sh                          # bateria completa
#       MODOS="smoke load breakpoint" ./rodadas.sh   # bateria menor
#
# Antes de rodar, semeie o ambiente da API (a partir de apps/backend/api):
#   CLEAN=1 node scripts/seed-carga.cjs
#
# Exige AUTH_COOKIE_SECRET no ambiente (mesmo segredo do processo da API sob
# teste, 32+ chars) — lib/session.js forja o cookie de sessão com ele, já que
# POST /auth/login não existe mais (ver README.md).
#
# Espera a API drenar entre as rodadas: depois de saturar, ela leva minutos
# para voltar, e medir em cima do backlog contamina a rodada seguinte.

set -u

BASE="${BASE_URL:?informe BASE_URL=http://<host>:3000}"
SECRET="${AUTH_COOKIE_SECRET:?informe AUTH_COOKIE_SECRET=<mesmo segredo do processo da API sob teste>}"
MODOS="${MODOS:-smoke load breakpoint estresse spike soak}"

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
  if ! k6 run -e BASE_URL="$BASE" -e AUTH_COOKIE_SECRET="$SECRET" -e MODE="$modo" consultas.js; then
    status=1
    echo "aviso: $modo terminou com falha; a bateria continuará." >&2
  fi
  echo
done

echo "############ resumos gerados ############"
ls -la resumo-*.json || status=1
exit "$status"
