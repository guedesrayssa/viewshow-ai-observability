#!/usr/bin/env bash
# Executa carga nominal, fila cheia e timeout contra a API de telemetria.
# A API deve estar com LOAD_TEST_FAULTS_ENABLED=1 e o mesmo FAULT_TOKEN.

set -u

BASE="${BASE_URL:?informe BASE_URL, sem barra no final}"
TOKEN="${FAULT_TOKEN:?informe FAULT_TOKEN para as rodadas de falha}"
ROTULO="${1:-local}"
RESULTADOS="../resultados"

if ! command -v k6 >/dev/null 2>&1; then
  echo "erro: k6 não encontrado" >&2
  exit 2
fi
if [ ! -f ingestao-resiliencia.js ]; then
  echo "erro: execute este script a partir do diretório k6" >&2
  exit 2
fi
case "$ROTULO" in
  *[!a-zA-Z0-9._-]*|'')
    echo "erro: o rótulo aceita somente letras, números, ponto, hífen e sublinhado" >&2
    exit 2
    ;;
esac

mkdir -p "$RESULTADOS"
status=0
for modo in carga fila_cheia timeout; do
  echo "──────── ingestão · $modo ────────"
  args=(-e "BASE_URL=$BASE" -e "MODE=$modo")
  if [ "$modo" != carga ]; then
    args+=(-e "FAULT_TOKEN=$TOKEN")
  fi
  if ! k6 run "${args[@]}" \
      --summary-export="$RESULTADOS/resumo-ingestao-${modo//_/-}-$ROTULO.json" \
      ingestao-resiliencia.js; then
    status=1
    echo "aviso: $modo reprovou um ou mais thresholds" >&2
  fi
done

exit "$status"
