#!/usr/bin/env bash
# Bateria completa de rodadas para um esquema de chaves.
#
# uso:  ./rodadas.sh v2        # esquema atual (prefixo discriminante)
#       ./rodadas.sh v1        # baseline legado, somente para comparação
#
# O argumento rotula os arquivos; ele NÃO altera o banco remoto. Antes de
# rodar, execute o seed no ambiente da API com CLEAN=1 KEY_SCHEME=v1|v2.
# Por padrão roda smoke, carga, capacidade, estresse, pico e endurance. Para uma
# bateria menor: MODOS="smoke load breakpoint" ./rodadas.sh v2
#
# Espera a API drenar entre as rodadas: depois de saturar, ela leva minutos
# para voltar, e medir em cima do backlog contamina a rodada seguinte.

set -u

ESQ="${1:?informe o esquema: v1 ou v2}"
BASE="${BASE_URL:-http://data-ingestion-alb-1869738103.us-east-1.elb.amazonaws.com}"
MODOS="${MODOS:-smoke load breakpoint estresse spike soak}"

# Guardas: já aconteceu de uma colagem quebrada executar este script no
# notebook, com o destino do scp no lugar do esquema.
case "$ESQ" in
  v1|v2) ;;
  *) echo "erro: esquema deve ser 'v1' ou 'v2' — recebi '$ESQ'" >&2; exit 2 ;;
esac

if ! command -v k6 >/dev/null 2>&1; then
  echo "erro: k6 não encontrado. Este script roda NA EC2, não no notebook." >&2
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

echo "############ bateria · esquema $ESQ ############"
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
  echo "──────── $modo ($ESQ) ────────"
  if ! k6 run -e BASE_URL="$BASE" -e MODE="$modo" \
          --summary-export="resumo-${modo}-${ESQ}.json" \
          consultas.js; then
    status=1
    echo "aviso: $modo terminou com falha; a bateria continuará." >&2
  fi
  echo
done

echo "############ resumos gerados ############"
ls -la resumo-*-"${ESQ}".json || status=1
exit "$status"
