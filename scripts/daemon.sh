#!/usr/bin/env bash
set -euo pipefail

BRIDGE_HOME="${CODEX_FEISHU_HOME:-$HOME/.codex-feishu}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$BRIDGE_HOME/runtime/bridge.pid"
STATUS_FILE="$BRIDGE_HOME/runtime/status.json"
LOG_FILE="$BRIDGE_HOME/logs/bridge.log"
DAEMON_FILE="$SKILL_DIR/dist/daemon.mjs"
LAUNCHD_LABEL="com.codex-feishu.bridge"
LAUNCHD_PLIST="$BRIDGE_HOME/runtime/$LAUNCHD_LABEL.plist"

ensure_dirs() {
  mkdir -p "$BRIDGE_HOME/data/messages" "$BRIDGE_HOME/logs" "$BRIDGE_HOME/runtime"
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true
}

pid_alive() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

ensure_built() {
  local need_build=0
  if [ ! -f "$DAEMON_FILE" ]; then
    need_build=1
  else
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_FILE" 2>/dev/null | head -1 || true)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
  fi

  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

load_config_env() {
  if [ -f "$BRIDGE_HOME/config.env" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$BRIDGE_HOME/config.env"
    set +a
  fi
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

is_macos() {
  [ "$(uname -s)" = "Darwin" ]
}

launchd_target() {
  echo "gui/$(id -u)/$LAUNCHD_LABEL"
}

launchd_write_plist() {
  cat >"$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$SKILL_DIR/scripts/run-bridge.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_FEISHU_HOME</key>
    <string>$BRIDGE_HOME</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$SKILL_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$LOG_FILE</string>
</dict>
</plist>
EOF
}

launchd_is_loaded() {
  launchctl print "$(launchd_target)" >/dev/null 2>&1
}

launchd_pid() {
  launchctl print "$(launchd_target)" 2>/dev/null | awk '/pid = / { print $3; exit }'
}

start_bridge() {
  ensure_dirs
  ensure_built

  local pid
  pid=$(read_pid)
  if is_macos && launchd_is_loaded; then
    local existing_pid
    existing_pid=$(launchd_pid || true)
    echo "Bridge already running${existing_pid:+ (PID: $existing_pid)}"
    [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE"
    exit 1
  fi
  if ! is_macos && pid_alive "$pid"; then
    echo "Bridge already running (PID: $pid)"
    [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE"
    exit 1
  fi

  rm -f "$PID_FILE"
  rm -f "$STATUS_FILE"
  load_config_env

  echo "Starting bridge..."
  local new_pid=""
  if is_macos; then
    launchd_write_plist
    launchctl bootout "gui/$(id -u)" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST"
    launchctl kickstart -k "$(launchd_target)"
  else
    nohup node "$DAEMON_FILE" >>"$LOG_FILE" 2>&1 &
    new_pid=$!
    echo "$new_pid" >"$PID_FILE"
  fi

  local started=0
  for _ in $(seq 1 12); do
    sleep 1
    if status_running; then
      started=1
      break
    fi
    if is_macos; then
      if ! launchd_is_loaded; then
        break
      fi
    elif ! pid_alive "$new_pid"; then
      break
    fi
  done

  if [ "$started" = "1" ]; then
    if is_macos; then
      new_pid=$(read_pid)
      if [ -z "$new_pid" ]; then
        new_pid=$(launchd_pid || true)
      fi
      [ -n "$new_pid" ] && echo "$new_pid" >"$PID_FILE"
    fi
    echo "Bridge started (PID: $new_pid)"
    cat "$STATUS_FILE"
    exit 0
  fi

  echo "Failed to start bridge."
  if is_macos; then
    if ! launchd_is_loaded; then
      echo "launchd service failed to stay loaded."
    fi
  elif ! pid_alive "$new_pid"; then
    echo "Process exited during startup."
  fi
  show_last_exit_reason
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

stop_bridge() {
  local pid
  pid=$(read_pid)
  if [ -z "$pid" ]; then
    if is_macos && launchd_is_loaded; then
      pid="$(launchd_pid || true)"
    else
      echo "No bridge running"
      exit 0
    fi
  fi

  if is_macos; then
    echo "Stopping bridge${pid:+ (PID: $pid)}..."
    launchctl bootout "gui/$(id -u)" "$LAUNCHD_PLIST" >/dev/null 2>&1 || launchctl bootout "$(launchd_target)" >/dev/null 2>&1 || true
  elif pid_alive "$pid"; then
    echo "Stopping bridge (PID: $pid)..."
    kill "$pid"
    for _ in $(seq 1 10); do
      if ! pid_alive "$pid"; then
        break
      fi
      sleep 1
    done
    if pid_alive "$pid"; then
      kill -9 "$pid"
    fi
  else
    echo "Bridge was not running (stale PID file)"
  fi

  rm -f "$PID_FILE"
  echo "Bridge stopped"
}

show_status() {
  local pid
  pid=$(read_pid)
  if is_macos && launchd_is_loaded; then
    pid=$(launchd_pid || true)
    echo "Bridge is registered with launchd ($LAUNCHD_LABEL)"
    [ -n "$pid" ] && echo "Bridge process is running (PID: $pid)"
  elif pid_alive "$pid"; then
    echo "Bridge process is running (PID: $pid)"
  else
    echo "Bridge is not running"
    [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
  fi

  if [ -f "$STATUS_FILE" ]; then
    cat "$STATUS_FILE"
  else
    show_last_exit_reason
  fi
}

show_logs() {
  local lines="${1:-50}"
  tail -n "$lines" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["'"'"']?\s*[:=]\s*["'"'"']?)[^ "]+/\1\2*****/gi'
}

case "${1:-help}" in
  start)
    start_bridge
    ;;
  stop)
    stop_bridge
    ;;
  status)
    show_status
    ;;
  logs)
    show_logs "${2:-50}"
    ;;
  *)
    echo "Usage: daemon.sh {start|stop|status|logs [N]}"
    exit 1
    ;;
esac
