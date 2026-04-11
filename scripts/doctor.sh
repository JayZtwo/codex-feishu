#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NODE_BIN="${CODEX_FEISHU_NODE_EXECUTABLE:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  echo "[FAIL] Node.js installed"
  echo ""
  echo "Install Node.js >= 20, then rerun this doctor command."
  exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/doctor.mjs"
