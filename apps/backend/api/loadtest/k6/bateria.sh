#!/usr/bin/env bash
# Bateria de carga que grava evidência AUDITÁVEL.
#
# Diferença em relação a rodadas.sh: além do `resumo-*.json` que o próprio
# handleSummary() do k6 escreve, cada rodada produz um `metadados-*.json` com
# comando (segredo redigido), início/fim em UTC, duração, exit code, versão do
# k6, commit, ambiente e o resultado de cada threshold. Sem esse envelope não
# há como conferir uma rodada depois — foi o que faltou nas rodadas em AWS do
# commit 609b822, que por isso ficaram registradas como relato e não como
# evidência (ver artefatos/sprint3/testes-carga-inicial.md §8.7).
#
# uso mínimo:
#   BASE_URL=http://<alb-dns> AUTH_COOKIE_SECRET=<segredo> ./bateria.sh
#
# variáveis:
#   MODOS          rodadas de consultas.js (padrão: smoke load breakpoint estresse spike)
#   EXTRAS         scripts avulsos (padrão: auth-check ingestao-drenagem)
#   DEST           pasta de evidência (padrão: ../../../../../assets/testes-carga/<hoje>-aws)
#   AMB_*          campos do bloco `ambiente` dos metadados (ver abaixo)
#
# Compatível com bash 3.2 (o que o macOS traz): sem arrays associativos e sem
# mapfile — a suíte tests/ci já reprova nesse host por depender de bash 4.

set -u

BASE="${BASE_URL:?informe BASE_URL=http://<host>}"
SECRET="${AUTH_COOKIE_SECRET:?informe AUTH_COOKIE_SECRET=<mesmo segredo da API sob teste>}"
MODOS="${MODOS:-smoke load breakpoint estresse spike}"
EXTRAS="${EXTRAS:-auth-check ingestao-drenagem}"

HOJE="$(date -u +%Y-%m-%d)"
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../../../../.." && pwd)"
DEST="${DEST:-$RAIZ/assets/testes-carga/$HOJE-aws}"

for ferramenta in k6 jq curl; do
  command -v "$ferramenta" >/dev/null 2>&1 || { echo "erro: $ferramenta não encontrado." >&2; exit 2; }
done
[ -f "$AQUI/consultas.js" ] || { echo "erro: consultas.js não está em $AQUI." >&2; exit 2; }

mkdir -p "$DEST"
cd "$AQUI"

K6_VERSAO="$(k6 version 2>/dev/null | head -1)"
COMMIT="$(git -C "$RAIZ" rev-parse HEAD 2>/dev/null || echo desconhecido)"

# Bloco `ambiente`: o que descreve o leito. Os padrões cobrem o caso AWS; para
# uma rodada local, sobrescreva AMB_API e AMB_PERSISTENCIA.
AMB_HOST="${AMB_HOST:-$(uname -sr) $(uname -m) — gerador fora da AWS, API em ECS Fargate}"
AMB_API="${AMB_API:-ECS Fargate atrás de ALB (ver terraform output)}"
AMB_NODE="${AMB_NODE:-$(node --version 2>/dev/null || echo desconhecido)}"
AMB_PERSISTENCIA="${AMB_PERSISTENCIA:-DynamoDB gerenciado (on-demand)}"
AMB_RATE_LIMIT="${AMB_RATE_LIMIT:-20000}"
AMB_SEED="${AMB_SEED:-CLEAN=1 ALLOW_REMOTE_SEED=1 node scripts/seed-carga.cjs}"

# Espera a API drenar: depois de saturar ela leva minutos para voltar, e medir
# em cima do backlog contamina a rodada seguinte.
esperar_api() {
  printf 'aguardando a API drenar'
  i=0
  while [ "$i" -lt 90 ]; do
    t=$(curl -s -o /dev/null -m 10 -w '%{time_total}' "$BASE/health" 2>/dev/null || echo 99)
    if awk -v t="$t" 'BEGIN{exit !(t<1.0)}'; then
      printf ' — pronta (health em %ss)\n' "$t"
      return 0
    fi
    printf '.'
    sleep 10
    i=$((i + 1))
  done
  printf ' — ainda lenta após 15 min; seguindo assim mesmo\n'
}

# $1 rótulo · $2 arquivo do resumo que o k6 escreve · $3.. comando
executar() {
  rotulo="$1"; resumo_k6="$2"; shift 2

  inicio_epoch=$(date -u +%s)
  inicio_utc=$(date -u -r "$inicio_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u +%Y-%m-%dT%H:%M:%SZ)

  echo "──────── $rotulo ────────"
  "$@" > "$DEST/.stdout-$rotulo" 2> "$DEST/.stderr-$rotulo"
  codigo=$?
  tail -30 "$DEST/.stdout-$rotulo"

  fim_epoch=$(date -u +%s)
  fim_utc=$(date -u -r "$fim_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
    || date -u +%Y-%m-%dT%H:%M:%SZ)

  destino_resumo="$DEST/resumo-$rotulo.json"
  if [ -f "$resumo_k6" ]; then
    mv "$resumo_k6" "$destino_resumo"
  else
    echo "aviso: $rotulo não gerou $resumo_k6 (abortou antes do handleSummary)." >&2
    echo '{}' > "$destino_resumo"
  fi

  # O segredo nunca entra no arquivo: argumentos de processo são legíveis por
  # qualquer usuário da máquina, e este JSON é evidência versionada.
  comando=$(printf '%s ' "$@" | sed "s|$SECRET|<segredo>|g")

  # Sob erro o k6 imprime a URL inteira, e a do cenário de paginação carrega o
  # cursor AES-256-GCM. Ele não dá acesso a nada sozinho (as rotas exigem
  # sessão), mas é um token opaco e não tem por que ficar versionado.
  redigir() {
    sed -e "s|$SECRET|<segredo>|g" -e 's|cursor=[A-Za-z0-9_-]*|cursor=<redigido>|g'
  }

  jq -n \
    --arg rotulo "$rotulo" \
    --arg comando "$comando" \
    --arg inicio "$inicio_utc" \
    --arg fim "$fim_utc" \
    --argjson duracao "$((fim_epoch - inicio_epoch))" \
    --argjson codigo "$codigo" \
    --arg k6 "$K6_VERSAO" \
    --arg commit "$COMMIT" \
    --arg host "$AMB_HOST" \
    --arg api "$AMB_API" \
    --arg node "$AMB_NODE" \
    --arg persistencia "$AMB_PERSISTENCIA" \
    --arg base_url "$BASE" \
    --argjson rate_limit "$AMB_RATE_LIMIT" \
    --arg seed "$AMB_SEED" \
    --arg stdout "$(tail -40 "$DEST/.stdout-$rotulo" | redigir)" \
    --arg stderr "$(tail -20 "$DEST/.stderr-$rotulo" | redigir)" \
    --argjson thresholds "$(jq '
        [ .metrics // {} | to_entries[]
          | select(.value.thresholds != null)
          | .key as $m
          | .value.thresholds | to_entries[]
          | { key: ($m + ": " + .key),
              value: (if .value.ok then "ok" else "reprovado" end) }
        ] | from_entries' "$destino_resumo" 2>/dev/null || echo '{}')" \
    '{
      rotulo: $rotulo, comando: $comando,
      inicio_utc: $inicio, fim_utc: $fim, duracao_s: $duracao,
      exit_code: $codigo, k6: $k6, commit: $commit,
      ambiente: {
        host: $host, api: $api, node: $node, persistencia: $persistencia,
        base_url: $base_url, rate_limit_por_minuto: $rate_limit, seed: $seed
      },
      stdout_final: $stdout, stderr_final: $stderr,
      thresholds: $thresholds
    }' > "$DEST/metadados-$rotulo.json"

  rm -f "$DEST/.stdout-$rotulo" "$DEST/.stderr-$rotulo"
  echo "exit=$codigo · evidência em $DEST/{resumo,metadados}-$rotulo.json"
  echo
  return 0
}

echo "############ bateria auditável ############"
echo "alvo:   $BASE"
echo "modos:  $MODOS"
echo "extras: $EXTRAS"
echo "destino: $DEST"
echo "k6:     $K6_VERSAO"
echo "commit: $COMMIT"
echo

for modo in $MODOS; do
  case "$modo" in
    smoke|load|breakpoint|estresse|spike|soak) ;;
    *) echo "erro: modo inválido em MODOS: '$modo'" >&2; exit 2 ;;
  esac
  esperar_api
  executar "$modo" "resumo-$modo.json" \
    k6 run -e BASE_URL="$BASE" -e AUTH_COOKIE_SECRET="$SECRET" -e MODE="$modo" consultas.js
done

for extra in $EXTRAS; do
  case "$extra" in
    auth-check)
      esperar_api
      executar "auth-check" "resumo-auth-check.json" \
        k6 run -e BASE_URL="$BASE" -e AUTH_COOKIE_SECRET="$SECRET" auth-check.js
      ;;
    ingestao-*)
      modo_ing="${extra#ingestao-}"
      esperar_api
      executar "$extra" "resumo-ingestao-$modo_ing.json" \
        k6 run -e BASE_URL="$BASE" -e AUTH_COOKIE_SECRET="$SECRET" -e MODE="$modo_ing" ingestao-batch.js
      ;;
    *) echo "erro: extra inválido em EXTRAS: '$extra'" >&2; exit 2 ;;
  esac
done

echo "############ evidência gerada ############"
ls -1 "$DEST"
