#!/usr/bin/env bash
set -euo pipefail

BRIDGE_HOME="${CODEX_FEISHU_HOME:-$HOME/.codex-feishu}"
CONFIG_FILE="$BRIDGE_HOME/config.env"
PID_FILE="$BRIDGE_HOME/runtime/bridge.pid"
LOG_FILE="$BRIDGE_HOME/logs/bridge.log"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "[OK]   $label"
    PASS=$((PASS + 1))
  else
    echo "[FAIL] $label"
    FAIL=$((FAIL + 1))
  fi
}

get_config() {
  grep "^$1=" "$CONFIG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//' || true
}

echo "Runtime: codex"
echo "Channel: feishu"
echo ""

if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VER" -ge 20 ] 2>/dev/null; then
    check "Node.js >= 20 (found $(node -v))" 0
  else
    check "Node.js >= 20 (found $(node -v))" 1
  fi
else
  check "Node.js installed" 1
fi

if command -v codex >/dev/null 2>&1; then
  CODEX_VER=$(codex --version 2>/dev/null || echo "unknown")
  check "Codex CLI available ($CODEX_VER)" 0
else
  check "Codex CLI available" 1
fi

if [ -n "${CODEX_FEISHU_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] || [ -n "${OPENAI_API_KEY:-}" ]; then
  check "Codex auth available (env)" 0
elif command -v codex >/dev/null 2>&1; then
  CODEX_AUTH_OUT=$(codex login status 2>&1 || codex auth status 2>&1 || true)
  if echo "$CODEX_AUTH_OUT" | grep -qiE 'logged.in|authenticated'; then
    check "Codex auth available (CLI login)" 0
  else
    check "Codex auth available (set OPENAI_API_KEY or run 'codex auth login')" 1
  fi
else
  check "Codex auth available" 1
fi

if [ -d "$SKILL_DIR/node_modules/@larksuiteoapi/node-sdk" ] && [ -d "$SKILL_DIR/node_modules/markdown-it" ]; then
  check "Bridge dependencies installed" 0
else
  check "Bridge dependencies installed (run 'npm install' in $SKILL_DIR)" 1
fi

DAEMON_MJS="$SKILL_DIR/dist/daemon.mjs"
if [ -f "$DAEMON_MJS" ]; then
  STALE_SRC=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$DAEMON_MJS" 2>/dev/null | head -1 || true)
  if [ -z "$STALE_SRC" ]; then
    check "dist/daemon.mjs is up to date" 0
  else
    check "dist/daemon.mjs is stale (run 'npm run build')" 1
  fi
else
  check "dist/daemon.mjs exists (run 'npm run build')" 1
fi

if [ -f "$CONFIG_FILE" ]; then
  check "config.env exists" 0
else
  check "config.env exists ($CONFIG_FILE not found)" 1
fi

if [ -f "$CONFIG_FILE" ]; then
  PERMS=$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")
  if [ "$PERMS" = "600" ]; then
    check "config.env permissions are 600" 0
  else
    check "config.env permissions are 600 (currently $PERMS)" 1
  fi
fi

if [ -f "$CONFIG_FILE" ]; then
  FS_APP_ID=$(get_config CODEX_FEISHU_APP_ID)
  FS_SECRET=$(get_config CODEX_FEISHU_APP_SECRET)
  FS_DOMAIN=$(get_config CODEX_FEISHU_DOMAIN)
  FS_DOMAIN="${FS_DOMAIN:-https://open.feishu.cn}"

  if [ -n "$FS_APP_ID" ] && [ -n "$FS_SECRET" ]; then
    if command -v curl >/dev/null 2>&1; then
      FEISHU_RESULT=$(curl -s --max-time 8 -X POST "${FS_DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"${FS_APP_ID}\",\"app_secret\":\"${FS_SECRET}\"}" 2>/dev/null || echo '{"code":1}')
      if echo "$FEISHU_RESULT" | grep -q '"code"[[:space:]]*:[[:space:]]*0'; then
        check "Feishu app credentials are valid" 0
      else
        check "Feishu app credentials are valid (token request failed)" 1
      fi
    else
      check "curl available for Feishu credential validation" 1
    fi
  else
    check "Feishu app credentials configured" 1
  fi
fi

LOG_DIR="$BRIDGE_HOME/logs"
if [ -d "$LOG_DIR" ] && [ -w "$LOG_DIR" ]; then
  check "Log directory is writable" 0
else
  check "Log directory is writable ($LOG_DIR)" 1
fi

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    check "PID file consistent (process $PID is running)" 0
  else
    check "PID file consistent (stale PID $PID, process not running)" 1
  fi
else
  check "PID file consistency (no PID file, OK)" 0
fi

if [ -f "$LOG_FILE" ]; then
  ERROR_COUNT=$(tail -50 "$LOG_FILE" | grep -ciE 'ERROR|Fatal|uncaughtException|unhandledRejection' || true)
  if [ "$ERROR_COUNT" -eq 0 ]; then
    check "No recent errors in log (last 50 lines)" 0
  else
    check "No recent errors in log (found $ERROR_COUNT error lines)" 1
  fi
else
  check "Log file exists (not yet created)" 0
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Common fixes:"
  echo "  Missing dependencies → cd $SKILL_DIR && npm install"
  echo "  Stale bundle         → cd $SKILL_DIR && npm run build"
  echo "  Missing config       → copy config.env.example to ~/.codex-feishu/config.env"
  echo "  Bad login            → run 'codex auth login'"
  echo "  Stale PID file       → bash \"$SKILL_DIR/scripts/daemon.sh\" stop"
fi

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
