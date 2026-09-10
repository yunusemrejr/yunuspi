#!/usr/bin/env bash
# Dedicated local maintenance; no npm update, inference, or shell profiles.
set -euo pipefail
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ ! -x "$candidate" ] || NODE="$candidate"
  done
fi
[ -n "$NODE" ] || {
  echo 'Cleanup skipped: node unavailable' >&2
  exit 1
}
mkdir -p "$HOME/.pi/agent/logs"
# Cooperates with updates and other cleaners. A held lock means try next time.
exec flock -n -E 0 "$HOME/.pi/agent/logs/harness-update.lock" "$NODE" "$HOME/.pi/agent/scripts/cleanup-harness.mjs" --apply
