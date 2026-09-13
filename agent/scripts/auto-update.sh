#!/usr/bin/env bash
# Auto-update pi core (extensions are local forks — no npm extension packages
# exist since the 2026-08-31 fork completion) + session-history retention —
# runs unattended. Patches are re-applied by verify-harness.mjs --fix after ANY
# update; a failed re-verify raises a desktop notification instead of silently
# leaving a broken harness.
#
# Runs via systemd user timer pi-auto-update.timer (Persistent=true — catches
# up after suspend/off, which the old cron entry never did because 06:23 was
# almost always before the laptop was on).

set -u

case "${1:-}" in
"" | --repair-only | --force) ;;
*)
  echo "Usage: auto-update.sh [--repair-only|--force]" >&2
  exit 2
  ;;
esac

# WHY pipefail: a pipeline's exit status must be the failing command's, not the
# last pipe stage's — `node ... | tail` reports tail's exit 0 even when the
# verifier failed, so upstream failures were masked as success.
set -o pipefail

# systemd user services get a minimal PATH that may lack nvm — resolve the node
# install that owns `pi` so npm/pi/node all resolve regardless of the caller.
# WHY both checks: `pi` can resolve through an unrelated PATH entry while
# `node` is missing (2026-08-30 run: pi/npm ran, then `node: command not found`
# in the verify step). node+pi+npm live in the same nvm bin dir, one loop covers all.
if ! command -v pi >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$d/pi" ] && [ -x "$d/node" ]; then
      export PATH="$d:$PATH"
      break
    fi
  done
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Canonical desktop-notification broker (dedup + aggregation + recovery
# policy). Replaced raw notify-send (2026-09-07): the 5-minute repair timer
# re-firing notify_fail on every failing verify pass turned one persistent
# defect into an identical popup every cycle. Broker failure falls back to a
# log-only ATTENTION line — never back to raw notify-send.
BROKER="$SCRIPT_DIR/notify-broker.mjs"

LOG="$HOME/.pi/agent/logs/auto-update.log"
mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo "== $(date -Is) auto-update start =="

# Same inherited lock as verify-harness, including direct --fix invocations.
exec 9>"$HOME/.pi/agent/logs/harness-update.lock" || exit 1
flock -w 120 -E 75 9 || {
  STATUS=$?
  echo "update/repair lock unavailable (exit $STATUS)"
  exit "$STATUS"
}
export PI_HARNESS_LOCK_HELD=1

# Launchers hold a shared lease for their lifetime. Take the exclusive lease
# before repairs, staging or recovery; a /proc scan alone races with startup.
exec 8>"$HOME/.pi/agent/logs/harness-session.lock" || exit 1
if flock -n -E 75 8; then
  export PI_HARNESS_SESSION_LOCK_HELD=1
else
  STATUS=$?
  if [ "$STATUS" = 75 ]; then
    echo "-- Pi update and repair deferred while sessions are active; current core retained"
    echo "== done (exit 0) =="
    exit 0
  fi
  echo "session lock unavailable (exit $STATUS)"
  exit "$STATUS"
fi

# Desktop notifications go through the broker's policy: one notification per
# distinct normalized root cause (fingerprint), silent occurrence counting on
# repeats, bounded aggregate reminders while still failing, one recovery note
# when a repeated failure resolves. The ATTENTION line is always logged.
notify_fail() { # notify_fail <op> <fingerprint> <message> [detail]
  local op="$1" fp="$2" msg="$3"
  node "$BROKER" emit --source auto-update --category updates --severity error \
    --op "$op" --fingerprint "$fp" --message "$msg" --detail "${4:-}" ||
    echo "ATTENTION(broker-unavailable): $msg"
  echo "ATTENTION: $msg"
}
# Ops that completed successfully this run; resolved through the broker at the
# end so a previously-notified failing op gets its recovery transition.
OK_OPS=()

# Accumulate failures so cleanup/log finalization still runs, but systemd gets
# an authoritative nonzero result instead of a false-success service state.
FAILURE=0

# --repair-only is a local periodic safety net for out-of-band core updates.
# No installs, retention, inference or network in that mode.
if [ "${1:-}" != --repair-only ]; then
  # --- pi core ---
  CORE_ARGS=(); if [ "${1:-}" = --force ]; then CORE_ARGS+=(--force); fi
  if node "$SCRIPT_DIR/core-update.mjs" "${CORE_ARGS[@]}"; then
    OK_OPS+=(npm-update)
  else
    UPDATE_STATUS=$?
    if [ "$UPDATE_STATUS" = 75 ]; then
      echo "-- Pi update and repair deferred while sessions are active; current core retained"
      echo "== done (exit 0) =="
      exit 0
    else
      FAILURE=1
      notify_fail npm-update "npm-update-failed" \
        "Staged Pi update failed or was rejected; inspect auto-update.log. Previous core is retained/restored when activation fails."
    fi
  fi

  # --- session history retention (2026-09-01) ---
  # Pi transcripts grow unbounded (~882MB as of 2026-09-01). Prune session files
  # older than PI_SESSION_RETENTION_DAYS (default 30). mtime-based: anything
  # touched recently survives.
  SESSION_RETENTION_DAYS="${PI_SESSION_RETENTION_DAYS:-30}"
  SESSIONS_DIR="$HOME/.pi/agent/sessions"
  if [[ ! "$SESSION_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
    FAILURE=1
    notify_fail session-retention "retention-invalid:$SESSION_RETENTION_DAYS" \
      "invalid PI_SESSION_RETENTION_DAYS='$SESSION_RETENTION_DAYS'; session pruning skipped"
  elif [ -d "$SESSIONS_DIR" ]; then
    BEFORE=$(du -sm "$SESSIONS_DIR" 2>/dev/null | cut -f1)
    RETENTION_OK=1
    if ! find "$SESSIONS_DIR" -type f -mtime +"$SESSION_RETENTION_DAYS" -delete; then
      FAILURE=1
      RETENTION_OK=0
      notify_fail session-retention "session-retention-failed" \
        "session file retention failed under $SESSIONS_DIR"
    fi
    if ! find "$SESSIONS_DIR" -mindepth 1 -type d -empty -delete; then
      FAILURE=1
      RETENTION_OK=0
      notify_fail session-retention "session-dir-cleanup-failed" \
        "empty session-directory cleanup failed under $SESSIONS_DIR"
    fi
    [ "${RETENTION_OK:-0}" = 1 ] && OK_OPS+=(session-retention)
    AFTER=$(du -sm "$SESSIONS_DIR" 2>/dev/null | cut -f1)
    echo "-- session retention: kept last ${SESSION_RETENTION_DAYS}d (${BEFORE:-?}MB -> ${AFTER:-?}MB)"
  else
    OK_OPS+=(session-retention)
  fi

fi
# Fork dependencies are exact-pinned and do not update here. Do not blanket-
# approve lifecycle scripts or rebuild native dependencies under live sessions.

if [ -f "$HOME/.pi/agent/logs/core-update-transaction.json" ]; then
  if ! node "$SCRIPT_DIR/core-update.mjs" --recover; then
    notify_fail verify "update-recovery-pending" "Interrupted Pi update recovery could not complete; preserve the transaction and inspect auto-update.log."
    echo "== done (exit 1) =="
    exit 1
  fi
fi

echo "-- post-update verification (re-applies node_modules patches) --"
# verify --fix exits 0 when the FINAL state is clean — successful repairs
# count as pass, so one call is the whole step (idempotent by design).
# WHY: capture output and branch on node's own exit code — a `node ... | tail`
# pipeline hands the verdict to tail, which always exits 0, so a failed verify
# was reported as "verification clean".
VERIFY_LOG=$(mktemp)
if node "$HOME/.pi/agent/scripts/verify-harness.mjs" --fix >"$VERIFY_LOG" 2>&1; then
  echo "-- verification clean (patches re-applied if wiped)"
  OK_OPS+=(verify)
else
  VERIFY_STATUS=$?
  if [ "$VERIFY_STATUS" = 75 ]; then
    echo "-- Pi repair deferred while sessions are active; current core retained"
    rm -f "$VERIFY_LOG"
    echo "== done (exit 0) =="
    exit 0
  fi
  FAILURE=1
  # Fingerprint the FAILING CHECKS, not the run: volatile absolute paths and
  # content hashes are stripped so the same root cause dedups across runs
  # (and across the 5-minute repair timer), while a materially different
  # failure is a new condition. Repeated polls of the same state stay silent
  # (one notification + bounded aggregate reminders; occurrences visible via
  # `notify-broker.mjs status`) — suppression never hides the state itself,
  # which stays inspectable here, in the log, and in broker status.
  VERIFY_CHECKS=$(grep '✗' "$VERIFY_LOG" | sed -E 's#(/home|/tmp)/[^ ]*##g; s/[0-9a-f]{10,}//g; s/^[[:space:]]*✗[[:space:]]*//' | sort)
  if [ -n "$VERIFY_CHECKS" ]; then
    VERIFY_FP="verify:$(printf '%s\n' "$VERIFY_CHECKS" | sha1sum | cut -c1-12)"
  else
    VERIFY_FP="verify:crash-exit-$VERIFY_STATUS"
  fi
  VERIFY_DETAIL=$(grep '✗' "$VERIFY_LOG" | sed -E 's/^[[:space:]]*//' | head -5 | tr '\n' '|')
  notify_fail verify "$VERIFY_FP" \
    "Post-update harness verification failed (exit $VERIFY_STATUS) — core retained, repairs pending. Run: node ~/.pi/agent/scripts/verify-harness.mjs" \
    "failing checks: ${VERIFY_DETAIL:-verifier exited before reporting}"
fi
# WHY tail once after the branch, not in both branches: the alert precedes
# the detail in the log, and one rm instead of two.
tail -30 "$VERIFY_LOG"
rm -f "$VERIFY_LOG"

# Ops that succeeded resolve their possibly-active failure states through the
# broker; a repeated notified failure that heals sends one recovery note.
if [ "${#OK_OPS[@]}" -gt 0 ]; then
  RESOLVE_ARGS=()
  for op in "${OK_OPS[@]}"; do RESOLVE_ARGS+=(--op "$op"); done
  node "$BROKER" resolve --source auto-update "${RESOLVE_ARGS[@]}" ||
    echo "ATTENTION(broker-unavailable): resolve failed"
fi

# Keep the log bounded regardless of how chatty updates get (~one screenful kept).
# Preserve the inode held by stdout/stderr so the completion record remains
# visible after trimming. The update lock serializes writers to this log.
tail -c 200000 "$LOG" >"$LOG.tmp" && cat "$LOG.tmp" >"$LOG"
rm -f "$LOG.tmp"
echo "== done (exit $FAILURE) =="
exit "$FAILURE"
