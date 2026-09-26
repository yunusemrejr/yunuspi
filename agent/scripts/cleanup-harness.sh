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
# Share the launcher's installation lease so updates cannot move our state
# during cleanup. The second lock serializes cleaners; active sessions may run.
exec flock --shared -n -E 0 "$HOME/.pi/agent/logs/harness-session.lock" \
  flock -n -E 0 "$HOME/.pi/agent/logs/harness-update.lock" \
  "$NODE" "$HOME/.pi/agent/scripts/cleanup-harness.mjs" --apply
