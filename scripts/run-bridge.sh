#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_HOME="${CODEX_FEISHU_HOME:-$HOME/.codex-feishu}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH="/Applications/Codex.app/Contents/Resources:$PATH"

mkdir -p "$BRIDGE_HOME/data/messages" "$BRIDGE_HOME/logs" "$BRIDGE_HOME/runtime"

if [ -f "$BRIDGE_HOME/config.env" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$BRIDGE_HOME/config.env"
  set +a
fi

cd "$SKILL_DIR"
NODE_BIN="${CODEX_FEISHU_NODE_EXECUTABLE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "node executable not found. Set CODEX_FEISHU_NODE_EXECUTABLE if Node.js is installed in a non-standard location." >&2
  exit 127
fi

if [ -z "${CODEX_FEISHU_CODEX_EXECUTABLE:-}" ]; then
  CODEX_BIN="$(command -v codex || true)"
  if [ -n "$CODEX_BIN" ]; then
    export CODEX_FEISHU_CODEX_EXECUTABLE="$CODEX_BIN"
  fi
fi

exec "$NODE_BIN" "$SKILL_DIR/dist/daemon.mjs"
