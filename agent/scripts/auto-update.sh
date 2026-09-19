#!/usr/bin/env bash
# Compatibility entrypoint for old user timers. Maintenance is local validation;
# unattended core updates and upstream version discovery have been retired.
set -euo pipefail
case "${1:-}" in
  ''|--repair-only) ;;
  *) echo 'Usage: auto-update.sh [--repair-only]. For releases: yunuspi update --source /reviewed/checkout' >&2; exit 2 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${PI_CODING_AGENT_DIR:-$(dirname "$SCRIPT_DIR")}"
export PI_CODING_AGENT_DIR="$AGENT"
mkdir -p "$AGENT/logs"
exec >>"$AGENT/logs/auto-update.log" 2>&1
echo "== $(date -Is) local YunusPi verification; no update checks or downloads =="
exec node "$SCRIPT_DIR/verify-harness.mjs"
