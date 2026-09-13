#!/usr/bin/env bash
# The maintained launcher lives outside npm's replaceable package directory.
set -euo pipefail
NODE="$1"
ENTRY="$2"
shift 2
SCRIPTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Self-updates use the same staged transaction as the timer.
if [[ "${1:-}" == update ]]; then
  SELF=0; EXTENSIONS=0; MODELS=0; HELP=0; FORCE=0; SOURCE=0
  APPROVAL=()
  ARGS=("${@:2}")
  for ((i=0; i<${#ARGS[@]}; i++)); do
    case "${ARGS[i]}" in
      --self|self|pi) SELF=1 ;;
      --all) SELF=1; EXTENSIONS=1 ;;
      --extensions) EXTENSIONS=1 ;;
      --models) MODELS=1 ;;
      --extension) SOURCE=1; i=$((i+1)) ;;
      --force) FORCE=1 ;;
      --help|-h) HELP=1 ;;
      -a|--approve|-na|--no-approve) APPROVAL+=("${ARGS[i]}") ;;
      -*) echo 'Unsupported Pi update option; inspect pi update --help.' >&2; exit 2 ;;
      *) SOURCE=1 ;;
    esac
  done
  if [[ "$HELP" == 0 ]]; then
    if [[ "$SELF" == 0 && "$EXTENSIONS" == 0 && "$MODELS" == 0 && "$SOURCE" == 0 ]]; then SELF=1; fi
    if [[ "$SELF" == 1 ]]; then
      if [[ "$MODELS" == 1 || "$SOURCE" == 1 ]]; then echo 'Conflicting Pi update targets.' >&2; exit 2; fi
      UPDATE_ARGS=(); if [[ "$FORCE" == 1 ]]; then UPDATE_ARGS+=(--force); fi
      /bin/bash "$SCRIPTS/auto-update.sh" "${UPDATE_ARGS[@]}" || { echo 'Pi update failed; inspect ~/.pi/agent/logs/auto-update.log.' >&2; exit 1; }
      echo 'Pi core update check finished; details: ~/.pi/agent/logs/auto-update.log'
      if [[ "$EXTENSIONS" == 0 ]]; then exit 0; fi
      set -- update --extensions "${APPROVAL[@]}"
    fi
  fi
fi
mkdir -p "$HOME/.pi/agent/logs"
LOCK="$HOME/.pi/agent/logs/harness-session.lock"
if [[ ! -e "$LOCK" ]]; then (umask 077; touch "$LOCK"); fi
# Shared leases also work inside the harness's read-only execution guard.
exec 8<"$LOCK"
flock --shared 8
# A killed updater releases its lock before recovery has necessarily run.
if [[ -f "$HOME/.pi/agent/logs/core-update-transaction.json" ]]; then
  echo 'Pi update recovery is pending. Run ~/.pi/agent/scripts/auto-update.sh --repair-only before starting Pi.' >&2
  exit 75
fi
exec "$NODE" "$ENTRY" "$@"
