#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

if [ -f "$PROJECT_DIR/.h3.env" ]; then
  set -a
  . "$PROJECT_DIR/.h3.env"
  set +a
fi

DATA_ROOT=${H3_DATA_ROOT:-"$PROJECT_DIR/data"}
LOG_ROOT=${H3_LOG_ROOT:-"$PROJECT_DIR/logs"}
PID_FILE="$DATA_ROOT/h3-supervisor.pid"
mkdir -p "$DATA_ROOT" "$LOG_ROOT"

systemd_ready() {
  [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemctl cat h3-studio.service >/dev/null 2>&1
}

fallback_running() {
  [ -f "$PID_FILE" ] || return 1
  pid=$(sed -n '1p' "$PID_FILE")
  case "$pid" in *[!0-9]*|'') return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  command_line=$(ps -p "$pid" -o args= 2>/dev/null || true)
  case "$command_line" in *h3-supervisor.sh*) return 0 ;; *) return 1 ;; esac
}

start_fallback() {
  if fallback_running; then
    printf 'H3 已在运行，PID %s\n' "$(sed -n '1p' "$PID_FILE")"
    return
  fi
  nohup "$SCRIPT_DIR/h3-supervisor.sh" >>"$LOG_ROOT/h3-supervisor-launch.log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  sleep 1
  if ! fallback_running; then
    printf 'H3 启动失败，请查看 %s\n' "$LOG_ROOT/h3-supervisor-launch.log" >&2
    exit 1
  fi
  printf 'H3 已启动，PID %s\n' "$pid"
}

stop_fallback() {
  if ! fallback_running; then
    rm -f "$PID_FILE"
    printf 'H3 当前没有运行\n'
    return
  fi
  pid=$(sed -n '1p' "$PID_FILE")
  kill -TERM "$pid"
  count=0
  while kill -0 "$pid" 2>/dev/null && [ "$count" -lt 15 ]; do sleep 1; count=$((count + 1)); done
  rm -f "$PID_FILE"
  printf 'H3 已停止\n'
}

action=${1:-status}
case "$action" in
  start)
    if systemd_ready; then systemctl start h3-studio.service; else start_fallback; fi
    ;;
  stop)
    if systemd_ready; then systemctl stop h3-studio.service; else stop_fallback; fi
    ;;
  restart)
    if systemd_ready; then systemctl restart h3-studio.service; else stop_fallback; start_fallback; fi
    ;;
  status)
    if systemd_ready; then systemctl status h3-studio.service --no-pager -l
    elif fallback_running; then printf 'H3 正在运行，PID %s\n' "$(sed -n '1p' "$PID_FILE")"
    else printf 'H3 未运行\n'; exit 1; fi
    ;;
  logs)
    tail -n 120 -f "$LOG_ROOT/h3-supervisor.log"
    ;;
  *) printf '用法：%s {start|stop|restart|status|logs}\n' "$0" >&2; exit 2 ;;
esac
