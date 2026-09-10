#!/usr/bin/env bash
#
# DEPRECATED: compatibility wrapper for the hardened repository synchronizer.
# Use scripts/sync-aws-gitlab-credentials.sh directly for new workflows.
# This entrypoint accepts options only; it does not parse credential blocks.

set -Eeuo pipefail
set +x

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SYNCHRONIZER="$SCRIPT_DIR/../../../scripts/sync-aws-gitlab-credentials.sh"

FORWARDED_OPTIONS=()
for OPTION in "$@"; do
  case "$OPTION" in
    --dry-run | --allow-unprotected-develop)
      FORWARDED_OPTIONS+=("$OPTION")
      ;;
    *)
      echo "usage: credenciais-gitlab.sh [--dry-run] [--allow-unprotected-develop]" >&2
      exit 64
      ;;
  esac
done
unset OPTION

if [[ ! -f "$SYNCHRONIZER" || ! -x "$SYNCHRONIZER" ]]; then
  echo "error: hardened credential synchronizer is unavailable" >&2
  exit 69
fi

exec "$SYNCHRONIZER" "${FORWARDED_OPTIONS[@]}"
