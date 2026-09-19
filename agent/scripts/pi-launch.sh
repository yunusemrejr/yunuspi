#!/usr/bin/env bash
# Installed YunusPi launcher: explicit reviewed-source updates and session lease.
set -euo pipefail
NODE="$1"
ENTRY="$2"
shift 2
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT="${PI_CODING_AGENT_DIR:-$(dirname "$SCRIPTS")}"
export PI_CODING_AGENT_DIR="$AGENT"
if [[ "${1:-}" == update ]]; then
  # Pi owns normal update subcommands such as `pi update --models` and
  # `pi update --extensions`. YunusPi's source updater is selected only by
  # its explicit reviewed checkout argument.
  yunuspi_source=false
  for arg in "$@"; do
    [[ "$arg" == --source ]] && yunuspi_source=true
  done
  if [[ "$yunuspi_source" == true ]]; then
    shift
    exec "$NODE" "$SCRIPTS/core-update.mjs" "$@"
  fi
fi
if [[ ! -f "$ENTRY" ]]; then
  echo 'YunusPi core is not built. Run npm ci --ignore-scripts and npm run build:core inside agent/runtime, or reinstall with --install-deps.' >&2
  exit 1
fi
mkdir -p "$AGENT/logs"
LOCK="$AGENT/logs/harness-session.lock"
if [[ ! -e "$LOCK" ]]; then (umask 077; touch "$LOCK"); fi
exec 8<"$LOCK"
flock --shared 8
exec "$NODE" "$ENTRY" "$@"
