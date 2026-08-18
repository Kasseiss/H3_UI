#!/usr/bin/env bash
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$PROJECT_DIR/.h3.env" ]; then
  set -a
  # This file is generated locally by install.sh and contains only H3 settings.
  . "$PROJECT_DIR/.h3.env"
  set +a
fi

LOG_ROOT=${H3_LOG_ROOT:-"$PROJECT_DIR/logs"}
DATA_ROOT=${H3_DATA_ROOT:-"$PROJECT_DIR/data"}
STORAGE_ROOT=${H3_STORAGE_ROOT:-"$PROJECT_DIR/server-storage"}
mkdir -p "$LOG_ROOT" "$DATA_ROOT" "$STORAGE_ROOT"

child_pid=''
stopping=0

stop_child() {
  stopping=1
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
}

trap stop_child INT TERM

while [ "$stopping" -eq 0 ]; do
  node "$PROJECT_DIR/server.mjs" >>"$LOG_ROOT/h3-supervisor.log" 2>&1 &
  child_pid=$!
  wait "$child_pid" || exit_code=$?
  child_pid=''
  [ "$stopping" -eq 1 ] && break
  printf '%s H3 exited (%s), restarting in 3 seconds\n' "$(date -Iseconds)" "${exit_code:-0}" >>"$LOG_ROOT/h3-supervisor.log"
  sleep 3
done
