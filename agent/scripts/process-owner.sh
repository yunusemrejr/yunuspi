#!/bin/bash
# Process lifetime backstops for YunusPi (see extensions/lib/process-owner.ts).
#
#   process-owner.sh reap <record> <owner-pid> <owner-identity>
#     Waits until the owner process is gone, then stops every process group
#     the record lists whose leader identity still matches, and deletes the
#     record. Graceful shutdown normally stopped them already; this covers
#     SIGKILL, a closed terminal whose handlers never ran, or a hung teardown.
#
#   process-owner.sh guard <owner-dir> <grace-seconds> <command...>
#     Runs a shared local service for as long as any live YunusPi process
#     holds an owner record. After <grace-seconds> without one it stops the
#     service and exits 0, so systemd (Restart=on-failure) leaves it down
#     until the next session starts it again. A crash exits non-zero.
#
# Identity is the start time from /proc/<pid>/stat, so a recycled pid never
# counts as the original owner or group leader. Without /proc (macOS) only
# liveness is checked.

ident() {
  local stat
  read -r stat < "/proc/$1/stat" 2>/dev/null || return 1
  stat=${stat##*) }
  set -- $stat
  printf '%s' "${20}"
}

alive() {
  kill -0 "$1" 2>/dev/null || return 1
  [ -z "$2" ] || [ ! -d /proc/self ] || [ "$(ident "$1")" = "$2" ]
}

numeric() { case $1 in ''|*[!0-9]*) return 1;; esac; }

reap() {
  local record=$1 owner=$2 identity=$3 pgid id live=()
  while alive "$owner" "$identity" && [ -f "$record" ]; do sleep 2; done
  [ -f "$record" ] || exit 0
  {
    read -r _
    while read -r pgid id; do
      numeric "$pgid" && alive "$pgid" "$id" && live+=("$pgid")
    done
  } < "$record"
  for pgid in "${live[@]}"; do kill -TERM -- "-$pgid" 2>/dev/null; done
  if [ ${#live[@]} -gt 0 ]; then
    sleep 2
    for pgid in "${live[@]}"; do kill -KILL -- "-$pgid" 2>/dev/null; done
  fi
  rm -f -- "$record"
}

held() {
  local record pid id
  for record in "$1"/*; do
    [ -f "$record" ] || continue
    pid=${record##*/}
    numeric "$pid" || continue
    read -r id < "$record" 2>/dev/null || id=
    alive "$pid" "$id" && return 0
  done
  return 1
}

guard() {
  local dir=$1 grace=$2 idle=0 tick=${PI_OWNER_GUARD_TICK:-15} child
  shift 2
  "$@" &
  child=$!
  trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0' TERM INT HUP
  while kill -0 "$child" 2>/dev/null; do
    sleep "$tick" & wait $!
    if held "$dir"; then idle=0; else idle=$((idle + tick)); fi
    if [ "$idle" -ge "$grace" ]; then
      kill -TERM "$child" 2>/dev/null
      wait "$child"
      exit 0
    fi
  done
  wait "$child"
}

mode=$1
shift
case $mode in
  reap) reap "$@" ;;
  guard) guard "$@" ;;
  *) echo "usage: process-owner.sh reap|guard ..." >&2; exit 2 ;;
esac
